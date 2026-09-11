import { describe, expect, it, vi } from "vitest";
import { PlanSchema, type Plan } from "@trinker/core";
import {
  applyProposal, buildCompilerContext, COMPILER_PROMPT_VERSION, COMPILER_SYSTEM_PROMPT,
  createOpenAiProvider, DEFAULT_OPENAI_MODEL, normaliseOpenAiProposal, OPENAI_PLAN_PROPOSAL_SCHEMA,
  OPENAI_WIRE_INSTRUCTIONS, ProviderError, type ResponsesClient,
} from "../src/index.js";

const ROUTE = "route_get_orders_11111111";
const ORACLES = ["differential-authorization", "state-mutation", "metamorphic-response"];

const plan = (): Plan => PlanSchema.parse({
  schemaVersion: 1, planId: "trkp_example", surfaceDigest: `sha256:${"a".repeat(64)}`,
  target: { applicationId: "shop", allowedTargetRefs: ["local"] },
  surface: {
    frameworks: ["express"],
    routes: [{ id: ROUTE, method: "GET", pathTemplate: "/orders/:id", parameters: [{ name: "id", location: "path", required: true }], sourceRefs: [], confidence: "high" }],
    resources: [{ id: "resource_order", name: "order", routeParameter: "id", routeIds: [ROUTE], sourceRefs: [] }],
  },
  identities: [], fixtures: [], invariants: [], checks: [],
  coverage: { inScopeRouteIds: [ROUTE], exclusions: [] },
  safety: { mutationPolicy: "forbid", allowedMethods: ["GET"] },
  provenance: { sources: [], compiler: { mode: "deterministic", compilerVersion: "0.1.0" } },
});

const context = async () => buildCompilerContext({ plan: plan(), availableOracles: ORACLES });

const client = (impl: (body: Record<string, unknown>) => unknown): ResponsesClient =>
  ({ responses: { create: async (body) => impl(body) as never } });

const reply = (text: string, usage = { input_tokens: 4200, output_tokens: 900, total_tokens: 5100 }) => ({
  status: "completed",
  output: [{ type: "message", content: [{ type: "output_text", text }] }],
  usage,
});

/** A proposal in OpenAI's wire encoding: every field present, optionals null, maps as arrays. */
const wireProposal = () => ({
  identities: [
    { id: "identity_owner", credentialRef: "owner", roles: ["user"], capabilities: [] },
    { id: "identity_peer", credentialRef: "peer", roles: ["user"], capabilities: [] },
  ],
  fixtures: [{ id: "fixture_order", runtimeRef: "order", resourceId: "resource_order", ownerIdentityId: "identity_owner" }],
  invariants: [{ id: "inv_owner", kind: "authorization", statement: "Only the owner may read an order.", routeIds: [ROUTE], resourceId: "resource_order" }],
  checks: [{
    id: "chk_owner", invariantId: "inv_owner", oracle: "differential-authorization",
    request: {
      routeId: ROUTE,
      pathBindings: [{ name: "id", literal: null, fixtureRef: "fixture_order", field: "id", runtimeRef: null }],
      queryBindings: [], headerBindings: [], bodyJson: null,
    },
    allowedIdentityIds: ["identity_owner"], deniedIdentityIds: ["identity_peer"], calibrationTrials: 3,
    readRequest: null, readIdentityId: null, unauthorizedIdentityIds: null, protectedPaths: null, stabilityReads: null,
    identityId: null, relation: null, variants: null,
  }],
  rationales: [{ checkId: "chk_owner", rationale: "Route takes an :id path parameter." }],
  notes: ["Skipped nothing."],
});

describe("openai provider construction", () => {
  it("refuses to construct without an API key, naming the variable", () => {
    expect(() => createOpenAiProvider({ apiKey: "" })).toThrow(ProviderError);
    expect(() => createOpenAiProvider({ apiKey: "" })).toThrow(/OPENAI_API_KEY/);
  });

  it("names the model it will use, so a compilation is attributable", () => {
    expect(createOpenAiProvider({ apiKey: "k" }).name).toBe(`openai:${DEFAULT_OPENAI_MODEL}`);
    expect(createOpenAiProvider({ apiKey: "k", model: "gpt-5.6-luna" }).name).toBe("openai:gpt-5.6-luna");
  });

  it("defaults to a cost-conscious model rather than the frontier one", () => {
    expect(DEFAULT_OPENAI_MODEL).toBe("gpt-5.6-terra");
  });
});

