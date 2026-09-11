import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PlanSchema, RuntimeConfigSchema, calculateExecutionCoverage, calculatePlanCoverage, runPlan,
  type Finding, type Plan, type RuntimeConfig, type ScanEvent, type ScanResult,
} from "@trinker/core";
import { differentialAuthorizationOracle, metamorphicResponseOracle, stateMutationOracle } from "@trinker/oracles";
import { createReport, type SecurityReport, writeReport } from "@trinker/report";
import { discoverSurface } from "@trinker/surface";

/** Every oracle the runner can dispatch to. A check naming anything else is reported as unavailable. */
export const ORACLES = [differentialAuthorizationOracle, stateMutationOracle, metamorphicResponseOracle];

const trinkerDir = (projectDir: string) => join(projectDir, ".trinker");
const planPath = (projectDir: string) => join(trinkerDir(projectDir), "plan.json");
const runtimePath = (projectDir: string) => join(trinkerDir(projectDir), "runtime.json");
const latestPath = (projectDir: string) => join(trinkerDir(projectDir), "latest-report.json");

const DEFAULT_RUNTIME = {
  targets: { local: { url: "http://localhost:3000", allowHosts: [] } },
  identities: {},
  fixtures: {},
  values: {},
  mutationAuthorized: false,
};

export async function initialiseProject(projectDir: string): Promise<{ created: string[] }> {
  await mkdir(trinkerDir(projectDir), { recursive: true });
  const created: string[] = [];
  try { await readFile(runtimePath(projectDir), "utf8"); } catch {
    await writeFile(runtimePath(projectDir), `${JSON.stringify(DEFAULT_RUNTIME, null, 2)}\n`);
    created.push(runtimePath(projectDir));
  }
  return { created };
}

export interface CompileResult {
  plan: Plan;
  /** True when an existing plan's hand-authored sections were carried forward. */
  merged: boolean;
  addedRouteIds: string[];
  removedRouteIds: string[];
}

/**
 * Extract the surface and write `.trinker/plan.json`.
 *
 * Recompilation preserves everything a human authored — identities, fixtures, invariants, checks,
 * and the safety policy — and replaces only what is mechanically derived from source. The plan is
 * meant to accumulate reviewed security knowledge, so a re-run after a code change must never
 * silently discard it. Pass `force` to regenerate from scratch.
 */
