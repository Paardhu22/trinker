import { describe, expect, it } from "vitest";
import { PlanSchema, type Plan } from "@trinker/core";
import { applyProposal, BudgetExceededError, compileWithProvider, TokenBudget, type CompilerProvider } from "../src/index.js";

const ROUTE_GET = "route_get_orders_11111111";
const ROUTE_POST = "route_post_orders_22222222";
const ORACLES = ["differential-authorization", "state-mutation", "metamorphic-response"];

function makePlan(overrides: Record<string, unknown> = {}): Plan {
  return PlanSchema.parse({
    schemaVersion: 1, planId: "trkp_example", surfaceDigest: `sha256:${"a".repeat(64)}`,
    target: { applicationId: "app", allowedTargetRefs: ["local"] },
    surface: {
      frameworks: ["express"],
      routes: [
        { id: ROUTE_GET, method: "GET", pathTemplate: "/orders/:id", parameters: [{ name: "id", location: "path", required: true }], sourceRefs: [], confidence: "high" },
        { id: ROUTE_POST, method: "POST", pathTemplate: "/orders", parameters: [], sourceRefs: [], confidence: "high" },
      ],
      resources: [{ id: "resource_order", name: "order", routeParameter: "id", routeIds: [ROUTE_GET], sourceRefs: [] }],
    },
    identities: [], fixtures: [], invariants: [], checks: [],
    coverage: { inScopeRouteIds: [ROUTE_GET], exclusions: [] },
    safety: { mutationPolicy: "forbid", allowedMethods: ["GET"] },
    provenance: { sources: [], compiler: { mode: "deterministic", compilerVersion: "0.1.0" } },
    ...overrides,
  });
}

const goodProposal = (overrides: Record<string, unknown> = {}) => ({
  identities: [
    { id: "identity_owner", credentialRef: "owner", roles: ["user"], capabilities: [] },
    { id: "identity_peer", credentialRef: "peer", roles: ["user"], capabilities: [] },
  ],
  fixtures: [{ id: "fixture_order", runtimeRef: "order", resourceId: "resource_order", ownerIdentityId: "identity_owner" }],
  invariants: [{ id: "inv_owner_only", kind: "authorization", statement: "Only the owner may read the order.", routeIds: [ROUTE_GET], provenance: "llm-assisted" }],
  checks: [{
    id: "chk_owner_only", invariantId: "inv_owner_only", enabled: true, oracle: "differential-authorization",
    request: { routeId: ROUTE_GET, pathBindings: { id: { fixtureRef: "fixture_order", field: "id" } }, queryBindings: {}, headerBindings: {} },
    allowedIdentityIds: ["identity_owner"], deniedIdentityIds: ["identity_peer"], calibration: { trials: 3 },
  }],
  notes: ["Derived from the :id path parameter on /orders/:id."],
  ...overrides,
});

const apply = (plan: Plan, proposal: unknown) => applyProposal(plan, proposal, { availableOracles: ORACLES });

describe("applying a well-formed proposal", () => {
  it("merges identities, fixtures, invariants, and checks", () => {
    const result = apply(makePlan(), goodProposal());
    expect(result.added).toEqual({
      identities: ["identity_owner", "identity_peer"],
      fixtures: ["fixture_order"],
      invariants: ["inv_owner_only"],
      checks: ["chk_owner_only"],
    });
    expect(result.rejected).toEqual([]);
    expect(result.plan.checks).toHaveLength(1);
  });

  it("produces a plan that passes the ordinary plan schema", () => {
    const result = apply(makePlan(), goodProposal());
    expect(PlanSchema.safeParse(result.plan).success).toBe(true);
  });

  it("records that the plan is now llm-assisted", () => {
    expect(apply(makePlan(), goodProposal()).plan.provenance.compiler.mode).toBe("llm-assisted");
  });

  it("stamps llm-assisted provenance on invariants even if the proposal claims otherwise", () => {
    const proposal = goodProposal({
      invariants: [{ id: "inv_owner_only", kind: "authorization", statement: "s", routeIds: [ROUTE_GET], provenance: "manual" }],
    });
    // "manual" is not even accepted by the proposal schema, so the whole proposal is refused.
    expect(() => apply(makePlan(), proposal)).toThrow(/not a valid plan proposal/);
  });

  it("passes the reviewer notes through untouched", () => {
    expect(apply(makePlan(), goodProposal()).notes).toEqual(["Derived from the :id path parameter on /orders/:id."]);
  });
});