describe("openai request construction", () => {
  it("asks for strict structured output against the wire schema", async () => {
    let sent: Record<string, unknown> | undefined;
    const provider = createOpenAiProvider({ apiKey: "k", client: client((body) => { sent = body; return reply(JSON.stringify(wireProposal())); }) });
    await provider.propose(await context());

    expect(sent?.["model"]).toBe(DEFAULT_OPENAI_MODEL);
    const format = (sent?.["text"] as { format?: Record<string, unknown> })?.format;
    expect(format?.["type"]).toBe("json_schema");
    expect(format?.["strict"]).toBe(true);
    expect(format?.["name"]).toBe("plan_proposal");
    expect(format?.["schema"]).toBe(OPENAI_PLAN_PROPOSAL_SCHEMA);
  });

  it("reuses the shared system prompt and adds only the wire encoding rules", async () => {
    let sent: Record<string, unknown> | undefined;
    const provider = createOpenAiProvider({ apiKey: "k", client: client((body) => { sent = body; return reply(JSON.stringify(wireProposal())); }) });
    await provider.propose(await context());

    const input = sent?.["input"] as Array<{ role: string; content: string }>;
    expect(input[0]?.role).toBe("system");
    expect(input[0]?.content).toContain(COMPILER_SYSTEM_PROMPT);
    expect(input[0]?.content).toContain(OPENAI_WIRE_INSTRUCTIONS);
    expect(input[1]?.content).toContain(ROUTE);
  });

  it("never sends credentials or a target URL", async () => {
    let sent: Record<string, unknown> | undefined;
    const provider = createOpenAiProvider({ apiKey: "sk-proj-super-secret", client: client((body) => { sent = body; return reply(JSON.stringify(wireProposal())); }) });
    await provider.propose(await context());

    const serialised = JSON.stringify(sent);
    expect(serialised).not.toContain("sk-proj-super-secret");
    expect(serialised).not.toMatch(/localhost|http:\/\/|Bearer /);
  });

  it("records the model and a prompt version that names the wire encoding", async () => {
    const provider = createOpenAiProvider({ apiKey: "k", client: client(() => reply(JSON.stringify(wireProposal()))) });
    const response = await provider.propose(await context());
    expect(response.metadata?.model).toBe(DEFAULT_OPENAI_MODEL);
    expect(response.metadata?.promptVersion).toBe(`${COMPILER_PROMPT_VERSION}+openai-wire.1`);
  });

  it("rejects a request that is not a compiler context", async () => {
    const provider = createOpenAiProvider({ apiKey: "k", client: client(() => reply("{}")) });
    await expect(provider.propose({ routes: [], resources: [], availableOracles: [], allowedMethods: [], existing: { identities: [], fixtures: [], invariants: [], checks: [] } }))
      .rejects.toThrow(/buildCompilerContext/);
  });
});

describe("openai response handling", () => {
  it("extracts token usage exactly as reported", async () => {
    const provider = createOpenAiProvider({ apiKey: "k", client: client(() => reply(JSON.stringify(wireProposal()))) });
    expect((await provider.propose(await context())).usage).toEqual({ input: 4200, output: 900, calls: 1 });
  });

  it("reads output_text when the SDK exposes that shape instead", async () => {
    const provider = createOpenAiProvider({
      apiKey: "k",
      client: client(() => ({ status: "completed", output_text: JSON.stringify(wireProposal()), usage: { input_tokens: 10, output_tokens: 5 } })),
    });
    expect((await provider.propose(await context())).usage).toEqual({ input: 10, output: 5, calls: 1 });
  });

  it("fails loudly on prose rather than scraping checks out of it", async () => {
    const provider = createOpenAiProvider({ apiKey: "k", client: client(() => reply("The /orders/:id route looks like an IDOR.")) });
    await expect(provider.propose(await context())).rejects.toThrow(/did not return valid JSON/);
  });

  it("reports a truncated response instead of returning a partial plan", async () => {
    const provider = createOpenAiProvider({
      apiKey: "k",
      client: client(() => ({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [], usage: {} })),
    });
    await expect(provider.propose(await context())).rejects.toThrow(/stopped before finishing.*max_output_tokens/s);
  });

  it("fails on an empty response", async () => {
    const provider = createOpenAiProvider({ apiKey: "k", client: client(() => ({ status: "completed", output: [], usage: {} })) });
    await expect(provider.propose(await context())).rejects.toThrow(/returned no proposal text/);
  });

  it("treats missing usage as zero rather than crashing", async () => {
    const provider = createOpenAiProvider({ apiKey: "k", client: client(() => ({ status: "completed", output_text: JSON.stringify(wireProposal()) })) });
    expect((await provider.propose(await context())).usage).toEqual({ input: 0, output: 0, calls: 1 });
  });
});

