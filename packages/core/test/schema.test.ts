import { describe, expect, it } from "vitest";
import { PlanSchema, ScanEventBus, calculatePlanCoverage } from "../src/index.js";

const basePlan = {
  schemaVersion: 1, planId: "trkp_example", surfaceDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  target: { applicationId: "app", allowedTargetRefs: ["local"] },
  surface: { frameworks: ["express"], routes: [{ id: "route_get_orders_11111111", method: "GET", pathTemplate: "/orders/:id", parameters: [], sourceRefs: [], confidence: "high" }], resources: [] },
  identities: [], fixtures: [], invariants: [], checks: [], coverage: { inScopeRouteIds: ["route_get_orders_11111111"], exclusions: [] }, safety: { mutationPolicy: "forbid", allowedMethods: ["GET"] }, provenance: { sources: [], compiler: { mode: "manual", compilerVersion: "0.1.0" } },
};

describe("core plan contracts", () => {
  it("calculates coverage from enabled deterministic checks", () => {
    const plan = PlanSchema.parse(basePlan);
    expect(calculatePlanCoverage(plan)).toMatchObject({ inScopeRoutes: 1, coveredRoutes: 0, percent: 0 });
  });
  it("keeps event ordering owned by core", () => {
    const bus = new ScanEventBus("scan_test", () => new Date("2026-09-11T00:00:00.000Z"));
    expect(bus.emit("scan.started", {}).sequence).toBe(1);
    expect(bus.emit("scan.completed", {}).sequence).toBe(2);
  });
  it("rejects credential-like values in the committed plan", () => {
    const unsafe = structuredClone(basePlan) as Record<string, unknown>;
    unsafe.provenance = { sources: [], compiler: { mode: "manual", compilerVersion: "0.1.0" }, apiKey: "do-not-commit" };
    expect(PlanSchema.safeParse(unsafe).success).toBe(false);
  });
});
