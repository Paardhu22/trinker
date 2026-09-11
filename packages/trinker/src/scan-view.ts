import type { CheckStatus, ScanEvent } from "@trinker/core";

/**
 * A renderable view of a scan, derived purely from the typed event stream.
 *
 * This is deliberately separate from the terminal: it is a pure reducer, so the console can be
 * tested without a TTY and no security decision can leak into presentation code. Every field here
 * is observed from an event — nothing is estimated, and progress never advances on a timer.
 */
export interface ScanView {
  planId?: string | undefined;
  targetRef?: string | undefined;
  target?: string | undefined;
  phase?: string | undefined;
  plannedChecks: number;
  completedChecks: number;
  counts: Record<CheckStatus, number>;
  /** The check currently executing, or undefined between checks. */
  current?: {
    checkId: string;
    oracle: string;
    routeId: string;
    /** Most recent progress line for this check, e.g. which identity or variant is in flight. */
    activity?: string;
  } | undefined;
  findings: Array<{ findingId: string; severity: string; title: string; routeId: string }>;
  outcomes: Array<{ checkId: string; routeId: string; oracle: string; status: CheckStatus; reason: string }>;
  tokens: { runtimeInput: number; runtimeOutput: number; calls: number };
  /** Populated only when the scan aborted before executing, e.g. a safety refusal. */
  failure?: string | undefined;
  done: boolean;
  lastEvent?: ScanEvent["type"] | undefined;
}

export const emptyScanView = (): ScanView => ({
  plannedChecks: 0,
  completedChecks: 0,
  counts: { passed: 0, failed: 0, inconclusive: 0, errored: 0, unavailable: 0 },
  findings: [],
  outcomes: [],
  tokens: { runtimeInput: 0, runtimeOutput: 0, calls: 0 },
  done: false,
});

const OUTCOME_EVENTS: Record<string, CheckStatus> = {
  "check.passed": "passed",
  "check.failed": "failed",
  "check.inconclusive": "inconclusive",
  "check.errored": "errored",
  "check.unavailable": "unavailable",
};

const str = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const num = (value: unknown, fallback = 0): number => (typeof value === "number" ? value : fallback);

/** Fold one event into the view. Returns a new object so renderers can diff cheaply. */
export function applyScanEvent(view: ScanView, event: ScanEvent): ScanView {
  const next: ScanView = { ...view, counts: { ...view.counts }, lastEvent: event.type };
  const data = event.data;

  switch (event.type) {
    case "scan.started":
      next.planId = str(data["planId"]);
      next.targetRef = str(data["targetRef"]);
      next.plannedChecks = num(data["plannedChecks"]);
      break;

    case "phase.started": {
      // The runner announces the scan phase; an oracle announces its own sub-phase for a check.
      const target = str(data["target"]);
      if (target) next.target = target;
      next.phase = str(data["phase"], view.phase ?? "");
      break;
    }

    case "check.started":
      next.current = { checkId: str(data["checkId"]), oracle: str(data["oracle"]), routeId: str(data["routeId"]) };
      break;

    case "check.progress":
      if (next.current) next.current = { ...next.current, activity: describeProgress(data) };
      break;

    case "oracle.calibrated":
      if (next.current) next.current = { ...next.current, activity: describeCalibration(data) };
      break;

    case "finding.confirmed":
      next.findings = [...view.findings, {
        findingId: str(data["findingId"]),
        severity: str(data["severity"], "unknown"),
        title: str(data["title"], "Confirmed finding"),
        routeId: str(data["routeId"]),
      }];
      break;

    case "usage.updated":
      next.tokens = { runtimeInput: num(data["runtimeInput"]), runtimeOutput: num(data["runtimeOutput"]), calls: num(data["calls"]) };
      break;

    case "scan.failed":
      next.failure = str(data["reason"], "Scan aborted");
      next.done = true;
      next.current = undefined;
      break;

    case "scan.completed":
      next.done = true;
      next.current = undefined;
      break;

    default:
      break;
  }

  const status = OUTCOME_EVENTS[event.type];
  if (status) {
    next.counts[status] += 1;
    next.completedChecks = view.completedChecks + 1;
    next.outcomes = [...view.outcomes, {
      checkId: str(data["checkId"]),
      routeId: str(data["routeId"]),
      oracle: str(data["oracle"]),
      status,
      reason: str(data["reason"]),
    }];
    next.current = undefined;
  }
  return next;
}

function describeProgress(data: Record<string, unknown>): string {
  const parts: string[] = [];
  const identity = str(data["identityId"]);
  const variant = str(data["variant"]);
  const role = str(data["role"]);
  if (identity) parts.push(role ? `${identity} (${role})` : identity);
  if (variant) parts.push(role ? `${variant} (${role})` : variant);
  const trial = data["trial"];
  if (typeof trial === "number") parts.push(`trial ${trial}`);
  const status = data["status"];
  if (typeof status === "number") parts.push(`-> ${status}`);
  return parts.join(" ") || "in progress";
}

function describeCalibration(data: Record<string, unknown>): string {
  const statuses = data["denialStatuses"];
  if (Array.isArray(statuses)) return `calibrated: denial statuses ${statuses.join(", ") || "none"}`;
  if (data["stable"] === true) return `calibrated: protected state stable`;
  if (data["deterministic"] === true) return `calibrated: endpoint deterministic`;
  return "calibrated";
}

/** Real progress, expressed only in checks the runner said it planned. */
export const progressRatio = (view: ScanView): number =>
  view.plannedChecks === 0 ? (view.done ? 1 : 0) : Math.min(view.completedChecks / view.plannedChecks, 1);

/** Checks that produced no security verdict. Surfaced prominently so "0 findings" is not misread. */
export const untestedCount = (view: ScanView): number =>
  view.counts.inconclusive + view.counts.errored + view.counts.unavailable;
