import { describe, expect, it } from "vitest";
import { calculateExecutionCoverage, calculatePlanCoverage, type ScanResult } from "../src/index.js";
import { ROUTE_GET, ROUTE_POST, authCheck, makePlan } from "./fixtures.js";

const result = (outcomes: ScanResult["outcomes"]): ScanResult => ({
  scanId: "s", planId: "trkp_example", startedAt: "", completedAt: "", durationMs: 1,
  checks: { planned: outcomes.length, passed: 0, failed: 0, inconclusive: 0, errored: 0, unavailable: 0 },
  outcomes, findings: [], tokens: { compileInput: 0, compileOutput: 0, runtimeInput: 0, runtimeOutput: 0, calls: 0 },
});
const outcome = (status: ScanResult["outcomes"][number]["status"], routeId = ROUTE_GET, checkId = "chk_a") =>
  ({ checkId, routeId, oracle: "differential-authorization", status, reason: "" });

describe("plan coverage", () => {
  it("counts a route as covered when an enabled check targets it", () => {
    expect(calculatePlanCoverage(makePlan({ checks: [authCheck()] }))).toMatchObject({ inScopeRoutes: 1, coveredRoutes: 1, percent: 100 });
  });

  it("does not count a disabled check as coverage", () => {
    expect(calculatePlanCoverage(makePlan({ checks: [authCheck({ enabled: false })] }))).toMatchObject({ coveredRoutes: 0, uncoveredRouteIds: [ROUTE_GET] });
  });

  it("treats an empty scope as complete rather than zero", () => {
    expect(calculatePlanCoverage(makePlan({ coverage: { inScopeRouteIds: [], exclusions: [] } })).percent).toBe(100);
  });
});

describe("execution coverage (regression: a skipped check still counted as covered)", () => {
  const plan = makePlan({ checks: [authCheck()] });

  it("counts a route as verified only when its checks reached a verdict", () => {
    expect(calculateExecutionCoverage(plan, result([outcome("passed")]))).toMatchObject({ coveredRoutes: 1, verifiedRoutes: 1, verifiedPercent: 100 });
    expect(calculateExecutionCoverage(plan, result([outcome("failed")])).verifiedRoutes).toBe(1);
  });

  it.each(["inconclusive", "errored", "unavailable"] as const)("treats a planned-but-%s check as covered yet unverified", (status) => {
    const coverage = calculateExecutionCoverage(plan, result([outcome(status)]));
    expect(coverage.coveredRoutes).toBe(1);
    expect(coverage.verifiedRoutes).toBe(0);
    expect(coverage.unverifiedRouteIds).toEqual([ROUTE_GET]);
  });

  it("attributes each unverified route to its cause", () => {
    const coverage = calculateExecutionCoverage(plan, result([outcome("unavailable")]));
    expect(coverage.unavailableRouteIds).toEqual([ROUTE_GET]);
    expect(coverage.erroredRouteIds).toEqual([]);
  });

  it("treats a route as unverified when any one of its checks did not reach a verdict", () => {
    const twoChecks = makePlan({ checks: [authCheck({ id: "chk_a" }), authCheck({ id: "chk_b" })] });
    const coverage = calculateExecutionCoverage(twoChecks, result([outcome("passed", ROUTE_GET, "chk_a"), outcome("errored", ROUTE_GET, "chk_b")]));
    expect(coverage.verifiedRoutes).toBe(0);
    expect(coverage.unverifiedRouteIds).toEqual([ROUTE_GET]);
  });

  it("ignores outcomes for routes that are not in scope", () => {
    const coverage = calculateExecutionCoverage(plan, result([outcome("passed"), outcome("errored", ROUTE_POST, "chk_out")]));
    expect(coverage.verifiedRoutes).toBe(1);
    expect(coverage.erroredRouteIds).toEqual([]);
  });
});
