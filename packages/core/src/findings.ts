import { z } from "zod";

export const SeveritySchema = z.enum(["critical", "high", "medium", "low", "info"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const WitnessRequestSchema = z.object({
  method: z.string(), url: z.string(), headers: z.record(z.string()), body: z.unknown().optional(),
}).strict();
export const WitnessResponseSchema = z.object({
  status: z.number().int(), headers: z.record(z.string()), bodyDigest: z.string(), bodyPreview: z.string().max(1000).optional(),
}).strict();
export const FindingSchema = z.object({
  id: z.string().regex(/^TRK-\d{4}$/),
  status: z.literal("confirmed"),
  title: z.string(),
  severity: SeveritySchema,
  invariant: z.string(),
  routeId: z.string(),
  oracle: z.string(),
  verdict: z.string(),
  evidence: z.object({ requests: z.array(WitnessRequestSchema), responses: z.array(WitnessResponseSchema), notes: z.array(z.string()) }).strict(),
  replay: z.object({ command: z.string(), checkId: z.string() }).strict(),
  remediation: z.string(),
}).strict();
export type Finding = z.infer<typeof FindingSchema>;

/**
 * What an oracle returns when it confirms a violation.
 *
 * An oracle cannot know its finding's public identifier — ids are assigned by the runner in scan
 * order — so it must not attempt to author the replay command. Omitting both fields here makes the
 * "report tells you to run a command that does not exist" class of bug unrepresentable: only the
 * runner, which owns the id, can produce a `Finding`.
 */
export type FindingDraft = Omit<Finding, "id" | "replay"> & { replay: { checkId: string } };

/**
 * The outcome of a single planned check.
 *
 * `passed` and `failed` are verdicts: the oracle ran and reached a conclusion. The remaining three
 * are non-verdicts and are tracked separately so "0 findings" can never be mistaken for
 * "everything was tested".
 */
export type CheckStatus =
  /** The oracle ran and the invariant held. */
  | "passed"
  /** The oracle ran and mechanically confirmed a violation. */
  | "failed"
  /** The oracle ran but could not reach a verdict (e.g. no usable reference response). */
  | "inconclusive"
  /** The oracle threw. A bug, a bad binding, or an unreachable target — never a clean result. */
  | "errored"
  /** No oracle is registered for this check's `oracle` field. Nothing was tested. */
  | "unavailable";

/** Statuses meaning the check produced a real security verdict. */
export const VERDICT_STATUSES: readonly CheckStatus[] = ["passed", "failed"];
/** Statuses meaning the check did NOT produce a security verdict. */
export const NON_VERDICT_STATUSES: readonly CheckStatus[] = ["inconclusive", "errored", "unavailable"];
/** Statuses that indicate a configuration or execution fault rather than a security result. */
export const FAULT_STATUSES: readonly CheckStatus[] = ["errored", "unavailable"];

export const isVerdict = (status: CheckStatus): boolean => VERDICT_STATUSES.includes(status);
export const isFault = (status: CheckStatus): boolean => FAULT_STATUSES.includes(status);

/** Per-check record retained in the scan result, so coverage and reports can explain every check. */
export interface CheckOutcome {
  checkId: string;
  routeId: string;
  oracle: string;
  status: CheckStatus;
  reason: string;
  findingId?: string;
}

export interface CheckCounts {
  planned: number;
  passed: number;
  failed: number;
  inconclusive: number;
  errored: number;
  unavailable: number;
}

export const emptyCheckCounts = (planned = 0): CheckCounts => ({ planned, passed: 0, failed: 0, inconclusive: 0, errored: 0, unavailable: 0 });

export interface ScanResult {
  scanId: string;
  planId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  checks: CheckCounts;
  outcomes: CheckOutcome[];
  findings: Finding[];
  tokens: { compileInput: number; compileOutput: number; runtimeInput: number; runtimeOutput: number; calls: number };
}

/** True when every planned check produced a real verdict. Only then is "0 findings" meaningful. */
export const isScanComplete = (result: ScanResult): boolean =>
  result.checks.inconclusive === 0 && result.checks.errored === 0 && result.checks.unavailable === 0;

/** True when a check could not run because of a fault rather than a security outcome. */
export const hasFaults = (result: ScanResult): boolean => result.checks.errored > 0 || result.checks.unavailable > 0;

/**
 * CI exit-code policy.
 *
 * 0  every planned check reached a verdict and none confirmed a violation
 * 1  at least one violation was mechanically confirmed
 * 3  the scan could not be trusted: a check errored or had no oracle (and, under `strict`, was
 *    inconclusive). Distinct from 1 so a broken pipeline is never mistaken for a vulnerability,
 *    and distinct from 0 so a scan that tested nothing cannot report success.
 *
 * Exit code 2 is reserved for usage and configuration errors raised before a scan produces a
 * result, and is applied by the CLI.
 */
export type ScanExitCode = 0 | 1 | 3;

export function exitCodeForScan(result: ScanResult, options: { strict?: boolean } = {}): ScanExitCode {
  if (result.findings.length > 0) return 1;
  if (hasFaults(result)) return 3;
  if (options.strict === true && result.checks.inconclusive > 0) return 3;
  return 0;
}
