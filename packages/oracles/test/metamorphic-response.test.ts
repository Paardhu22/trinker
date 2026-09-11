import { describe, expect, it } from "vitest";
import { exitCodeForScan, runPlan, type HttpClient, type HttpRequest, type Plan, type RuntimeConfig } from "@trinker/core";
import { metamorphicResponseOracle } from "../src/index.js";

const ROUTE = "route_get_orders_11111111";

const plan = (checkOverrides: Record<string, unknown> = {}): Plan => ({
  schemaVersion: 1, planId: "trkp_demo", surfaceDigest: `sha256:${"a".repeat(64)}`,
  target: { applicationId: "demo", allowedTargetRefs: ["local"] },
  surface: {
    frameworks: ["express"],
    routes: [{ id: ROUTE, method: "GET", pathTemplate: "/orders", parameters: [], sourceRefs: [], confidence: "high" }],
    resources: [],
  },
  identities: [{ id: "identity_owner", credentialRef: "owner", roles: [], capabilities: [] }],
  fixtures: [],
  invariants: [{ id: "inv_scope", kind: "metamorphic-response", statement: "The order list must be scoped by session, not by a query parameter.", routeIds: [ROUTE], provenance: "manual" }],
  checks: [{
    id: "chk_scope", invariantId: "inv_scope", enabled: true, oracle: "metamorphic-response",
    request: { routeId: ROUTE, pathBindings: {}, queryBindings: {}, headerBindings: {} },
    identityId: "identity_owner",
    relation: "identical",
    variants: [
      { name: "own-scope", queryBindings: { userId: { literal: "owner" } } },
      { name: "tampered-scope", queryBindings: { userId: { literal: "someone-else" } } },
    ],
    calibration: { stabilityReads: 1 },
    ...checkOverrides,
  } as never],
  coverage: { inScopeRouteIds: [ROUTE], exclusions: [] },
  safety: { mutationPolicy: "forbid", allowedMethods: ["GET"] },
  provenance: { sources: [], compiler: { mode: "manual", compilerVersion: "0.1.0" } },
});

const runtime: RuntimeConfig = {
  targets: { local: { url: "http://localhost:3000", allowHosts: [] } },
  identities: { owner: { headers: { authorization: "Bearer owner-token" } } },
  fixtures: {}, values: {}, mutationAuthorized: false,
};

const client = (impl: (userId: string | null, request: HttpRequest) => { status?: number; body: string }): { client: HttpClient; seen: HttpRequest[] } => {
  const seen: HttpRequest[] = [];
  return {
    seen,
    client: {
      request: async (request) => {
        seen.push(request);
        const result = impl(new URL(request.url).searchParams.get("userId"), request);
        return { status: result.status ?? 200, headers: { "content-type": "application/json" }, body: result.body, elapsedMs: 1 };
      },
    },
  };
};

const scan = (http: HttpClient, checkOverrides: Record<string, unknown> = {}) =>
  runPlan({ plan: plan(checkOverrides), runtime, oracles: [metamorphicResponseOracle], http, scanId: "scan_test" }).result;

describe("metamorphic response: client-controlled data scoping", () => {
  it("confirms when a caller-supplied parameter changes the response", async () => {
    // Vulnerable: the server scopes results by the query parameter instead of the session.
    const result = await scan(client((userId) => ({ body: JSON.stringify([{ owner: userId }]) })).client);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ id: "TRK-0001", status: "confirmed", oracle: "Metamorphic Response", routeId: ROUTE });
    expect(result.findings[0]?.verdict).toMatch(/Variant "tampered-scope" produced a different response/);
    expect(exitCodeForScan(result)).toBe(1);
  });

  it("passes when the server ignores the parameter and scopes by session", async () => {
    const result = await scan(client(() => ({ body: '[{"owner":"owner"}]' })).client);
    expect(result.findings).toHaveLength(0);
    expect(result.checks.passed).toBe(1);
    expect(exitCodeForScan(result)).toBe(0);
  });

  it("confirms on a status difference even when the relation only requires matching status", async () => {
    const result = await scan(
      client((userId) => (userId === "owner" ? { body: "{}" } : { status: 500, body: "{}" })).client,
      { relation: "status-identical" },
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.verdict).toMatch(/status 200 -> 500/);
  });

  it("ignores a body difference under the status-identical relation", async () => {
    const result = await scan(
      client((userId) => ({ body: JSON.stringify({ at: Date.now(), userId }) })).client,
      { relation: "status-identical" },
    );
    expect(result.findings).toHaveLength(0);
    expect(result.checks.passed).toBe(1);
  });
});

