import { randomUUID } from "node:crypto";
import type { Check, Plan, RuntimeConfig } from "./schema.js";
import type { Finding, ScanResult } from "./findings.js";
import { ScanEventBus, type ScanEvent } from "./events.js";
import { assertSafePlan, assertSafeTarget } from "./safety.js";

export interface HttpRequest { method: string; url: string; headers: Record<string, string>; body?: unknown; }
export interface HttpResponse { status: number; headers: Record<string, string>; body: string; elapsedMs: number; }
export interface HttpClient { request(request: HttpRequest): Promise<HttpResponse>; }
export interface OracleContext { plan: Plan; runtime: RuntimeConfig; check: Check; emit: (type: ScanEvent["type"], data: Record<string, unknown>) => void; http: HttpClient; }
export interface OracleResult { status: "passed" | "failed" | "skipped"; finding?: Finding; reason?: string; }
export interface Oracle { name: Check["oracle"]; execute(context: OracleContext): Promise<OracleResult>; }

export class FetchHttpClient implements HttpClient {
  async request(request: HttpRequest): Promise<HttpResponse> {
    const started = performance.now();
    const init: RequestInit = { method: request.method, headers: request.headers };
    if (request.body !== undefined) init.body = JSON.stringify(request.body);
    const response = await fetch(request.url, init);
    const headers = Object.fromEntries(response.headers.entries());
    return { status: response.status, headers, body: await response.text(), elapsedMs: performance.now() - started };
  }
}

export interface RunOptions { plan: Plan; runtime: RuntimeConfig; oracles: Oracle[]; http?: HttpClient; scanId?: string; now?: () => Date; }
export interface ScanHandle { events: AsyncIterable<ScanEvent>; subscribe(listener: (event: ScanEvent) => void): () => void; result: Promise<ScanResult>; }

export function runPlan(options: RunOptions): ScanHandle {
  const scanId = options.scanId ?? `scan_${randomUUID()}`;
  const bus = new ScanEventBus(scanId, options.now);
  const result = execute(options, bus, scanId);
  return { events: bus, subscribe: (listener) => bus.subscribe(listener), result };
}

async function execute(options: RunOptions, bus: ScanEventBus, scanId: string): Promise<ScanResult> {
  const { plan, runtime } = options;
  const started = new Date();
  const counts = { planned: plan.checks.filter((check) => check.enabled).length, passed: 0, failed: 0, skipped: 0 };
  const findings: Finding[] = [];
  bus.emit("scan.started", { planId: plan.planId, targetRef: plan.target.allowedTargetRefs[0], plannedChecks: counts.planned, runtimeTokens: 0 });
  assertSafePlan(plan, runtime);
  const target = assertSafeTarget(plan, runtime);
  bus.emit("phase.started", { phase: "deterministic-execution", target: target.origin });
  bus.emit("usage.updated", { compileInput: 0, compileOutput: 0, runtimeInput: 0, runtimeOutput: 0, calls: 0 });
  const oracleByName = new Map(options.oracles.map((oracle) => [oracle.name, oracle]));
  for (const check of plan.checks.filter((candidate) => candidate.enabled).sort((a, b) => a.id.localeCompare(b.id))) {
    const oracle = oracleByName.get(check.oracle);
    bus.emit("check.started", { checkId: check.id, oracle: check.oracle, routeId: check.request.routeId });
    if (!oracle) {
      counts.skipped++;
      bus.emit("check.skipped", { checkId: check.id, reason: `Oracle unavailable: ${check.oracle}` });
      continue;
    }
    try {
      const outcome = await oracle.execute({ plan, runtime, check, http: options.http ?? new FetchHttpClient(), emit: (type, data) => bus.emit(type, data) });
      if (outcome.status === "passed") { counts.passed++; bus.emit("check.passed", { checkId: check.id, reason: outcome.reason ?? "Oracle passed" }); }
      if (outcome.status === "skipped") { counts.skipped++; bus.emit("check.skipped", { checkId: check.id, reason: outcome.reason ?? "Oracle skipped" }); }
      if (outcome.status === "failed") {
        counts.failed++;
        if (outcome.finding) {
          const finding = { ...outcome.finding, id: `TRK-${String(findings.length + 1).padStart(4, "0")}` };
          findings.push(finding);
          bus.emit("finding.confirmed", { findingId: finding.id, severity: finding.severity, checkId: check.id });
        }
        bus.emit("check.failed", { checkId: check.id, reason: outcome.reason ?? "Oracle failed" });
      }
    } catch (error) { counts.skipped++; bus.emit("check.skipped", { checkId: check.id, reason: error instanceof Error ? error.message : "Unknown execution error" }); }
  }
  const completed = new Date();
  const result: ScanResult = { scanId, planId: plan.planId, startedAt: started.toISOString(), completedAt: completed.toISOString(), durationMs: completed.valueOf() - started.valueOf(), checks: counts, findings, tokens: { compileInput: 0, compileOutput: 0, runtimeInput: 0, runtimeOutput: 0, calls: 0 } };
  bus.emit("scan.completed", { checks: counts, findings: findings.length, durationMs: result.durationMs, runtimeTokens: 0 });
  return result;
}