export async function compileProject(projectDir: string, options: { force?: boolean } = {}): Promise<CompileResult> {
  await initialiseProject(projectDir);
  const surface = await discoverSurface({ rootDir: projectDir });

  const existing = options.force === true ? undefined : await loadPlanIfPresent(projectDir);
  const previousRouteIds = new Set(existing?.surface.routes.map((route) => route.id) ?? []);
  const currentRouteIds = new Set(surface.routes.map((route) => route.id));

  const authored = existing
    ? { identities: existing.identities, fixtures: existing.fixtures, invariants: existing.invariants, checks: existing.checks }
    : { identities: [], fixtures: [], invariants: [], checks: [] };

  const planWithoutId = {
    schemaVersion: 1 as const,
    surfaceDigest: surface.digest,
    target: existing?.target ?? { applicationId: projectDir.split("/").filter(Boolean).at(-1) ?? "application", allowedTargetRefs: ["local"] },
    surface: { frameworks: surface.frameworks, routes: surface.routes, resources: surface.resources },
    ...authored,
    coverage: {
      inScopeRouteIds: surface.routes.map((route) => route.id),
      exclusions: (existing?.coverage.exclusions ?? []).filter((exclusion) => currentRouteIds.has(exclusion.routeId)),
    },
    safety: existing?.safety ?? { mutationPolicy: "forbid" as const, allowedMethods: ["GET" as const, "HEAD" as const, "OPTIONS" as const] },
    provenance: { sources: [{ kind: "ast" as const, path: "." }], compiler: { mode: "deterministic" as const, compilerVersion: "0.1.0" } },
  };
  const planId = `trkp_${createHash("sha256").update(JSON.stringify(planWithoutId)).digest("hex").slice(0, 16)}`;

  const parsed = PlanSchema.safeParse({ planId, ...planWithoutId });
  if (!parsed.success) {
    // Refuse to write rather than silently dropping authored checks that no longer resolve.
    const dangling = authored.checks.filter((check) => !currentRouteIds.has(check.request.routeId)).map((check) => check.id);
    const detail = dangling.length > 0
      ? `These checks reference routes that no longer exist: ${dangling.join(", ")}. Update or remove them in .trinker/plan.json, or re-run with --force to discard all authored content.`
      : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Recompiled plan is invalid, so .trinker/plan.json was left unchanged.\n${detail}`);
  }

  await writeFile(planPath(projectDir), `${JSON.stringify(parsed.data, null, 2)}\n`, "utf8");
  return {
    plan: parsed.data,
    merged: existing !== undefined,
    addedRouteIds: [...currentRouteIds].filter((id) => !previousRouteIds.has(id)).sort(),
    removedRouteIds: [...previousRouteIds].filter((id) => !currentRouteIds.has(id)).sort(),
  };
}

async function loadPlanIfPresent(projectDir: string): Promise<Plan | undefined> {
  let raw: string;
  try { raw = await readFile(planPath(projectDir), "utf8"); } catch { return undefined; }
  const parsed = PlanSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error("The existing .trinker/plan.json is invalid, so recompiling would discard it. Fix it, or re-run with --force to regenerate from source.");
  }
  return parsed.data;
}

/** Zod's raw issue dump is unreadable in a terminal; name the field and the problem instead. */
function describeIssues(file: string, issues: readonly { path: (string | number)[]; message: string }[]): string {
  const lines = issues.slice(0, 10).map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  const extra = issues.length > lines.length ? `\n  …and ${issues.length - lines.length} more` : "";
  return `${file} is invalid:\n${lines.join("\n")}${extra}`;
}

export async function loadPlan(projectDir: string): Promise<Plan> {
  const parsed = PlanSchema.safeParse(JSON.parse(await readFile(planPath(projectDir), "utf8")));
  if (!parsed.success) throw new Error(describeIssues(".trinker/plan.json", parsed.error.issues));
  return parsed.data;
}

export async function loadRuntime(projectDir: string): Promise<RuntimeConfig> {
  const parsed = RuntimeConfigSchema.safeParse(JSON.parse(await readFile(runtimePath(projectDir), "utf8")));
  if (!parsed.success) throw new Error(describeIssues(".trinker/runtime.json", parsed.error.issues));
  return parsed.data;
}

export interface ScanOutput { result: ScanResult; report: SecurityReport; plan: Plan }

export async function runProject(projectDir: string, onEvent?: (event: ScanEvent) => void): Promise<ScanOutput> {
  const plan = await loadPlan(projectDir);
  const runtime = await loadRuntime(projectDir);
  // The listener is handed to runPlan rather than attached afterwards, so the very first event is observed.
  const handle = runPlan({ plan, runtime, oracles: ORACLES, ...(onEvent ? { onEvent } : {}) });
  const result = await handle.result;
  const report = createReport(plan, result);
  await mkdir(trinkerDir(projectDir), { recursive: true });
  await writeFile(latestPath(projectDir), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { result, report, plan };
}

/**
 * Re-run the single check behind a confirmed finding.
 *
 * The replayed scan numbers its findings from scratch, so the reproduced finding is relabelled
 * with the original identifier: it is the same finding, and a report that renamed it would break
 * the link back to the original scan.
 */
export async function verifyFinding(projectDir: string, findingId: string, onEvent?: (event: ScanEvent) => void): Promise<ScanOutput & { reproduced: boolean }> {
  const latest = await loadLatestReport(projectDir);
  const original = latest.result.findings.find((candidate) => candidate.id === findingId);
  if (!original) throw new Error(`Finding ${findingId} is not present in the latest report. Run \`trinker report\` to list findings.`);
  const plan = await loadPlan(projectDir);
  const check = plan.checks.find((candidate) => candidate.id === original.replay.checkId);
  if (!check) throw new Error(`Replay check ${original.replay.checkId} is not present in the current plan`);
  const runtime = await loadRuntime(projectDir);

  const narrowed: Plan = { ...plan, checks: [check] };
  const handle = runPlan({ plan: narrowed, runtime, oracles: ORACLES, ...(onEvent ? { onEvent } : {}) });
  const raw = await handle.result;
  const findings: Finding[] = raw.findings.map((finding) => ({ ...finding, id: original.id, replay: { ...finding.replay, command: `trinker verify ${original.id}` } }));
  const result: ScanResult = {
    ...raw, findings,
    outcomes: raw.outcomes.map((outcome) => (outcome.findingId ? { ...outcome, findingId: original.id } : outcome)),
  };
  return { result, report: createReport(narrowed, result), plan: narrowed, reproduced: findings.length > 0 };
}

export async function loadLatestReport(projectDir: string): Promise<SecurityReport> {
  try {
    return JSON.parse(await readFile(latestPath(projectDir), "utf8")) as SecurityReport;
  } catch {
    throw new Error("No scan has been run yet. Run `trinker run` first.");
  }
}
export async function exportLatestReport(projectDir: string, format: "json" | "markdown" | "sarif"): Promise<string> {
  return writeReport(projectDir, await loadLatestReport(projectDir), format);
}
export async function coverageForProject(projectDir: string) {
  return calculatePlanCoverage(await loadPlan(projectDir));
}
/** Plan coverage combined with the latest scan's real outcomes, when a scan exists. */
export async function executionCoverageForProject(projectDir: string) {
  const plan = await loadPlan(projectDir);
  try {
    const latest = await loadLatestReport(projectDir);
    return calculateExecutionCoverage(plan, latest.result);
  } catch {
    return undefined;
  }
}
