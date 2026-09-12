import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PlanSchema, RuntimeConfigSchema, calculateExecutionCoverage, calculatePlanCoverage,
  isScanComplete, runPlan,
  type Finding, type Plan, type RuntimeConfig, type ScanEvent, type ScanResult,
} from "@trinker/core";
import { differentialAuthorizationOracle, metamorphicResponseOracle, stateMutationOracle } from "@trinker/oracles";
import { createReport, type SecurityReport, writeReport } from "@trinker/report";
import { discoverSurface, ingestOpenApi, mergeSurfaces, type Surface } from "@trinker/surface";

/** Every oracle the runner can dispatch to. A check naming anything else is reported as unavailable. */
export const ORACLES = [differentialAuthorizationOracle, stateMutationOracle, metamorphicResponseOracle];

const trinkerDir = (projectDir: string) => join(projectDir, ".trinker");
const proposalPath = (projectDir: string) => join(trinkerDir(projectDir), "proposal.json");
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

export interface CompileOptions {
  /** Discard authored plan content and regenerate from source. */
  force?: boolean;
  /** Path to an OpenAPI document whose paths are merged with the extracted routes. */
  openApiPath?: string;
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
export async function compileProject(projectDir: string, options: CompileOptions = {}): Promise<CompileResult> {
  await initialiseProject(projectDir);
  const extracted = await discoverSurface({ rootDir: projectDir });
  const specification = options.openApiPath === undefined ? undefined : await readOpenApi(options.openApiPath);
  const surface = specification ? mergeSurfaces(extracted, specification.surface) : extracted;

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
    provenance: {
      sources: [
        { kind: "ast" as const, path: "." },
        ...(specification ? [{ kind: "openapi" as const, path: specification.source }] : []),
      ],
      compiler: { mode: "deterministic" as const, compilerVersion: "0.1.0" },
    },
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

/**
 * Read an OpenAPI document.
 *
 * JSON only. A YAML specification is refused with a conversion hint rather than parsed loosely —
 * a misread specification would put endpoints that do not exist into a reviewed security plan,
 * which is worse than refusing the file.
 */
async function readOpenApi(path: string): Promise<{ surface: Surface; source: string }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(`Could not read the OpenAPI document at ${path}`);
  }
  if (!raw.trimStart().startsWith("{")) {
    throw new Error(
      `${path} does not look like JSON. Trinker reads JSON OpenAPI documents only, because loosely parsing a specification could introduce endpoints that do not exist.\n` +
      `Convert it first, for example:  npx js-yaml ${path} > openapi.json`,
    );
  }
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : "parse error"}`);
  }
  const surface = ingestOpenApi(document, path);
  if (surface.routes.length === 0) {
    throw new Error(`${path} declared no usable operations under "paths".`);
  }
  return { surface, source: path };
}

/* --------------------------------------------------------------- console models */

export interface DashboardFinding {
  id: string; severity: string; title: string; method: string; path: string; oracle: string;
}

/**
 * Everything the console's dashboard shows, gathered from the same sources the CLI uses.
 *
 * Assembled here rather than in rendering code so the console stays a presentation layer, and so
 * every number on screen is one the engine actually produced. Missing data is `undefined`, never a
 * placeholder — a dashboard that invents a coverage percentage is worse than one that says "no scan
 * yet".
 */
export interface DashboardModel {
  planPath: string;
  planId?: string | undefined;
  targetRef?: string | undefined;
  targetUrl?: string | undefined;
  applicationId?: string | undefined;
  lastScanAt?: string | undefined;
  status: "no-plan" | "no-checks" | "no-scan" | "clean" | "incomplete" | "findings";
  routes: number;
  checks: number;
  passed: number;
  findings: number;
  /** Checks that produced no verdict. The dashboard must never imply a clean scan without this. */
  untested: number;
  durationMs?: number | undefined;
  plannedPercent?: number | undefined;
  verifiedPercent?: number | undefined;
  runtimeTokens: number;
  recentFindings: DashboardFinding[];
  oracles: string[];
  problem?: string | undefined;
}

export async function loadDashboard(projectDir: string): Promise<DashboardModel> {
  const base: DashboardModel = {
    planPath: planPath(projectDir),
    status: "no-plan",
    routes: 0, checks: 0, passed: 0, findings: 0, untested: 0,
    runtimeTokens: 0, recentFindings: [],
    oracles: ORACLES.map((oracle) => oracle.name),
  };

  let plan: Plan;
  try { plan = await loadPlan(projectDir); }
  catch (error) { return { ...base, problem: error instanceof Error ? error.message : "Plan could not be read" }; }

  const routeById = new Map(plan.surface.routes.map((route) => [route.id, route]));
  const model: DashboardModel = {
    ...base,
    planId: plan.planId,
    applicationId: plan.target.applicationId,
    targetRef: plan.target.allowedTargetRefs[0],
    routes: plan.surface.routes.length,
    checks: plan.checks.filter((check) => check.enabled).length,
    status: plan.checks.length === 0 ? "no-checks" : "no-scan",
    plannedPercent: calculatePlanCoverage(plan).percent,
  };

  // The target URL is local operator configuration, not a secret; credentials are never read here.
  try {
    const runtime = await loadRuntime(projectDir);
    const ref = model.targetRef;
    if (ref !== undefined) model.targetUrl = runtime.targets[ref]?.url;
  } catch { /* a missing or invalid runtime config is reported by the config screen, not here */ }

  let report: SecurityReport;
  try { report = await loadLatestReport(projectDir); }
  catch { return model; }

  const { result } = report;
  return {
    ...model,
    lastScanAt: report.generatedAt,
    durationMs: result.durationMs,
    passed: result.checks.passed,
    findings: result.findings.length,
    untested: result.checks.inconclusive + result.checks.errored + result.checks.unavailable,
    runtimeTokens: result.tokens.runtimeInput + result.tokens.runtimeOutput,
    verifiedPercent: report.coverage.verifiedPercent,
    status: result.findings.length > 0 ? "findings" : isScanComplete(result) ? "clean" : "incomplete",
    recentFindings: result.findings.map((finding) => {
      const route = routeById.get(finding.routeId);
      return {
        id: finding.id,
        severity: finding.severity,
        title: finding.title,
        oracle: finding.oracle,
        method: route?.method ?? "",
        path: route?.pathTemplate ?? finding.routeId,
      };
    }),
  };
}

/** The recorded proposal, for the compiler review screen. Absent until a compilation has run. */
export interface RecordedProposal {
  basePlanId?: string;
  record: Record<string, string | number>;
  added: { identities: string[]; fixtures: string[]; invariants: string[]; checks: string[] };
  rejected: Array<{ kind: string; id: string; reason: string }>;
  rationales: Record<string, string>;
  notes: string[];
  plan: Plan;
}

export async function loadRecordedProposal(projectDir: string): Promise<RecordedProposal | undefined> {
  try { return JSON.parse(await readFile(proposalPath(projectDir), "utf8")) as RecordedProposal; }
  catch { return undefined; }
}

/* ------------------------------------------------------- LLM-assisted compilation */

export interface LlmCompileOptions {
  /** Which provider authors the proposal. Defaults to openai. */
  provider?: string | undefined;
  /** Read from the environment by the caller. Never sourced from, or written to, the plan. */
  apiKey?: string | undefined;
  model?: string | undefined;
  /** Maximum tokens this compilation may spend. Required; there is no unlimited mode. */
  tokenBudget: number;
  /** Write the merged plan. Without it the proposal is only recorded for review. */
  apply?: boolean;
  timeoutMs?: number | undefined;
  /** Injected by tests so the whole flow runs without an API key or a network. */
  compilerProvider?: unknown;
  openApiPath?: string | undefined;
}

export interface LlmCompileResult {
  plan: Plan;
  added: { identities: string[]; fixtures: string[]; invariants: string[]; checks: string[] };
  rejected: Array<{ kind: string; id: string; reason: string }>;
  rationales: Record<string, string>;
  notes: string[];
  record: Record<string, unknown>;
  /** True when `.trinker/plan.json` was actually rewritten. */
  applied: boolean;
  proposalPath: string;
  /**
   * False when the surface could not be re-derived from source and the committed plan was used
   * as-is — normal for a hand-declared or OpenAPI-derived surface.
   */
  surfaceRefreshed: boolean;
}

/**
 * Compile with an LLM proposing checks.
 *
 * Explicitly opt-in, and reached from nowhere else: `@trinker/compiler` is loaded by dynamic
 * import so that `trinker run` never brings a provider into the process at all.
 *
 * The deterministic compile runs first, so the model reasons about a current surface and a plan
 * that still contains every authored check. Nothing the model returns is trusted — it is filtered
 * and re-validated by `applyProposal` before it can become a plan — and by default the merged plan
 * is only *recorded* for review rather than written, because silently rewriting a reviewed security
 * artifact on the strength of a model's suggestion is exactly what this project exists to avoid.
 */
export async function llmCompileProject(projectDir: string, options: LlmCompileOptions): Promise<LlmCompileResult> {
  const { compileWithProvider, selectProvider } = await import("@trinker/compiler");

  // Refresh the surface first, so the model reasons about current routes; this also preserves
  // everything a human authored.
  //
  // A plan whose surface was hand-declared or ingested from a specification cannot be re-derived
  // from source, and compileProject rightly refuses to write a plan that would strand its checks.
  // That must not block the compiler: fall back to the committed plan and say the surface is
  // stale, rather than either failing or quietly discarding the routes the checks depend on.
  let surfaceRefreshed = true;
  let plan: Plan;
  try {
    ({ plan } = await compileProject(projectDir, {
      ...(options.openApiPath !== undefined ? { openApiPath: options.openApiPath } : {}),
    }));
  } catch {
    plan = await loadPlan(projectDir);
    surfaceRefreshed = false;
  }

  const provider = (options.compilerProvider as Parameters<typeof compileWithProvider>[0]["provider"] | undefined)
    ?? selectProvider({
      provider: options.provider ?? "openai",
      apiKey: options.apiKey ?? "",
      model: options.model,
      timeoutMs: options.timeoutMs,
    });

  const result = await compileWithProvider({
    plan,
    provider,
    availableOracles: ORACLES.map((oracle) => oracle.name),
    tokenBudget: options.tokenBudget,
    rootDir: projectDir,
  });

  await mkdir(trinkerDir(projectDir), { recursive: true });
  await writeFile(
    proposalPath(projectDir),
    `${JSON.stringify({
      // The plan this was built from, so applying it later can refuse if the plan has moved on.
      basePlanId: plan.planId,
      record: result.record, added: result.added, rejected: result.rejected,
      rationales: result.rationales, notes: result.notes, plan: result.plan,
    }, null, 2)}\n`,
    "utf8",
  );

  const applied = options.apply === true;
  if (applied) await writeFile(planPath(projectDir), `${JSON.stringify(result.plan, null, 2)}\n`, "utf8");

  return {
    plan: result.plan,
    added: result.added,
    rejected: result.rejected,
    rationales: result.rationales,
    notes: result.notes,
    record: result.record as unknown as Record<string, unknown>,
    applied,
    proposalPath: proposalPath(projectDir),
    surfaceRefreshed,
  };
}

export interface ApplyProposalFileResult {
  plan: Plan;
  added: LlmCompileResult["added"];
  rationales: Record<string, string>;
  record: Record<string, unknown>;
}

/**
 * Apply the proposal already recorded on disk.
 *
 * Separate from `llmCompileProject` on purpose. Re-running the compiler to apply a proposal would
 * call the model again and apply *that* result — which is not the one a human just reviewed, since
 * a model is not deterministic. This applies exactly the reviewed bytes, costs nothing, and refuses
 * if the plan has changed since the proposal was produced.
 */
export async function applyRecordedProposal(projectDir: string): Promise<ApplyProposalFileResult> {
  let raw: string;
  try { raw = await readFile(proposalPath(projectDir), "utf8"); }
  catch { throw new Error("No proposal to apply. Run `trinker compile --llm` first."); }

  const stored = JSON.parse(raw) as {
    basePlanId?: string;
    plan?: unknown;
    added?: LlmCompileResult["added"];
    rationales?: Record<string, string>;
    record?: Record<string, unknown>;
  };

  const current = await loadPlan(projectDir);
  if (stored.basePlanId !== undefined && stored.basePlanId !== current.planId) {
    throw new Error(
      `The recorded proposal was built from plan ${stored.basePlanId}, but .trinker/plan.json is now ${current.planId}.\n` +
      "Re-run `trinker compile --llm` so the proposal is reviewed against the current plan.",
    );
  }

  // Re-validate rather than trusting the file: it is on disk and may have been edited.
  const parsed = PlanSchema.safeParse(stored.plan);
  if (!parsed.success) {
    throw new Error(describeIssues(".trinker/proposal.json", parsed.error.issues));
  }

  await writeFile(planPath(projectDir), `${JSON.stringify(parsed.data, null, 2)}\n`, "utf8");
  return {
    plan: parsed.data,
    added: stored.added ?? { identities: [], fixtures: [], invariants: [], checks: [] },
    rationales: stored.rationales ?? {},
    record: stored.record ?? {},
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

export async function toggleMutationAuthorized(projectDir: string): Promise<boolean> {
  const runtime = await loadRuntime(projectDir);
  runtime.mutationAuthorized = !runtime.mutationAuthorized;
  await writeFile(runtimePath(projectDir), `${JSON.stringify(runtime, null, 2)}\n`, "utf8");
  return runtime.mutationAuthorized;
}

export interface ScanOutput { result: ScanResult; report: SecurityReport; plan: Plan }

/**
 * What a replay actually established.
 *
 * "did not reproduce" is only true when the check passed. A replay that could not reach a verdict —
 * a state-mutation check re-run against state an earlier scan already changed, say — must not be
 * reported as though the flaw were gone.
 */
export type ReplayVerdict = "reproduced" | "not-reproduced" | "untestable";

export function describeReplay(findingId: string, result: ScanResult): { verdict: ReplayVerdict; summary: string } {
  if (result.findings.length > 0) return { verdict: "reproduced", summary: `${findingId} reproduced.` };
  const outcome = result.outcomes[0];
  if (outcome === undefined) return { verdict: "untestable", summary: `${findingId} could not be re-tested: the check did not run.` };
  if (outcome.status === "passed") return { verdict: "not-reproduced", summary: `${findingId} did NOT reproduce - the check now passes.` };
  return { verdict: "untestable", summary: `${findingId} could not be re-tested (${outcome.status}): ${outcome.reason}` };
}

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
export async function verifyFinding(projectDir: string, findingId: string, onEvent?: (event: ScanEvent) => void): Promise<ScanOutput & { reproduced: boolean; verdict: ReplayVerdict; summary: string }> {
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
  const replay = describeReplay(original.id, result);
  return { result, report: createReport(narrowed, result), plan: narrowed, reproduced: findings.length > 0, ...replay };
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
