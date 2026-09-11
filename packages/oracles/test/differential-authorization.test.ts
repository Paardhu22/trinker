import { describe, expect, it } from "vitest";
import { runPlan, type HttpClient, type HttpRequest, type Plan } from "@trinker/core";
import { differentialAuthorizationOracle } from "../src/index.js";

const plan: Plan = {
  schemaVersion: 1, planId: "trkp_demo", surfaceDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  target: { applicationId: "demo", allowedTargetRefs: ["local"] },
  surface: { frameworks: ["express"], routes: [{ id: "route_get_orders_12345678", method: "GET", pathTemplate: "/orders/:id", parameters: [{ name: "id", location: "path", required: true }], sourceRefs: [], confidence: "high" }], resources: [] },
  identities: [{ id: "identity_owner", roles: [], capabilities: [] }, { id: "identity_peer", roles: [], capabilities: [] }],
  fixtures: [{ id: "fixture_order", runtimeRef: "order", ownerIdentityId: "identity_owner" }],
  invariants: [{ id: "inv_owner_only", kind: "authorization", statement: "Only an owner may read the order.", routeIds: ["route_get_orders_12345678"], provenance: "manual" }],
  checks: [{ id: "chk_order_auth", invariantId: "inv_owner_only", enabled: true, oracle: "differential-authorization", request: { routeId: "route_get_orders_12345678", pathBindings: { id: { fixtureRef: "fixture_order", field: "id" } }, queryBindings: {}, headerBindings: {} }, allowedIdentityIds: ["identity_owner"], deniedIdentityIds: ["identity_peer"], calibration: { trials: 1 } }],
  coverage: { inScopeRouteIds: ["route_get_orders_12345678"], exclusions: [] }, safety: { mutationPolicy: "forbid", allowedMethods: ["GET"] }, provenance: { sources: [], compiler: { mode: "manual", compilerVersion: "0.1.0" } },
};

const runtime = { targets: { local: { url: "http://localhost:3000", allowHosts: [] } }, identities: {}, fixtures: { order: { id: "42" } }, mutationAuthorized: false };
class VulnerableClient implements HttpClient { async request(request: HttpRequest) { return { status: 200, headers: { "content-type": "application/json" }, body: '{"id":"42","owner":"owner"}', elapsedMs: 1 }; } }

describe("differential authorization oracle", () => {
  it("confirms only identical successful witness responses", async () => {
    const result = await runPlan({ plan, runtime, oracles: [differentialAuthorizationOracle], http: new VulnerableClient(), scanId: "scan_test" }).result;
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ id: "TRK-0001", status: "confirmed", oracle: "Differential Authorization" });
    expect(result.tokens.runtimeInput).toBe(0);
  });
});
