import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PlanSchema, RuntimeConfigSchema, calculateExecutionCoverage, calculatePlanCoverage, runPlan,
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
    `${JSON.stringify({ record: result.record, added: result.added, rejected: result.rejected, rationales: result.rationales, notes: result.notes, plan: result.plan }, null, 2)}\n`,
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
