import type { Plan, RuntimeConfig } from "./schema.js";

const isLocalHost = (host: string): boolean => host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";

export function assertSafeTarget(plan: Plan, runtime: RuntimeConfig): URL {
  const targetRef = plan.target.allowedTargetRefs[0];
  if (!targetRef) throw new Error("Plan contains no allowed target reference");
  const target = runtime.targets[targetRef];
  if (!target) throw new Error(`Runtime configuration has no target named ${targetRef}`);
  const url = new URL(target.url);
  if (!isLocalHost(url.hostname) && !target.allowHosts.includes(url.hostname)) {
    throw new Error(`Target ${url.hostname} is blocked. Use an explicit allowHosts entry for an authorized target.`);
  }
  return url;
}

export function assertSafePlan(plan: Plan, runtime: RuntimeConfig): void {
  assertSafeTarget(plan, runtime);
  const checkedRoutes = plan.checks.map((check) => {
    const route = plan.surface.routes.find((candidate) => candidate.id === check.request.routeId);
    if (!route) throw new Error(`Check ${check.id} references an unknown route`);
    if (!plan.safety.allowedMethods.includes(route.method)) throw new Error(`Method ${route.method} is not allowed by this plan's safety policy`);
    return route;
  });
  const hasWriteMethod = checkedRoutes.some((route) => !["GET", "HEAD", "OPTIONS"].includes(route.method));
  if (hasWriteMethod && plan.safety.mutationPolicy === "forbid") throw new Error("Plan contains a write check while mutationPolicy is forbid");
  if (hasWriteMethod && !runtime.mutationAuthorized) throw new Error("Write checks require mutationAuthorized: true in runtime configuration");
}
