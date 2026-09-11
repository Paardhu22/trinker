import { PlanSchema, RuntimeConfigSchema, type Plan, type RuntimeConfig } from "../src/index.js";

export const ROUTE_GET = "route_get_orders_11111111";
export const ROUTE_POST = "route_post_orders_22222222";

/** A minimal but complete plan. Callers override only the part under test. */
export function makePlan(overrides: Record<string, unknown> = {}): Plan {
  return PlanSchema.parse({
    schemaVersion: 1,
    planId: "trkp_example",
    surfaceDigest: `sha256:${"a".repeat(64)}`,
    target: { applicationId: "app", allowedTargetRefs: ["local"] },
    surface: {
      frameworks: ["express"],
      routes: [
        { id: ROUTE_GET, method: "GET", pathTemplate: "/orders/:id", parameters: [{ name: "id", location: "path", required: true }], sourceRefs: [], confidence: "high" },
        { id: ROUTE_POST, method: "POST", pathTemplate: "/orders", parameters: [], sourceRefs: [], confidence: "high" },
      ],
      resources: [],
    },
    identities: [
      { id: "identity_owner", credentialRef: "owner", roles: [], capabilities: [] },
      { id: "identity_peer", credentialRef: "peer", roles: [], capabilities: [] },
    ],
    fixtures: [{ id: "fixture_order", runtimeRef: "order", ownerIdentityId: "identity_owner" }],
    invariants: [{ id: "inv_owner_only", kind: "authorization", statement: "Only an owner may read the order.", routeIds: [ROUTE_GET], provenance: "manual" }],
    checks: [],
    coverage: { inScopeRouteIds: [ROUTE_GET], exclusions: [] },
    safety: { mutationPolicy: "forbid", allowedMethods: ["GET"] },
    provenance: { sources: [], compiler: { mode: "manual", compilerVersion: "0.1.0" } },
    ...overrides,
  });
}

export function makeRuntime(overrides: Record<string, unknown> = {}): RuntimeConfig {
  return RuntimeConfigSchema.parse({
    targets: { local: { url: "http://localhost:3000", allowHosts: [] } },
    identities: { owner: { headers: { authorization: "Bearer owner-token" } }, peer: { headers: { authorization: "Bearer peer-token" } } },
    fixtures: { order: { id: "42" } },
    values: {},
    mutationAuthorized: false,
    ...overrides,
  });
}

export const authCheck = (overrides: Record<string, unknown> = {}) => ({
  id: "chk_order_auth",
  invariantId: "inv_owner_only",
  enabled: true,
  oracle: "differential-authorization",
  request: { routeId: ROUTE_GET, pathBindings: { id: { fixtureRef: "fixture_order", field: "id" } }, queryBindings: {}, headerBindings: {} },
  allowedIdentityIds: ["identity_owner"],
  deniedIdentityIds: ["identity_peer"],
  calibration: { trials: 1 },
  ...overrides,
});