describe("openai error handling", () => {
  const failing = (error: unknown) => createOpenAiProvider({ apiKey: "sk-proj-super-secret", client: client(() => { throw error; }) });

  it.each([
    [401, /rejected the credentials/],
    [403, /rejected the credentials/],
    [404, /does not recognise that model/],
    [429, /Rate limited or out of quota/],
    [400, /rejected the request \(HTTP 400\)/],
    [503, /unavailable \(HTTP 503\)/],
  ])("explains HTTP %s usefully", async (status, expected) => {
    await expect(failing(Object.assign(new Error("upstream detail"), { status })).propose(await context())).rejects.toThrow(expected);
  });

  it("recognises a timeout", async () => {
    await expect(failing(new Error("Request timed out.")).propose(await context())).rejects.toThrow(/timed out/);
  });

  it("redacts the API key even when the upstream error quotes it back", async () => {
    const error = Object.assign(new Error("401 from Authorization: Bearer sk-proj-super-secret"), { status: 400 });
    try {
      await failing(error).propose(await context());
      throw new Error("should have thrown");
    } catch (caught) {
      expect((caught as Error).message).not.toContain("sk-proj-super-secret");
      expect((caught as Error).message).toContain("[REDACTED]");
    }
  });
});

describe("openai cost estimation", () => {
  it("estimates from the real prompt without calling the provider", async () => {
    const create = vi.fn();
    const provider = createOpenAiProvider({ apiKey: "k", maxOutputTokens: 1000, client: { responses: { create } } as never });
    const estimate = provider.estimate?.(await context()) ?? 0;
    expect(estimate).toBeGreaterThan(1000);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("wire normalisation", () => {
  it("produces a proposal the deterministic layer accepts", () => {
    const normalised = normaliseOpenAiProposal(wireProposal());
    const result = applyProposal(plan(), normalised, { availableOracles: ORACLES });
    expect(result.added.checks).toEqual(["chk_owner"]);
    expect(result.rationales["chk_owner"]).toMatch(/:id path parameter/);
  });

  it("rebuilds binding maps from the array encoding", () => {
    const normalised = normaliseOpenAiProposal(wireProposal()) as { checks: Array<{ request: { pathBindings: unknown } }> };
    expect(normalised.checks[0]?.request.pathBindings).toEqual({ id: { fixtureRef: "fixture_order", field: "id" } });
  });

  it("strips nulls so a strict schema does not leak them into the plan schema", () => {
    const wire = wireProposal();
    const normalised = normaliseOpenAiProposal(wire) as { checks: Array<Record<string, unknown>> };
    expect(normalised.checks[0]).not.toHaveProperty("readRequest");
    expect(normalised.checks[0]).not.toHaveProperty("variants");
    expect(normalised.checks[0]).not.toHaveProperty("relation");
  });

  it("parses a JSON body string into a real body", () => {
    const wire = wireProposal();
    (wire.checks[0]!.request as Record<string, unknown>)["bodyJson"] = '{"ownerId":"peer"}';
    const normalised = normaliseOpenAiProposal(wire) as { checks: Array<{ request: { body?: unknown } }> };
    expect(normalised.checks[0]?.request.body).toEqual({ ownerId: "peer" });
  });

  it("normalises a state-mutation check into its canonical shape", () => {
    const wire = wireProposal();
    wire.checks[0] = {
      ...wire.checks[0]!,
      id: "chk_write", oracle: "state-mutation",
      allowedIdentityIds: null, deniedIdentityIds: null, calibrationTrials: null,
      readRequest: { routeId: ROUTE, pathBindings: [], queryBindings: [], headerBindings: [], bodyJson: null },
      readIdentityId: "identity_owner", unauthorizedIdentityIds: ["identity_peer"],
      protectedPaths: ["data.ownerId"], stabilityReads: 2,
    } as never;
    const normalised = normaliseOpenAiProposal(wire) as { checks: Array<Record<string, unknown>> };
    expect(normalised.checks[0]).toMatchObject({
      oracle: "state-mutation", readIdentityId: "identity_owner",
      protectedPaths: ["data.ownerId"], calibration: { stabilityReads: 2 },
    });
    expect(normalised.checks[0]).not.toHaveProperty("allowedIdentityIds");
  });

  it("stamps llm-assisted provenance on invariants regardless of what the model said", () => {
    const wire = wireProposal();
    (wire.invariants[0] as Record<string, unknown>)["provenance"] = "manual";
    const normalised = normaliseOpenAiProposal(wire) as { invariants: Array<{ provenance: string }> };
    expect(normalised.invariants[0]?.provenance).toBe("llm-assisted");
  });

  it("passes an unknown oracle through so the deterministic layer rejects it by name", () => {
    const wire = wireProposal();
    (wire.checks[0] as Record<string, unknown>)["oracle"] = "out-of-band";
    const result = applyProposal(plan(), normaliseOpenAiProposal(wire), { availableOracles: ORACLES });
    expect(result.added.checks).toEqual([]);
    expect(result.rejected[0]?.reason).toMatch(/has no implementation/);
  });

  it("does not repair a malformed proposal into something that validates", () => {
    expect(() => applyProposal(plan(), normaliseOpenAiProposal({ checks: [{ id: "chk_bad" }] }), { availableOracles: ORACLES }))
      .toThrow(/not a valid plan proposal/);
  });

  it("leaves a non-object response untouched so it fails validation", () => {
    expect(normaliseOpenAiProposal("prose")).toBe("prose");
  });
});