describe("metamorphic response: determinism calibration prevents false positives", () => {
  it("is inconclusive when the endpoint is not deterministic", async () => {
    let call = 0;
    const result = await scan(client(() => ({ body: JSON.stringify({ nonce: call++ }) })).client);
    expect(result.findings).toHaveLength(0);
    expect(result.checks.inconclusive).toBe(1);
    expect(result.outcomes[0]?.reason).toMatch(/not deterministic/);
    expect(result.outcomes[0]?.reason).toMatch(/status-identical/);
  });

  it("repeats the reference variant before comparing anything", async () => {
    const { client: http, seen } = client(() => ({ body: "{}" }));
    await scan(http, { calibration: { stabilityReads: 2 } });
    const scopes = seen.map((request) => new URL(request.url).searchParams.get("userId"));
    expect(scopes.slice(0, 3)).toEqual(["owner", "owner", "owner"]);
    expect(scopes[3]).toBe("someone-else");
  });
});

describe("metamorphic response: fixture-backed variants", () => {
  // The Juice Shop plan scopes its variants with fixtureRef bindings rather than literals, so the
  // resolution path through runtime fixtures needs its own coverage.
  const fixturePlan = (): Plan => {
    const base = plan({
      variants: [
        { name: "own-basket", queryBindings: { BasketId: { fixtureRef: "fixture_own", field: "id" } } },
        { name: "other-basket", queryBindings: { BasketId: { fixtureRef: "fixture_other", field: "id" } } },
      ],
    });
    return {
      ...base,
      fixtures: [{ id: "fixture_own", runtimeRef: "own" }, { id: "fixture_other", runtimeRef: "other" }],
    };
  };
  const fixtureRuntime: RuntimeConfig = { ...runtime, fixtures: { own: { id: "2" }, other: { id: "3" } } };

  const runFixtureScan = (http: HttpClient) =>
    runPlan({ plan: fixturePlan(), runtime: fixtureRuntime, oracles: [metamorphicResponseOracle], http, scanId: "s" }).result;

  it("resolves fixture values into each variant's query string", async () => {
    const { client: http, seen } = client(() => ({ body: "{}" }));
    await runFixtureScan(http);
    const scopes = seen.map((request) => new URL(request.url).searchParams.get("BasketId"));
    expect(scopes.slice(0, 2)).toEqual(["2", "2"]); // reference + stability control
    expect(scopes.at(-1)).toBe("3");
  });

  it("confirms when the fixture-scoped variant returns different data", async () => {
    const http: HttpClient = {
      request: async (request) => {
        const basket = new URL(request.url).searchParams.get("BasketId");
        return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify([{ BasketId: basket }]), elapsedMs: 1 };
      },
    };
    const result = await runFixtureScan(http);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.verdict).toMatch(/Variant "other-basket" produced a different response/);
  });

  it("passes when the endpoint ignores the fixture-scoped parameter", async () => {
    const http: HttpClient = { request: async () => ({ status: 200, headers: {}, body: '[{"owned":true}]', elapsedMs: 1 }) };
    const result = await runFixtureScan(http);
    expect(result.findings).toHaveLength(0);
    expect(result.checks.passed).toBe(1);
  });

  it("errors loudly when a variant references a fixture the runtime does not define", async () => {
    const { client: http } = client(() => ({ body: "{}" }));
    const result = await runPlan({ plan: fixturePlan(), runtime, oracles: [metamorphicResponseOracle], http, scanId: "s" }).result;
    expect(result.checks.errored).toBe(1);
    expect(result.outcomes[0]?.reason).toMatch(/"own" is not defined/);
  });
});

describe("metamorphic response: request construction", () => {
  it("sends every variant as the same identity, differing only in query parameters", async () => {
    const { client: http, seen } = client(() => ({ body: "{}" }));
    await scan(http);
    expect(seen.every((request) => request.headers["authorization"] === "Bearer owner-token")).toBe(true);
    expect(seen.every((request) => request.method === "GET")).toBe(true);
    expect(new Set(seen.map((request) => new URL(request.url).pathname))).toEqual(new Set(["/orders"]));
  });

  it("redacts credentials in the recorded evidence", async () => {
    const result = await scan(client((userId) => ({ body: JSON.stringify([userId]) })).client);
    const evidence = result.findings[0]!.evidence;
    expect(evidence.requests.every((request) => request.headers["authorization"] === "[REDACTED]")).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain("owner-token");
  });

  it("records both variant URLs so the difference is reviewable", async () => {
    const result = await scan(client((userId) => ({ body: JSON.stringify([userId]) })).client);
    const urls = result.findings[0]!.evidence.requests.map((request) => request.url);
    expect(urls[0]).toContain("userId=owner");
    expect(urls[1]).toContain("userId=someone-else");
  });
});