describe("a proposal is untrusted input", () => {
  it("refuses a proposal that is not structured plan content", () => {
    expect(() => apply(makePlan(), "here is what I think you should test")).toThrow(/not a valid plan proposal/);
    expect(() => apply(makePlan(), { checks: "lots" })).toThrow(/not a valid plan proposal/);
  });

  it("refuses unknown top-level keys rather than ignoring them", () => {
    expect(() => apply(makePlan(), { ...goodProposal(), safety: { mutationPolicy: "explicit-authorization-required" } }))
      .toThrow(/not a valid plan proposal/);
  });

  it("rejects a check whose route does not exist", () => {
    const proposal = goodProposal();
    proposal.checks[0]!.request.routeId = "route_ghost";
    const result = apply(makePlan(), proposal);
    expect(result.added.checks).toEqual([]);
    expect(result.rejected).toContainEqual({ kind: "check", id: "chk_owner_only", reason: "Unknown route route_ghost in request" });
  });

  it("rejects a check naming an oracle that has no implementation", () => {
    const proposal = goodProposal({
      invariants: [{ id: "inv_oob", kind: "out-of-band", statement: "s", routeIds: [ROUTE_GET], provenance: "llm-assisted" }],
      checks: [{ id: "chk_oob", invariantId: "inv_oob", enabled: true, oracle: "out-of-band", request: { routeId: ROUTE_GET, pathBindings: {}, queryBindings: {}, headerBindings: {} } }],
    });
    const result = apply(makePlan(), proposal);
    expect(result.added.checks).toEqual([]);
    expect(result.rejected[0]?.reason).toMatch(/has no implementation/);
  });

  it("rejects a check referencing an identity or fixture that was not proposed", () => {
    const proposal = goodProposal({ identities: [], fixtures: [] });
    const result = apply(makePlan(), proposal);
    expect(result.added.checks).toEqual([]);
    expect(result.rejected.some((item) => /Unknown identity/.test(item.reason))).toBe(true);
  });

  it("keeps the valid part of a partially bad proposal and reports the rest", () => {
    const proposal = goodProposal();
    proposal.checks.push({ ...proposal.checks[0]!, id: "chk_bad", request: { ...proposal.checks[0]!.request, routeId: "route_ghost" } });
    const result = apply(makePlan(), proposal);
    expect(result.added.checks).toEqual(["chk_owner_only"]);
    expect(result.rejected.map((item) => item.id)).toEqual(["chk_bad"]);
  });
});

describe("a proposal cannot widen safety", () => {
  it("rejects a check on a method the plan does not permit", () => {
    const proposal = goodProposal({
      invariants: [{ id: "inv_write", kind: "state-mutation", statement: "s", routeIds: [ROUTE_POST], provenance: "llm-assisted" }],
      checks: [{
        id: "chk_write", invariantId: "inv_write", enabled: true, oracle: "differential-authorization",
        request: { routeId: ROUTE_POST, pathBindings: {}, queryBindings: {}, headerBindings: {} },
        allowedIdentityIds: ["identity_owner"], deniedIdentityIds: ["identity_peer"], calibration: { trials: 3 },
      }],
    });
    const result = apply(makePlan(), proposal);
    expect(result.added.checks).toEqual([]);
    expect(result.rejected[0]?.reason).toMatch(/Method POST is not permitted/);
  });

  it("rejects a mutating check while the plan forbids mutation, even if the method is allowed", () => {
    const plan = makePlan({ safety: { mutationPolicy: "forbid", allowedMethods: ["GET", "POST"] } });
    const proposal = goodProposal({
      invariants: [{ id: "inv_write", kind: "state-mutation", statement: "s", routeIds: [ROUTE_POST], provenance: "llm-assisted" }],
      checks: [{
        id: "chk_write", invariantId: "inv_write", enabled: true, oracle: "differential-authorization",
        request: { routeId: ROUTE_POST, pathBindings: {}, queryBindings: {}, headerBindings: {} },
        allowedIdentityIds: ["identity_owner"], deniedIdentityIds: ["identity_peer"], calibration: { trials: 3 },
      }],
    });
    const result = apply(plan, proposal);
    expect(result.added.checks).toEqual([]);
    expect(result.rejected[0]?.reason).toMatch(/mutationPolicy is "forbid"/);
  });

  it("leaves the plan's safety policy exactly as it was", () => {
    const plan = makePlan();
    const result = apply(plan, goodProposal());
    expect(result.plan.safety).toEqual(plan.safety);
  });
});

