import type { Plan } from "./schema.js";

export interface CoverageSummary { inScopeRoutes: number; coveredRoutes: number; uncoveredRouteIds: string[]; percent: number; }
export function calculatePlanCoverage(plan: Plan): CoverageSummary {
  const checkedRouteIds = new Set(plan.checks.filter((check) => check.enabled).map((check) => check.request.routeId));
  const inScope = [...new Set(plan.coverage.inScopeRouteIds)].sort();
  const uncoveredRouteIds = inScope.filter((routeId) => !checkedRouteIds.has(routeId));
  return { inScopeRoutes: inScope.length, coveredRoutes: inScope.length - uncoveredRouteIds.length, uncoveredRouteIds, percent: inScope.length === 0 ? 0 : ((inScope.length - uncoveredRouteIds.length) / inScope.length) * 100 };
}
