import { describe, expect, it } from "vitest";
import {
  exitCodeForScan, runPlan,
  type HttpClient, type HttpRequest, type HttpResponse, type Plan, type RuntimeConfig,
} from "@trinker/core";
import { differentialAuthorizationOracle } from "../src/index.js";

const ROUTE = "route_get_orders_12345678";

const plan: Plan = {
  schemaVersion: 1, planId: "trkp_demo", surfaceDigest: `sha256:${"a".repeat(64)}`,
  target: { applicationId: "demo", allowedTargetRefs: ["local"] },
  surface: {
    frameworks: ["express"],
    routes: [{ id: ROUTE, method: "GET", pathTemplate: "/orders/:id", parameters: [{ name: "id", location: "path", required: true }], sourceRefs: [], confidence: "high" }],
    resources: [],
  },
  identities: [
    { id: "identity_owner", credentialRef: "owner", roles: [], capabilities: [] },
    { id: "identity_peer", credentialRef: "peer", roles: [], capabilities: [] },
  ],
  fixtures: [{ id: "fixture_order", runtimeRef: "order", ownerIdentityId: "identity_owner" }],
  invariants: [{ id: "inv_owner_only", kind: "authorization", statement: "Only an owner may read the order.", routeIds: [ROUTE], provenance: "manual" }],
  checks: [{
    id: "chk_order_auth", invariantId: "inv_owner_only", enabled: true, oracle: "differential-authorization",
    request: { routeId: ROUTE, pathBindings: { id: { fixtureRef: "fixture_order", field: "id" } }, queryBindings: {}, headerBindings: {} },
    allowedIdentityIds: ["identity_owner"], deniedIdentityIds: ["identity_peer"], calibration: { trials: 1 },
  }],
  coverage: { inScopeRouteIds: [ROUTE], exclusions: [] },
  safety: { mutationPolicy: "forbid", allowedMethods: ["GET"] },
  provenance: { sources: [], compiler: { mode: "manual", compilerVersion: "0.1.0" } },
};

const runtime: RuntimeConfig = {
  targets: { local: { url: "http://localhost:3000", allowHosts: [] } },
  identities: { owner: { headers: { authorization: "Bearer owner-token" } }, peer: { headers: { authorization: "Bearer peer-token" } } },
  fixtures: { order: { id: "42" } }, values: {}, mutationAuthorized: false,
};

const json = (status: number, body: string): HttpResponse => ({ status, headers: { "content-type": "application/json" }, body, elapsedMs: 1 });
const byIdentity = (impl: (isOwner: boolean, request: HttpRequest) => HttpResponse): HttpClient =>
  ({ request: async (request) => impl(request.headers["authorization"] === "Bearer owner-token", request) });

const scan = (http: HttpClient, override: Partial<Plan> = {}) =>
  runPlan({ plan: { ...plan, ...override }, runtime, oracles: [differentialAuthorizationOracle], http, scanId: "scan_test" }).result;

describe("differential authorization: confirmation requires byte equality", () => {
  it("confirms when a denied identity receives the identical successful response", async () => {
    const result = await scan(byIdentity(() => json(200, '{"id":"42","owner":"owner"}')));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ id: "TRK-0001", status: "confirmed", severity: "high", oracle: "Differential Authorization", routeId: ROUTE });
    expect(result.checks.failed).toBe(1);
    expect(exitCodeForScan(result)).toBe(1);
  });

  it("passes when the denied identity is properly refused", async () => {
    const result = await scan(byIdentity((isOwner) => (isOwner ? json(200, '{"id":"42"}') : json(403, '{"error":"forbidden"}'))));
    expect(result.findings).toHaveLength(0);
    expect(result.checks.passed).toBe(1);
    expect(exitCodeForScan(result)).toBe(0);
  });

  it("is inconclusive - not a finding - when a denied identity gets a DIFFERENT successful response", async () => {
    const result = await scan(byIdentity((isOwner) => json(200, isOwner ? '{"id":"42","total":99}' : '{"id":"42"}')));
    expect(result.findings).toHaveLength(0);
    expect(result.checks.inconclusive).toBe(1);
    expect(result.outcomes[0]?.reason).toMatch(/did not match any allowed witness/);
  });

  it("is inconclusive when no allowed identity produces a usable reference response", async () => {
    const result = await scan(byIdentity(() => json(500, '{"error":"boom"}')));
    expect(result.findings).toHaveLength(0);
    expect(result.checks.inconclusive).toBe(1);
    expect(result.outcomes[0]?.reason).toMatch(/No allowed identity produced a successful reference/);
  });

  it("does not confirm on a matching status alone when bodies differ", async () => {
    const result = await scan(byIdentity((isOwner) => json(200, isOwner ? "AAAA" : "BBBB")));
    expect(result.findings).toHaveLength(0);
  });
});

