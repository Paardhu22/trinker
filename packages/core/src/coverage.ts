import type { CheckOutcome, CheckStatus, ScanResult } from "./findings.js";
import { isVerdict } from "./findings.js";
import type { Plan } from "./schema.js";

/** What the plan intends to test, independent of whether a scan has run. */
export interface CoverageSummary {
  inScopeRoutes: number;
  coveredRoutes: number;
  uncoveredRouteIds: string[];
  percent: number;
}

/** What a scan actually tested. Always narrower than or equal to plan coverage. */
export interface ExecutionCoverageSummary extends CoverageSummary {
  /** Routes where every planned check produced a real verdict (passed or failed). */
  verifiedRoutes: number;
  verifiedPercent: number;
  /** Planned but not verified, grouped by why. These are the routes "0 findings" says nothing about. */
  unverifiedRouteIds: string[];
  inconclusiveRouteIds: string[];
  erroredRouteIds: string[];
  unavailableRouteIds: string[];
}

const pct = (part: number, whole: number): number => (whole === 0 ? 100 : (part / whole) * 100);

export function calculatePlanCoverage(plan: Plan): CoverageSummary {
  const checkedRouteIds = new Set(plan.checks.filter((check) => check.enabled).map((check) => check.request.routeId));
  const inScope = [...new Set(plan.coverage.inScopeRouteIds)].sort();
  const uncoveredRouteIds = inScope.filter((routeId) => !checkedRouteIds.has(routeId));
  const coveredRoutes = inScope.length - uncoveredRouteIds.length;
  return { inScopeRoutes: inScope.length, coveredRoutes, uncoveredRouteIds, percent: pct(coveredRoutes, inScope.length) };
}

const routeIdsWith = (outcomes: CheckOutcome[], status: CheckStatus, inScope: Set<string>): string[] =>
  [...new Set(outcomes.filter((outcome) => outcome.status === status && inScope.has(outcome.routeId)).map((outcome) => outcome.routeId))].sort();

/**
 * Combine the plan's intent with a scan's actual outcomes.
 *
 * A route counts as verified only when *every* planned check on it reached a verdict. One
 * unavailable oracle is enough to make the route unverified, because a partially tested route
 * cannot support a claim that it is clean.
 */
export function calculateExecutionCoverage(plan: Plan, result: ScanResult): ExecutionCoverageSummary {
  const planCoverage = calculatePlanCoverage(plan);
  const inScope = new Set(plan.coverage.inScopeRouteIds);
  const relevant = result.outcomes.filter((outcome) => inScope.has(outcome.routeId));

  const byRoute = new Map<string, CheckOutcome[]>();
  for (const outcome of relevant) byRoute.set(outcome.routeId, [...(byRoute.get(outcome.routeId) ?? []), outcome]);

  const verified: string[] = [];
  const unverified: string[] = [];
  for (const [routeId, outcomes] of byRoute) (outcomes.every((outcome) => isVerdict(outcome.status)) ? verified : unverified).push(routeId);

  return {
    ...planCoverage,
    verifiedRoutes: verified.length,
    verifiedPercent: pct(verified.length, planCoverage.inScopeRoutes),
    unverifiedRouteIds: unverified.sort(),
    inconclusiveRouteIds: routeIdsWith(relevant, "inconclusive", inScope),
    erroredRouteIds: routeIdsWith(relevant, "errored", inScope),
    unavailableRouteIds: routeIdsWith(relevant, "unavailable", inScope),
  };
}