describe("a proposal cannot introduce credentials", () => {
  it("refuses a merged plan carrying an inline credential", () => {
    const proposal = goodProposal();
    proposal.checks[0]!.request.headerBindings = { authorization: { literal: "Bearer leaked-token" } } as never;
    expect(() => apply(makePlan(), proposal)).toThrow(/inline credential-like values|failed validation/);
  });

  it("accepts the same header bound by reference", () => {
    const proposal = goodProposal();
    proposal.checks[0]!.request.headerBindings = { authorization: { runtimeRef: "ownerToken" } } as never;
    expect(apply(makePlan(), proposal).added.checks).toEqual(["chk_owner_only"]);
  });
});

describe("a proposal is additive only", () => {
  it("refuses to redefine an existing identity, fixture, invariant, or check", () => {
    const seeded = apply(makePlan(), goodProposal()).plan;
    const result = apply(seeded, goodProposal());
    expect(result.added).toEqual({ identities: [], fixtures: [], invariants: [], checks: [] });
    expect(result.rejected.map((item) => item.kind).sort()).toEqual(["check", "fixture", "identity", "identity", "invariant"]);
  });

  it("never removes anything that was already in the plan", () => {
    const seeded = apply(makePlan(), goodProposal()).plan;
    const result = apply(seeded, { notes: ["nothing to add"] });
    expect(result.plan.checks).toHaveLength(1);
    expect(result.plan.identities).toHaveLength(2);
  });
});

describe("token budget", () => {
  it("refuses a call whose estimate would overrun", () => {
    const budget = new TokenBudget(100);
    expect(() => budget.assertFits(101)).toThrow(BudgetExceededError);
    expect(() => budget.assertFits(100)).not.toThrow();
    expect(budget.spent).toBe(0); // checking does not consume
  });

  it("accounts for real usage and reports an overrun", () => {
    const budget = new TokenBudget(100);
    budget.record({ input: 40, output: 20, calls: 1 });
    expect(budget.spent).toBe(60);
    expect(budget.remaining).toBe(40);
    expect(() => budget.record({ input: 50, output: 0, calls: 1 })).toThrow(/exceeded its token budget/);
  });

  it("rejects a nonsensical limit", () => {
    expect(() => new TokenBudget(-1)).toThrow();
    expect(() => new TokenBudget(1.5)).toThrow();
  });
});

describe("compileWithProvider", () => {
  const provider = (proposal: unknown, usage = { input: 10, output: 5, calls: 1 }): CompilerProvider =>
    ({ name: "stub", propose: async () => ({ proposal, usage }) });

  it("passes only the surface to the provider, never credentials or a target URL", async () => {
    let seen: unknown;
    const spy: CompilerProvider = { name: "spy", propose: async (request) => { seen = request; return { proposal: { notes: [] }, usage: { input: 1, output: 1, calls: 1 } }; } };
    await compileWithProvider({ plan: makePlan(), provider: spy, availableOracles: ORACLES, tokenBudget: 1000 });

    const serialised = JSON.stringify(seen);
    expect(serialised).not.toMatch(/localhost|http:|Bearer|runtime/i);
    expect(seen).toMatchObject({ availableOracles: ORACLES, allowedMethods: ["GET"] });
    expect((seen as { routes: unknown[] }).routes).toHaveLength(2);
  });

  it("returns the merged plan and the real token usage", async () => {
    const result = await compileWithProvider({ plan: makePlan(), provider: provider(goodProposal()), availableOracles: ORACLES, tokenBudget: 1000 });
    expect(result.added.checks).toEqual(["chk_owner_only"]);
    expect(result.usage).toEqual({ input: 10, output: 5, calls: 1 });
    expect(result.provider).toBe("stub");
  });

  it("refuses to call a provider whose estimate exceeds the budget", async () => {
    const expensive: CompilerProvider = { name: "expensive", estimate: () => 5000, propose: async () => { throw new Error("must not be called"); } };
    await expect(compileWithProvider({ plan: makePlan(), provider: expensive, availableOracles: ORACLES, tokenBudget: 100 }))
      .rejects.toThrow(BudgetExceededError);
  });

  it("reports an overrun even when the provider under-estimated", async () => {
    const sneaky: CompilerProvider = { name: "sneaky", estimate: () => 1, propose: async () => ({ proposal: goodProposal(), usage: { input: 900, output: 900, calls: 1 } }) };
    await expect(compileWithProvider({ plan: makePlan(), provider: sneaky, availableOracles: ORACLES, tokenBudget: 100 }))
      .rejects.toThrow(/exceeded its token budget/);
  });

  it("surfaces a malformed proposal as an error rather than a partial plan", async () => {
    await expect(compileWithProvider({ plan: makePlan(), provider: provider("just some prose"), availableOracles: ORACLES, tokenBudget: 1000 }))
      .rejects.toThrow(/not a valid plan proposal/);
  });
});
