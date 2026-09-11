import { describe, expect, it, vi } from "vitest";
import {
  exitCodeForScan, isScanComplete, runPlan,
  type FindingDraft, type HttpClient, type HttpRequest, type HttpResponse, type Oracle, type ScanEvent,
} from "../src/index.js";
import { ROUTE_GET, authCheck, makePlan, makeRuntime } from "./fixtures.js";

const ok: HttpResponse = { status: 200, headers: {}, body: "{}", elapsedMs: 1 };
const client = (impl: (request: HttpRequest) => HttpResponse = () => ok): HttpClient => ({ request: async (request) => impl(request) });

const draft = (): FindingDraft => ({
  status: "confirmed", title: "Broken Object Level Authorization", severity: "high",
  invariant: "Only an owner may read the order.", routeId: ROUTE_GET, oracle: "Differential Authorization",
  verdict: "peer matched owner.", evidence: { requests: [], responses: [], notes: [] },
  replay: { checkId: "chk_order_auth" }, remediation: "Authorize.",
});

const oracleReturning = (result: Awaited<ReturnType<Oracle["execute"]>>): Oracle =>
  ({ name: "differential-authorization", execute: async () => result });
const oracleThrowing = (message: string): Oracle =>
  ({ name: "differential-authorization", execute: async () => { throw new Error(message); } });

const planWithCheck = () => makePlan({ checks: [authCheck()] });
const run = (oracles: Oracle[], plan = planWithCheck()) =>
  runPlan({ plan, runtime: makeRuntime(), oracles, http: client(), scanId: "scan_test" }).result;

describe("runner: replay commands (regression: reports told users to run TRK-0000)", () => {
  it("assigns the replay command from the id it actually assigned", async () => {
    const result = await run([oracleReturning({ status: "failed", finding: draft() })]);
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0]!;
    expect(finding.id).toBe("TRK-0001");
    expect(finding.replay.command).toBe("trinker verify TRK-0001");
    expect(finding.replay.checkId).toBe("chk_order_auth");
  });

  it("keeps ids and replay commands aligned across multiple findings", async () => {
    const plan = makePlan({ checks: [authCheck({ id: "chk_a" }), authCheck({ id: "chk_b" })] });
    const result = await run([oracleReturning({ status: "failed", finding: draft() })], plan);
    expect(result.findings.map((finding) => [finding.id, finding.replay.command])).toEqual([
      ["TRK-0001", "trinker verify TRK-0001"],
      ["TRK-0002", "trinker verify TRK-0002"],
    ]);
  });

  it("refuses to invent a finding when an oracle reports failure without evidence", async () => {
    const result = await run([oracleReturning({ status: "failed" })]);
    expect(result.findings).toHaveLength(0);
    expect(result.checks.errored).toBe(1);
    expect(result.outcomes[0]?.reason).toMatch(/without evidence/);
  });
});

describe("runner: outcome taxonomy (regression: everything non-passing collapsed into 'skipped')", () => {
  it("records a missing oracle as unavailable, never as a clean result", async () => {
    const result = await run([]);
    expect(result.checks).toMatchObject({ planned: 1, passed: 0, failed: 0, inconclusive: 0, errored: 0, unavailable: 1 });
    expect(result.outcomes[0]).toMatchObject({ status: "unavailable", checkId: "chk_order_auth" });
    expect(result.outcomes[0]?.reason).toMatch(/NOT tested/);
    expect(isScanComplete(result)).toBe(false);
  });

  it("records a thrown oracle as errored rather than swallowing it", async () => {
    const result = await run([oracleThrowing("connection refused")]);
    expect(result.checks.errored).toBe(1);
    expect(result.outcomes[0]).toMatchObject({ status: "errored", reason: "connection refused" });
  });

  it("distinguishes inconclusive from passed", async () => {
    const result = await run([oracleReturning({ status: "inconclusive", reason: "no witness" })]);
    expect(result.checks).toMatchObject({ inconclusive: 1, passed: 0 });
    expect(isScanComplete(result)).toBe(false);
  });

  it("marks a scan complete only when every check reached a verdict", async () => {
    const result = await run([oracleReturning({ status: "passed" })]);
    expect(result.checks.passed).toBe(1);
    expect(isScanComplete(result)).toBe(true);
  });

  it("emits a distinct event per outcome kind", async () => {
    const events: ScanEvent[] = [];
    const plan = makePlan({ checks: [authCheck()] });
    await runPlan({ plan, runtime: makeRuntime(), oracles: [], http: client(), scanId: "s", onEvent: (event) => events.push(event) }).result;
    expect(events.map((event) => event.type)).toContain("check.unavailable");
    expect(events.map((event) => event.type)).not.toContain("check.passed");
  });
});

