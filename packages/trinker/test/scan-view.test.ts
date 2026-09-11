import { describe, expect, it } from "vitest";
import { runPlan, type HttpClient, type Oracle, type Plan, type RuntimeConfig, type ScanEvent } from "@trinker/core";
import { applyScanEvent, emptyScanView, progressRatio, untestedCount, type ScanView } from "../src/scan-view.js";

let sequence = 0;
const event = (type: ScanEvent["type"], data: Record<string, unknown> = {}): ScanEvent =>
  ({ version: 1, scanId: "scan_test", sequence: ++sequence, timestamp: "2026-09-11T00:00:00.000Z", type, data });

const fold = (...events: ScanEvent[]): ScanView => events.reduce(applyScanEvent, emptyScanView());

describe("scan view: derived only from real events", () => {
  it("starts empty with no progress", () => {
    const view = emptyScanView();
    expect(view).toMatchObject({ plannedChecks: 0, completedChecks: 0, done: false, findings: [] });
    expect(progressRatio(view)).toBe(0);
  });

  it("records the plan, target, and planned check count from scan.started", () => {
    const view = fold(
      event("scan.started", { planId: "trkp_x", targetRef: "local", plannedChecks: 3 }),
      event("phase.started", { phase: "deterministic-execution", target: "http://localhost:3000" }),
    );
    expect(view).toMatchObject({ planId: "trkp_x", targetRef: "local", plannedChecks: 3, target: "http://localhost:3000", phase: "deterministic-execution" });
  });

  it("tracks the currently executing check and clears it when the check resolves", () => {
    const running = fold(
      event("scan.started", { plannedChecks: 1 }),
      event("check.started", { checkId: "chk_a", oracle: "differential-authorization", routeId: "route_a" }),
    );
    expect(running.current).toMatchObject({ checkId: "chk_a", oracle: "differential-authorization", routeId: "route_a" });

    const finished = applyScanEvent(running, event("check.passed", { checkId: "chk_a", reason: "ok" }));
    expect(finished.current).toBeUndefined();
    expect(finished.counts.passed).toBe(1);
  });

  it("shows the identity and trial currently in flight", () => {
    const view = fold(
      event("check.started", { checkId: "chk_a", oracle: "differential-authorization", routeId: "route_a" }),
      event("check.progress", { checkId: "chk_a", identityId: "identity_peer", role: "denied", trial: 2, status: 403 }),
    );
    expect(view.current?.activity).toBe("identity_peer (denied) trial 2 -> 403");
  });

  it("shows the variant currently in flight for a metamorphic check", () => {
    const view = fold(
      event("check.started", { checkId: "chk_m", oracle: "metamorphic-response", routeId: "route_a" }),
      event("check.progress", { checkId: "chk_m", variant: "tampered-scope", role: "variant", status: 200 }),
    );
    expect(view.current?.activity).toBe("tampered-scope (variant) -> 200");
  });

  it("summarises each oracle's calibration in its own terms", () => {
    const start = event("check.started", { checkId: "chk_a", oracle: "x", routeId: "r" });
    expect(fold(start, event("oracle.calibrated", { denialStatuses: [401, 403] })).current?.activity).toMatch(/denial statuses 401, 403/);
    expect(fold(start, event("oracle.calibrated", { stable: true })).current?.activity).toMatch(/state stable/);
    expect(fold(start, event("oracle.calibrated", { deterministic: true })).current?.activity).toMatch(/deterministic/);
  });
});

describe("scan view: progress is real, never estimated", () => {
  it("advances only as checks complete", () => {
    let view = fold(event("scan.started", { plannedChecks: 4 }));
    expect(progressRatio(view)).toBe(0);
    view = applyScanEvent(view, event("check.passed", { checkId: "a" }));
    expect(progressRatio(view)).toBe(0.25);
    for (const id of ["b", "c", "d"]) view = applyScanEvent(view, event("check.passed", { checkId: id }));
    expect(progressRatio(view)).toBe(1);
  });

  it("does not exceed 1 if more outcomes arrive than were planned", () => {
    const view = fold(event("scan.started", { plannedChecks: 1 }), event("check.passed", {}), event("check.passed", {}));
    expect(progressRatio(view)).toBe(1);
  });

  it("reports a plan with no checks as complete only once the scan finishes", () => {
    expect(progressRatio(fold(event("scan.started", { plannedChecks: 0 })))).toBe(0);
    expect(progressRatio(fold(event("scan.started", { plannedChecks: 0 }), event("scan.completed", {})))).toBe(1);
  });
});