describe("differential authorization: evidence", () => {
  it("redacts credentials and records both witnesses with digests", async () => {
    const result = await scan(byIdentity(() => json(200, '{"id":"42"}')));
    const evidence = result.findings[0]!.evidence;
    expect(evidence.requests).toHaveLength(2);
    expect(evidence.requests.every((request) => request.headers["authorization"] === "[REDACTED]")).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain("owner-token");
    expect(evidence.responses[0]?.bodyDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(evidence.responses[0]?.bodyDigest).toBe(evidence.responses[1]?.bodyDigest);
  });

  it("produces a replay command matching the assigned finding id", async () => {
    const result = await scan(byIdentity(() => json(200, '{"id":"42"}')));
    const finding = result.findings[0]!;
    expect(finding.replay).toEqual({ checkId: "chk_order_auth", command: `trinker verify ${finding.id}` });
  });

  it("reports the calibrated denial statuses it actually observed", async () => {
    const result = await scan(byIdentity((isOwner) => (isOwner ? json(200, "{}") : json(404, "{}"))));
    expect(result.outcomes[0]?.reason).toMatch(/denial statuses: 404/);
  });
});

describe("differential authorization: runtime references", () => {
  it("resolves a runtimeRef header binding and keeps its value out of the evidence", async () => {
    const withRuntimeRef: Plan = {
      ...plan,
      checks: [{ ...plan.checks[0]!, request: { ...plan.checks[0]!.request, headerBindings: { "x-tenant": { runtimeRef: "tenant" } } } } as never],
    };
    const seen: HttpRequest[] = [];
    const http: HttpClient = { request: async (request) => { seen.push(request); return json(200, '{"id":"42"}'); } };
    const result = await runPlan({ plan: withRuntimeRef, runtime: { ...runtime, values: { tenant: "acme-secret" } }, oracles: [differentialAuthorizationOracle], http, scanId: "s" }).result;
    expect(seen[0]?.headers["x-tenant"]).toBe("acme-secret");
    expect(result.findings).toHaveLength(1);
    expect(JSON.stringify(result.findings[0]!.evidence)).not.toContain("acme-secret");
  });

  it("errors loudly instead of silently passing when a runtime value is missing", async () => {
    const withRuntimeRef: Plan = {
      ...plan,
      checks: [{ ...plan.checks[0]!, request: { ...plan.checks[0]!.request, headerBindings: { "x-tenant": { runtimeRef: "absent" } } } } as never],
    };
    const result = await runPlan({ plan: withRuntimeRef, runtime, oracles: [differentialAuthorizationOracle], http: byIdentity(() => json(200, "{}")), scanId: "s" }).result;
    expect(result.checks.errored).toBe(1);
    expect(result.findings).toHaveLength(0);
    expect(result.outcomes[0]?.reason).toMatch(/"absent" is not defined/);
    expect(exitCodeForScan(result)).toBe(3);
  });
});

describe("differential authorization: determinism", () => {
  it("consumes no runtime LLM tokens", async () => {
    const result = await scan(byIdentity(() => json(200, "{}")));
    expect(result.tokens.runtimeInput + result.tokens.runtimeOutput + result.tokens.calls).toBe(0);
  });

  it("issues one request per allowed identity and trials-many per denied identity", async () => {
    let count = 0;
    const http: HttpClient = { request: async (request) => { count++; return request.headers["authorization"] === "Bearer owner-token" ? json(200, "{}") : json(403, "{}"); } };
    await runPlan({ plan: { ...plan, checks: [{ ...plan.checks[0]!, calibration: { trials: 3 } } as never] }, runtime, oracles: [differentialAuthorizationOracle], http, scanId: "s" }).result;
    expect(count).toBe(1 + 3);
  });
});
