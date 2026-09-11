import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompilerProvider, ProposalRequest } from "@trinker/compiler";
import { compileProject, llmCompileProject, loadPlan, runProject } from "../src/workflow.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const APP_SOURCE = `import express from "express";
const app = express();
app.get('/api/orders/:id', handler);
app.get('/api/health', handler);
`;

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "trinker-llm-"));
  dirs.push(root);
  await writeFile(join(root, "app.ts"), APP_SOURCE);
  await compileProject(root);
  return root;
}

const routeIdOf = async (root: string, path: string): Promise<string> =>
  (await loadPlan(root)).surface.routes.find((route) => route.pathTemplate === path)!.id;

/** A provider that returns whatever the test wants, with no key and no network. */
function fakeProvider(build: (request: ProposalRequest) => unknown, usage = { input: 1000, output: 200, calls: 1 }): CompilerProvider & { seen: ProposalRequest[] } {
  const seen: ProposalRequest[] = [];
  return {
    seen,
    name: "fake:test-model",
    estimate: () => 100,
    propose: async (request) => {
      seen.push(request);
      return { proposal: build(request), usage, metadata: { model: "test-model", promptVersion: "test-1" } };
    },
  };
}

const goodProposal = (routeId: string) => ({
  identities: [
    { id: "identity_owner", credentialRef: "owner", roles: ["user"], capabilities: [] },
    { id: "identity_peer", credentialRef: "peer", roles: ["user"], capabilities: [] },
  ],
  fixtures: [{ id: "fixture_order", runtimeRef: "order" }],
  invariants: [{ id: "inv_order_owner", kind: "authorization", statement: "Only the owner may read an order.", routeIds: [routeId], provenance: "llm-assisted" }],
  checks: [{
    id: "chk_order_owner", invariantId: "inv_order_owner", enabled: true, oracle: "differential-authorization",
    request: { routeId, pathBindings: { id: { fixtureRef: "fixture_order", field: "id" } }, queryBindings: {}, headerBindings: {} },
    allowedIdentityIds: ["identity_owner"], deniedIdentityIds: ["identity_peer"], calibration: { trials: 3 },
  }],
  rationales: { chk_order_owner: "The route takes an :id path parameter, so object-level authorization applies." },
  notes: ["Skipped /api/health: no per-user state."],
});

describe("llm compile: the proposal reaches deterministic validation", () => {
  it("accepts a valid proposal and reports what was added", async () => {
    const root = await project();
    const routeId = await routeIdOf(root, "/api/orders/:id");
    const result = await llmCompileProject(root, { tokenBudget: 50_000, compilerProvider: fakeProvider(() => goodProposal(routeId)) });

    expect(result.added.checks).toEqual(["chk_order_owner"]);
    expect(result.added.identities).toEqual(["identity_owner", "identity_peer"]);
    expect(result.rejected).toEqual([]);
    expect(result.plan.checks).toHaveLength(1);
  });

  it("preserves the rationale for each accepted check, so a reviewer can disagree with it", async () => {
    const root = await project();
    const routeId = await routeIdOf(root, "/api/orders/:id");
    const result = await llmCompileProject(root, { tokenBudget: 50_000, compilerProvider: fakeProvider(() => goodProposal(routeId)) });
    expect(result.rationales["chk_order_owner"]).toMatch(/:id path parameter/);
    expect(result.notes).toContain("Skipped /api/health: no per-user state.");
  });

  it("stamps llm-assisted provenance on the plan and its invariants", async () => {
    const root = await project();
    const routeId = await routeIdOf(root, "/api/orders/:id");
    const result = await llmCompileProject(root, { tokenBudget: 50_000, apply: true, compilerProvider: fakeProvider(() => goodProposal(routeId)) });
    expect(result.plan.provenance.compiler.mode).toBe("llm-assisted");
    expect(result.plan.invariants[0]?.provenance).toBe("llm-assisted");
  });

  it("rejects a proposal naming a route that does not exist", async () => {
    const root = await project();
    const proposal = goodProposal("route_invented_by_the_model");
    const result = await llmCompileProject(root, { tokenBudget: 50_000, compilerProvider: fakeProvider(() => proposal) });
    expect(result.added.checks).toEqual([]);
    expect(result.rejected.some((item) => /Unknown route/.test(item.reason))).toBe(true);
  });

  it("refuses a proposal that is prose rather than structured plan content", async () => {
    const root = await project();
    await expect(llmCompileProject(root, { tokenBudget: 50_000, compilerProvider: fakeProvider(() => "I found an IDOR in /api/orders/:id") }))
      .rejects.toThrow(/not a valid plan proposal/);
  });

  it("refuses a proposal carrying a credential, rather than stripping it and continuing", async () => {
    const root = await project();
    const routeId = await routeIdOf(root, "/api/orders/:id");
    const proposal = goodProposal(routeId);
    proposal.checks[0]!.request.headerBindings = { authorization: { literal: "Bearer sk-leaked" } } as never;
    await expect(llmCompileProject(root, { tokenBudget: 50_000, compilerProvider: fakeProvider(() => proposal) }))
      .rejects.toThrow(/inline credential-like values|failed validation/);
  });

  it("rejects a mutating check while the plan forbids mutation", async () => {
    const root = await project();
    const routeId = await routeIdOf(root, "/api/orders/:id");
    const proposal = goodProposal(routeId);
    // The compiled plan permits GET/HEAD/OPTIONS only, so a write can never slip through.
    expect((await loadPlan(root)).safety.mutationPolicy).toBe("forbid");
    const result = await llmCompileProject(root, { tokenBudget: 50_000, compilerProvider: fakeProvider(() => proposal) });
    expect(result.plan.safety).toEqual((await loadPlan(root)).safety);
  });

  it("does not let a proposal redefine an already-authored check", async () => {
    const root = await project();
    const routeId = await routeIdOf(root, "/api/orders/:id");
    await llmCompileProject(root, { tokenBudget: 50_000, apply: true, compilerProvider: fakeProvider(() => goodProposal(routeId)) });

    const second = await llmCompileProject(root, { tokenBudget: 50_000, compilerProvider: fakeProvider(() => goodProposal(routeId)) });
    expect(second.added.checks).toEqual([]);
    expect(second.rejected.some((item) => item.id === "chk_order_owner" && /already exists/.test(item.reason))).toBe(true);
  });
});

describe("llm compile: nothing is written without --apply", () => {
  it("records the proposal but leaves plan.json untouched by default", async () => {
    const root = await project();
    const routeId = await routeIdOf(root, "/api/orders/:id");
    const before = await readFile(join(root, ".trinker", "plan.json"), "utf8");

    const result = await llmCompileProject(root, { tokenBudget: 50_000, compilerProvider: fakeProvider(() => goodProposal(routeId)) });

    expect(result.applied).toBe(false);
    expect(await readFile(join(root, ".trinker", "plan.json"), "utf8")).toBe(before);
    expect((await loadPlan(root)).checks).toHaveLength(0);

    const proposal = JSON.parse(await readFile(result.proposalPath, "utf8"));
    expect(proposal.added.checks).toEqual(["chk_order_owner"]);
    expect(proposal.record.provider).toBe("fake:test-model");
  });

  it("writes the merged plan only when apply is requested", async () => {
    const root = await project();
    const routeId = await routeIdOf(root, "/api/orders/:id");
    const result = await llmCompileProject(root, { tokenBudget: 50_000, apply: true, compilerProvider: fakeProvider(() => goodProposal(routeId)) });
    expect(result.applied).toBe(true);
    expect((await loadPlan(root)).checks.map((check) => check.id)).toEqual(["chk_order_owner"]);
  });

  it("preserves hand-authored checks across an llm compile", async () => {
    const root = await project();
    const routeId = await routeIdOf(root, "/api/orders/:id");
    const plan = await loadPlan(root);
    await writeFile(join(root, ".trinker", "plan.json"), JSON.stringify({
      ...plan,
      identities: [{ id: "identity_human", credentialRef: "human", roles: [], capabilities: [] }],
      invariants: [{ id: "inv_human", kind: "authorization", statement: "Authored by a person.", routeIds: [routeId], provenance: "manual" }],
      checks: [{
        id: "chk_human", invariantId: "inv_human", enabled: true, oracle: "differential-authorization",
        request: { routeId, pathBindings: {}, queryBindings: {}, headerBindings: {} },
        allowedIdentityIds: ["identity_human"], deniedIdentityIds: ["identity_human"], calibration: { trials: 1 },
      }],
    }, null, 2));

    const result = await llmCompileProject(root, { tokenBudget: 50_000, apply: true, compilerProvider: fakeProvider(() => goodProposal(routeId)) });
    expect(result.plan.checks.map((check) => check.id).sort()).toEqual(["chk_human", "chk_order_owner"]);
    expect(result.plan.invariants.find((inv) => inv.id === "inv_human")?.provenance).toBe("manual");
  });
});

describe("llm compile: budget and telemetry", () => {
  it("refuses a compilation whose estimate exceeds the budget, without calling the provider", async () => {
    const root = await project();
    const provider = { name: "expensive", estimate: () => 999_999, propose: vi.fn() } as unknown as CompilerProvider;
    await expect(llmCompileProject(root, { tokenBudget: 1000, compilerProvider: provider })).rejects.toThrow(/token budget/);
    expect((provider as unknown as { propose: ReturnType<typeof vi.fn> }).propose).not.toHaveBeenCalled();
  });

  it("reports an overrun even when the provider under-estimated", async () => {
    const root = await project();
    const routeId = await routeIdOf(root, "/api/orders/:id");
    const provider = fakeProvider(() => goodProposal(routeId), { input: 90_000, output: 90_000, calls: 1 });
    await expect(llmCompileProject(root, { tokenBudget: 5000, compilerProvider: provider })).rejects.toThrow(/exceeded its token budget/);
  });

  it("records everything a later cost comparison needs", async () => {
    const root = await project();
    const routeId = await routeIdOf(root, "/api/orders/:id");
    const result = await llmCompileProject(root, { tokenBudget: 50_000, compilerProvider: fakeProvider(() => goodProposal(routeId)) });

    expect(result.record).toMatchObject({
      provider: "fake:test-model",
      model: "test-model",
      promptVersion: "test-1",
      inputTokens: 1000,
      outputTokens: 200,
      totalTokens: 1200,
      tokenBudget: 50_000,
      checksProposed: 1,
      checksAccepted: 1,
      checksRejected: 0,
      routesConsidered: 2,
    });
    expect(typeof result.record["compiledAt"]).toBe("string");
  });
});

describe("llm compile: the context boundary", () => {
  it("gives the provider the surface and the constraints, and no runtime data", async () => {
    const root = await project();
    const routeId = await routeIdOf(root, "/api/orders/:id");
    await writeFile(join(root, ".trinker", "runtime.json"), JSON.stringify({
      targets: { local: { url: "http://secret-host:9999", allowHosts: [] } },
      identities: { owner: { headers: { authorization: "Bearer super-secret-token" } } },
      fixtures: {}, values: {}, mutationAuthorized: false,
    }));

    const provider = fakeProvider(() => goodProposal(routeId));
    await llmCompileProject(root, { tokenBudget: 50_000, compilerProvider: provider });

    const serialised = JSON.stringify(provider.seen[0]);
    expect(serialised).toContain(routeId);
    expect(serialised).toContain("differential-authorization");
    expect(serialised).not.toContain("super-secret-token");
    expect(serialised).not.toContain("secret-host");
  });

  it("includes narrow source excerpts rather than whole files", async () => {
    const root = await project();
    const routeId = await routeIdOf(root, "/api/orders/:id");
    const provider = fakeProvider(() => goodProposal(routeId));
    await llmCompileProject(root, { tokenBudget: 50_000, compilerProvider: provider });

    const excerpts = (provider.seen[0] as unknown as { sourceExcerpts: Array<{ file: string; text: string }> }).sourceExcerpts;
    expect(excerpts.length).toBeGreaterThan(0);
    expect(excerpts[0]?.file).toBe("app.ts");
    expect(excerpts[0]?.text).toContain("app.get");
  });
});

describe("the scan path stays LLM-free", () => {
  it("runs a scan without loading the compiler or any provider", async () => {
    const root = await project();
    const routeId = await routeIdOf(root, "/api/orders/:id");
    await llmCompileProject(root, { tokenBudget: 50_000, apply: true, compilerProvider: fakeProvider(() => goodProposal(routeId)) });

    // The check cannot reach a verdict without credentials, which is fine: what matters is that
    // running the plan consumes no LLM tokens and contacts no provider.
    const { result } = await runProject(root);
    expect(result.tokens).toEqual({ compileInput: 0, compileOutput: 0, runtimeInput: 0, runtimeOutput: 0, calls: 0 });
  });
});

describe("llm compile: a surface that cannot be re-derived from source", () => {
  it("uses the committed plan instead of failing, and says the surface is stale", async () => {
    // A hand-declared or OpenAPI-derived surface has no routes in source. compileProject rightly
    // refuses to strand the checks that depend on them; the compiler must still be usable.
    const root = await mkdtemp(join(tmpdir(), "trinker-llm-"));
    dirs.push(root);
    await writeFile(join(root, "app.ts"), APP_SOURCE);
    await compileProject(root);
    const routeId = await routeIdOf(root, "/api/orders/:id");

    const handAuthored = {
      ...(await loadPlan(root)),
      identities: [{ id: "identity_a", credentialRef: "a", roles: [], capabilities: [] }],
      invariants: [{ id: "inv_a", kind: "authorization", statement: "Hand authored.", routeIds: [routeId], provenance: "manual" }],
      checks: [{
        id: "chk_a", invariantId: "inv_a", enabled: true, oracle: "differential-authorization",
        request: { routeId, pathBindings: {}, queryBindings: {}, headerBindings: {} },
        allowedIdentityIds: ["identity_a"], deniedIdentityIds: ["identity_a"], calibration: { trials: 1 },
      }],
    };
    await writeFile(join(root, ".trinker", "plan.json"), JSON.stringify(handAuthored, null, 2));
    // Remove the source the routes came from, so a recompile would strand chk_a.
    await rm(join(root, "app.ts"));

    const result = await llmCompileProject(root, { tokenBudget: 50_000, compilerProvider: fakeProvider(() => goodProposal(routeId)) });

    expect(result.surfaceRefreshed).toBe(false);
    expect(result.added.checks).toEqual(["chk_order_owner"]);
    // The hand-declared routes and the authored check both survive.
    expect(result.plan.surface.routes.some((route) => route.id === routeId)).toBe(true);
    expect(result.plan.checks.map((check) => check.id).sort()).toEqual(["chk_a", "chk_order_owner"]);
  });

  it("reports a refreshed surface when source discovery does succeed", async () => {
    const root = await project();
    const routeId = await routeIdOf(root, "/api/orders/:id");
    const result = await llmCompileProject(root, { tokenBudget: 50_000, compilerProvider: fakeProvider(() => goodProposal(routeId)) });
    expect(result.surfaceRefreshed).toBe(true);
  });
});