describe("scan view: untested checks stay visible", () => {
  it("counts every non-verdict outcome separately", () => {
    const view = fold(
      event("scan.started", { plannedChecks: 5 }),
      event("check.passed", { checkId: "a" }),
      event("check.inconclusive", { checkId: "b", reason: "no witness" }),
      event("check.errored", { checkId: "c", reason: "boom" }),
      event("check.unavailable", { checkId: "d", oracle: "out-of-band", reason: "no oracle" }),
      event("check.failed", { checkId: "e", reason: "matched" }),
    );
    expect(view.counts).toEqual({ passed: 1, failed: 1, inconclusive: 1, errored: 1, unavailable: 1 });
    expect(untestedCount(view)).toBe(3);
    expect(view.outcomes.map((outcome) => outcome.status)).toEqual(["passed", "inconclusive", "errored", "unavailable", "failed"]);
  });

  it("keeps the reason for each untested check so the console can explain it", () => {
    const view = fold(event("check.unavailable", { checkId: "d", oracle: "out-of-band", reason: "No oracle is registered" }));
    expect(view.outcomes[0]).toMatchObject({ checkId: "d", oracle: "out-of-band", reason: "No oracle is registered" });
  });
});

describe("scan view: findings and termination", () => {
  it("collects confirmed findings in order", () => {
    const view = fold(
      event("finding.confirmed", { findingId: "TRK-0001", severity: "high", title: "BOLA", routeId: "route_a" }),
      event("finding.confirmed", { findingId: "TRK-0002", severity: "critical", title: "Mutation", routeId: "route_b" }),
    );
    expect(view.findings.map((finding) => finding.findingId)).toEqual(["TRK-0001", "TRK-0002"]);
    expect(view.findings[1]).toMatchObject({ severity: "critical", title: "Mutation", routeId: "route_b" });
  });

  it("marks the scan done on completion", () => {
    expect(fold(event("scan.completed", {})).done).toBe(true);
  });

  it("surfaces a safety abort as a failure rather than a silent stop", () => {
    const view = fold(event("scan.started", { plannedChecks: 1 }), event("scan.failed", { reason: "Target example.com is blocked" }));
    expect(view.done).toBe(true);
    expect(view.failure).toBe("Target example.com is blocked");
    expect(view.current).toBeUndefined();
  });

  it("reports runtime token usage exactly as the runner reported it", () => {
    const view = fold(event("usage.updated", { runtimeInput: 0, runtimeOutput: 0, calls: 0 }));
    expect(view.tokens).toEqual({ runtimeInput: 0, runtimeOutput: 0, calls: 0 });
  });
});

describe("scan view: fed by a real scan", () => {
  const ROUTE = "route_get_orders_11111111";
  const plan: Plan = {
    schemaVersion: 1, planId: "trkp_demo", surfaceDigest: `sha256:${"a".repeat(64)}`,
    target: { applicationId: "demo", allowedTargetRefs: ["local"] },
    surface: { frameworks: ["express"], routes: [{ id: ROUTE, method: "GET", pathTemplate: "/orders", parameters: [], sourceRefs: [], confidence: "high" }], resources: [] },
    identities: [{ id: "identity_a", roles: [], capabilities: [] }, { id: "identity_b", roles: [], capabilities: [] }],
    fixtures: [],
    invariants: [{ id: "inv_a", kind: "authorization", statement: "s", routeIds: [ROUTE], provenance: "manual" }],
    checks: [{
      id: "chk_a", invariantId: "inv_a", enabled: true, oracle: "differential-authorization",
      request: { routeId: ROUTE, pathBindings: {}, queryBindings: {}, headerBindings: {} },
      allowedIdentityIds: ["identity_a"], deniedIdentityIds: ["identity_b"], calibration: { trials: 1 },
    }],
    coverage: { inScopeRouteIds: [ROUTE], exclusions: [] },
    safety: { mutationPolicy: "forbid", allowedMethods: ["GET"] },
    provenance: { sources: [], compiler: { mode: "manual", compilerVersion: "0.1.0" } },
  };
  const runtime: RuntimeConfig = { targets: { local: { url: "http://localhost:3000", allowHosts: [] } }, identities: {}, fixtures: {}, values: {}, mutationAuthorized: false };
  const http: HttpClient = { request: async () => ({ status: 200, headers: {}, body: "{}", elapsedMs: 1 }) };

  it("builds a complete view from the first event to the last", async () => {
    let view = emptyScanView();
    const oracle: Oracle = { name: "differential-authorization", execute: async () => ({ status: "passed", reason: "ok" }) };
    await runPlan({ plan, runtime, oracles: [oracle], http, scanId: "s", onEvent: (item) => { view = applyScanEvent(view, item); } }).result;

    expect(view.planId).toBe("trkp_demo");
    expect(view.target).toBe("http://localhost:3000");
    expect(view.plannedChecks).toBe(1);
    expect(view.counts.passed).toBe(1);
    expect(view.done).toBe(true);
    expect(progressRatio(view)).toBe(1);
    expect(untestedCount(view)).toBe(0);
  });

  it("shows an unregistered oracle as unavailable rather than as nothing happening", async () => {
    let view = emptyScanView();
    await runPlan({ plan, runtime, oracles: [], http, scanId: "s", onEvent: (item) => { view = applyScanEvent(view, item); } }).result;
    expect(view.counts.unavailable).toBe(1);
    expect(untestedCount(view)).toBe(1);
    expect(view.outcomes[0]?.reason).toMatch(/NOT tested/);
  });
});
