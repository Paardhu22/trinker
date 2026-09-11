import { randomUUID } from "node:crypto";
import type { Check, Plan, RuntimeConfig } from "./schema.js";
import {
  emptyCheckCounts, type CheckCounts, type CheckOutcome, type CheckStatus,
  type Finding, type FindingDraft, type ScanResult,
} from "./findings.js";
import { ScanEventBus, type ScanEvent } from "./events.js";
import { assertSafePlan, assertSafeTarget } from "./safety.js";

export interface HttpRequest { method: string; url: string; headers: Record<string, string>; body?: unknown; }
export interface HttpResponse { status: number; headers: Record<string, string>; body: string; elapsedMs: number; }
export interface HttpClient { request(request: HttpRequest): Promise<HttpResponse>; }
export interface OracleContext { plan: Plan; runtime: RuntimeConfig; check: Check; emit: (type: ScanEvent["type"], data: Record<string, unknown>) => void; http: HttpClient; }

/**
 * What an oracle may conclude.
 *
 * There is deliberately no "skipped": an oracle that cannot reach a verdict reports
 * `inconclusive` and says why, and an oracle that malfunctions throws. Neither is ever silently
 * folded into a clean result.
 */
export interface OracleResult {
  status: "passed" | "failed" | "inconclusive";
  /** Required when status is "failed" — a failure without mechanical evidence is not a finding. */
  finding?: FindingDraft;
  reason?: string;
}
export interface Oracle { name: Check["oracle"]; execute(context: OracleContext): Promise<OracleResult>; }

export class FetchHttpClient implements HttpClient {
  public constructor(private readonly timeoutMs = 15_000) {}
  async request(request: HttpRequest): Promise<HttpResponse> {
    const started = performance.now();
    const init: RequestInit = { method: request.method, headers: { ...request.headers }, signal: AbortSignal.timeout(this.timeoutMs) };
    if (request.body !== undefined) {
      init.body = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
      if (!Object.keys(request.headers).some((name) => name.toLowerCase() === "content-type")) {
        (init.headers as Record<string, string>)["content-type"] = "application/json";
      }
    }
    const response = await fetch(request.url, init);
    const headers = Object.fromEntries(response.headers.entries());
    return { status: response.status, headers, body: await response.text(), elapsedMs: performance.now() - started };
  }
}

export interface RunOptions {
  plan: Plan;
  runtime: RuntimeConfig;
  oracles: Oracle[];
  http?: HttpClient;
  scanId?: string;
  now?: () => Date;
  /**
   * Attached before the first event is emitted. Equivalent to `subscribe` on the returned handle,
   * which also replays the backlog — both observe the complete sequence.
   */
  onEvent?: (event: ScanEvent) => void;
}
export interface ScanHandle {
  events: AsyncIterable<ScanEvent>;
  subscribe(listener: (event: ScanEvent) => void): () => void;
  result: Promise<ScanResult>;
}

export function runPlan(options: RunOptions): ScanHandle {
  const scanId = options.scanId ?? `scan_${randomUUID()}`;
  const bus = new ScanEventBus(scanId, options.now);
  if (options.onEvent) bus.subscribe(options.onEvent);
  const result = execute(options, bus, scanId);
  // The handle always exposes `result`; attach a no-op catch so a caller that only consumes events
  // does not trip an unhandled rejection when the safety preflight aborts the scan.
  result.catch(() => undefined);
  return { events: bus, subscribe: (listener) => bus.subscribe(listener), result };
}

const EVENT_FOR_STATUS: Record<CheckStatus, ScanEvent["type"]> = {
  passed: "check.passed",
  failed: "check.failed",
  inconclusive: "check.inconclusive",
  errored: "check.errored",
  unavailable: "check.unavailable",
};

async function execute(options: RunOptions, bus: ScanEventBus, scanId: string): Promise<ScanResult> {
  const { plan, runtime } = options;
  const started = new Date();
  const enabled = plan.checks.filter((check) => check.enabled).sort((a, b) => a.id.localeCompare(b.id));
  const counts: CheckCounts = emptyCheckCounts(enabled.length);
  const outcomes: CheckOutcome[] = [];
  const findings: Finding[] = [];

  bus.emit("scan.started", { planId: plan.planId, targetRef: plan.target.allowedTargetRefs[0], plannedChecks: counts.planned, runtimeTokens: 0 });

  let target: URL;
  try {
    assertSafePlan(plan, runtime);
    target = assertSafeTarget(plan, runtime);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown safety failure";
    bus.emit("scan.failed", { phase: "safety-preflight", reason: message });
    throw error;
  }

  bus.emit("phase.started", { phase: "deterministic-execution", target: target.origin });
  bus.emit("usage.updated", { compileInput: 0, compileOutput: 0, runtimeInput: 0, runtimeOutput: 0, calls: 0 });

  const oracleByName = new Map(options.oracles.map((oracle) => [oracle.name, oracle]));
  const http = options.http ?? new FetchHttpClient();

  for (const check of enabled) {
    bus.emit("check.started", { checkId: check.id, oracle: check.oracle, routeId: check.request.routeId });
    const record = (status: CheckStatus, reason: string, findingId?: string): void => {
      counts[status]++;
      const outcome: CheckOutcome = { checkId: check.id, routeId: check.request.routeId, oracle: check.oracle, status, reason };
      if (findingId !== undefined) outcome.findingId = findingId;
      outcomes.push(outcome);
      bus.emit(EVENT_FOR_STATUS[status], { checkId: check.id, oracle: check.oracle, routeId: check.request.routeId, reason, ...(findingId ? { findingId } : {}) });
    };

    const oracle = oracleByName.get(check.oracle);
    if (!oracle) {
      record("unavailable", `No oracle is registered for "${check.oracle}". This check was NOT tested.`);
      continue;
    }

    try {
      const outcome = await oracle.execute({ plan, runtime, check, http, emit: (type, data) => bus.emit(type, data) });
      if (outcome.status === "failed") {
        if (!outcome.finding) {
          record("errored", `Oracle "${check.oracle}" reported a failure without evidence, which cannot become a finding.`);
          continue;
        }
        const id = `TRK-${String(findings.length + 1).padStart(4, "0")}`;
        // The runner owns the id, so it also owns the replay command. An oracle cannot desynchronise them.
        const finding: Finding = { ...outcome.finding, id, replay: { checkId: outcome.finding.replay.checkId, command: `trinker verify ${id}` } };
        findings.push(finding);
        bus.emit("finding.confirmed", { findingId: id, severity: finding.severity, checkId: check.id, routeId: finding.routeId, title: finding.title });
        record("failed", outcome.reason ?? "Oracle confirmed a violation", id);
      } else if (outcome.status === "passed") {
        record("passed", outcome.reason ?? "Invariant held");
      } else {
        record("inconclusive", outcome.reason ?? "Oracle could not reach a verdict");
      }
    } catch (error) {
      record("errored", error instanceof Error ? error.message : "Unknown execution error");
    }
  }

  const completed = new Date();
  const result: ScanResult = {
    scanId, planId: plan.planId,
    startedAt: started.toISOString(), completedAt: completed.toISOString(),
    durationMs: completed.valueOf() - started.valueOf(),
    checks: counts, outcomes, findings,
    tokens: { compileInput: 0, compileOutput: 0, runtimeInput: 0, runtimeOutput: 0, calls: 0 },
  };
  bus.emit("scan.completed", {
    checks: counts, findings: findings.length, durationMs: result.durationMs, runtimeTokens: 0,
    untested: counts.inconclusive + counts.errored + counts.unavailable,
  });
  return result;
}
