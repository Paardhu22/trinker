import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PlanSchema, RuntimeConfigSchema, calculatePlanCoverage, runPlan, type Plan, type ScanResult } from "@trinker/core";
import { differentialAuthorizationOracle } from "@trinker/oracles";
import { createReport, type SecurityReport, writeReport } from "@trinker/report";
import { discoverSurface } from "@trinker/surface";

const trinkerDir = (projectDir: string) => join(projectDir, ".trinker");
const planPath = (projectDir: string) => join(trinkerDir(projectDir), "plan.json");
const runtimePath = (projectDir: string) => join(trinkerDir(projectDir), "runtime.json");
const latestPath = (projectDir: string) => join(trinkerDir(projectDir), "latest-report.json");

export async function initialiseProject(projectDir: string): Promise<{ created: string[] }> {
  await mkdir(trinkerDir(projectDir), { recursive: true });
  const created: string[] = [];
  try { await readFile(runtimePath(projectDir), "utf8"); } catch {
    await writeFile(runtimePath(projectDir), `${JSON.stringify({ targets: { local: { url: "http://localhost:3000", allowHosts: [] } }, identities: {}, fixtures: {}, mutationAuthorized: false }, null, 2)}\n`);
    created.push(runtimePath(projectDir));
  }
  return { created };
}

export async function compileProject(projectDir: string): Promise<Plan> {
  await initialiseProject(projectDir);
  const surface = await discoverSurface({ rootDir: projectDir });
  const planWithoutId = {
    schemaVersion: 1 as const,
    surfaceDigest: surface.digest,
    target: { applicationId: projectDir.split("/").filter(Boolean).at(-1) ?? "application", allowedTargetRefs: ["local"] },
    surface: { frameworks: surface.frameworks, routes: surface.routes, resources: surface.resources },
    identities: [], fixtures: [], invariants: [], checks: [],
    coverage: { inScopeRouteIds: surface.routes.map((route) => route.id), exclusions: [] },
    safety: { mutationPolicy: "forbid" as const, allowedMethods: ["GET" as const, "HEAD" as const, "OPTIONS" as const] },
    provenance: { sources: [{ kind: "ast" as const, path: "." }], compiler: { mode: "deterministic" as const, compilerVersion: "0.1.0" } },
  };
  const planId = `trkp_${createHash("sha256").update(JSON.stringify(planWithoutId)).digest("hex").slice(0, 16)}`;
  const plan = PlanSchema.parse({ planId, ...planWithoutId });
  await writeFile(planPath(projectDir), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  return plan;
}

export async function loadPlan(projectDir: string): Promise<Plan> { return PlanSchema.parse(JSON.parse(await readFile(planPath(projectDir), "utf8"))); }
export async function loadRuntime(projectDir: string) { return RuntimeConfigSchema.parse(JSON.parse(await readFile(runtimePath(projectDir), "utf8"))); }

export async function runProject(projectDir: string, onEvent?: (event: { type: string; data: Record<string, unknown> }) => void): Promise<{ result: ScanResult; report: SecurityReport }> {
  const plan = await loadPlan(projectDir);
  const runtime = await loadRuntime(projectDir);
  const handle = runPlan({ plan, runtime, oracles: [differentialAuthorizationOracle] });
  const unsubscribe = onEvent ? handle.subscribe(onEvent) : undefined;
  try {
    const result = await handle.result;
    const report = createReport(plan, result);
    await mkdir(trinkerDir(projectDir), { recursive: true });
    await writeFile(latestPath(projectDir), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return { result, report };
  } finally { unsubscribe?.(); }
}

export async function verifyFinding(projectDir: string, findingId: string): Promise<{ result: ScanResult; report: SecurityReport }> {
  const latest = await loadLatestReport(projectDir);
  const finding = latest.result.findings.find((candidate) => candidate.id === findingId);
  if (!finding) throw new Error(`Finding ${findingId} is not present in the latest report`);
  const plan = await loadPlan(projectDir);
  const check = plan.checks.find((candidate) => candidate.id === finding.replay.checkId);
  if (!check) throw new Error(`Replay check ${finding.replay.checkId} is not present in the current plan`);
  const runtime = await loadRuntime(projectDir);
  const handle = runPlan({ plan: { ...plan, checks: [check] }, runtime, oracles: [differentialAuthorizationOracle] });
  const result = await handle.result;
  return { result, report: createReport(plan, result) };
}

export async function loadLatestReport(projectDir: string): Promise<SecurityReport> { return JSON.parse(await readFile(latestPath(projectDir), "utf8")) as SecurityReport; }
export async function exportLatestReport(projectDir: string, format: "json" | "markdown" | "sarif"): Promise<string> { return writeReport(projectDir, await loadLatestReport(projectDir), format); }
export async function coverageForProject(projectDir: string) { return calculatePlanCoverage(await loadPlan(projectDir)); }