describe("runner: CI exit codes", () => {
  it("exits 0 only for a complete scan with no findings", async () => {
    expect(exitCodeForScan(await run([oracleReturning({ status: "passed" })]))).toBe(0);
  });
  it("exits 1 when a violation is confirmed", async () => {
    expect(exitCodeForScan(await run([oracleReturning({ status: "failed", finding: draft() })]))).toBe(1);
  });
  it("exits 3 when a check had no oracle, so nothing was tested", async () => {
    expect(exitCodeForScan(await run([]))).toBe(3);
  });
  it("exits 3 when a check errored", async () => {
    expect(exitCodeForScan(await run([oracleThrowing("boom")]))).toBe(3);
  });
  it("treats inconclusive as 0 by default and 3 under --strict", async () => {
    const result = await run([oracleReturning({ status: "inconclusive", reason: "no witness" })]);
    expect(exitCodeForScan(result)).toBe(0);
    expect(exitCodeForScan(result, { strict: true })).toBe(3);
  });
  it("prefers a confirmed finding over a fault when reporting", async () => {
    const unavailableCheck = {
      id: "chk_b", invariantId: "inv_owner_only", enabled: true, oracle: "state-mutation",
      request: { routeId: ROUTE_GET, pathBindings: {}, queryBindings: {}, headerBindings: {} },
      readRequest: { routeId: ROUTE_GET, pathBindings: {}, queryBindings: {}, headerBindings: {} },
      protectedPaths: ["ownerId"], readIdentityId: "identity_owner", unauthorizedIdentityIds: ["identity_peer"],
    };
    const plan = makePlan({ checks: [authCheck({ id: "chk_a" }), unavailableCheck] });
    const result = await runPlan({ plan, runtime: makeRuntime(), oracles: [oracleReturning({ status: "failed", finding: draft() })], http: client(), scanId: "s" }).result;
    expect(result.checks.unavailable).toBe(1);
    expect(exitCodeForScan(result)).toBe(1);
  });
});

describe("runner: event stream completeness", () => {
  it("delivers the first and last events to a listener passed to runPlan", async () => {
    const events: ScanEvent[] = [];
    await runPlan({ plan: planWithCheck(), runtime: makeRuntime(), oracles: [oracleReturning({ status: "passed" })], http: client(), scanId: "s", onEvent: (event) => events.push(event) }).result;
    expect(events[0]?.type).toBe("scan.started");
    expect(events.at(-1)?.type).toBe("scan.completed");
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["scan.started", "phase.started", "usage.updated", "check.started", "check.passed", "scan.completed"]));
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
  });

  it("delivers the same complete stream to a listener that subscribes after the scan finished", async () => {
    const handle = runPlan({ plan: planWithCheck(), runtime: makeRuntime(), oracles: [oracleReturning({ status: "passed" })], http: client(), scanId: "s" });
    await handle.result;
    const events: ScanEvent[] = [];
    handle.subscribe((event) => events.push(event));
    expect(events[0]?.type).toBe("scan.started");
    expect(events.at(-1)?.type).toBe("scan.completed");
  });

  it("emits scan.failed when the safety preflight aborts, so consumers are not left waiting", async () => {
    const runtime = makeRuntime({ targets: { local: { url: "https://example.com", allowHosts: [] } } });
    const events: ScanEvent[] = [];
    const handle = runPlan({ plan: planWithCheck(), runtime, oracles: [], http: client(), scanId: "s", onEvent: (event) => events.push(event) });
    await expect(handle.result).rejects.toThrow(/blocked/);
    expect(events.map((event) => event.type)).toEqual(["scan.started", "scan.failed"]);
  });

  it("does not raise an unhandled rejection when only events are consumed", async () => {
    const runtime = makeRuntime({ targets: { local: { url: "https://example.com", allowHosts: [] } } });
    const spy = vi.fn();
    process.on("unhandledRejection", spy);
    const handle = runPlan({ plan: planWithCheck(), runtime, oracles: [], http: client(), scanId: "s" });
    const seen: string[] = [];
    for await (const event of handle.events) seen.push(event.type);
    await new Promise((resolve) => setImmediate(resolve));
    process.off("unhandledRejection", spy);
    expect(seen).toEqual(["scan.started", "scan.failed"]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("runner: determinism", () => {
  it("executes checks in check-id order regardless of declaration order", async () => {
    const plan = makePlan({ checks: [authCheck({ id: "chk_zebra" }), authCheck({ id: "chk_alpha" })] });
    const order: string[] = [];
    const oracle: Oracle = { name: "differential-authorization", execute: async (context) => { order.push(context.check.id); return { status: "passed" }; } };
    await runPlan({ plan, runtime: makeRuntime(), oracles: [oracle], http: client(), scanId: "s" }).result;
    expect(order).toEqual(["chk_alpha", "chk_zebra"]);
  });

  it("reports zero runtime LLM tokens", async () => {
    const result = await run([oracleReturning({ status: "passed" })]);
    expect(result.tokens).toEqual({ compileInput: 0, compileOutput: 0, runtimeInput: 0, runtimeOutput: 0, calls: 0 });
  });
});
