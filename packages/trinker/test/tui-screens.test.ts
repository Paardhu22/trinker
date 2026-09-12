import { describe, expect, it } from "vitest";
import { runPlan, type Finding, type HttpClient, type Oracle, type Plan, type RuntimeConfig, type ScanEvent } from "@trinker/core";
import type { SecurityReport } from "@trinker/report";
import { applyScanEvent, emptyScanView, type ScanView } from "../src/scan-view.js";
import { stripAnsi } from "../src/tui/render.js";
import {
  compilerScreen, configScreen, coverageScreen, dashboardScreen, estimateCost, exportScreen,
  findingDetailScreen, findingsScreen, helpScreen, reportScreen, scanScreen, validationChecklist, wrap,
} from "../src/tui/screens.js";
import type { DashboardModel, RecordedProposal } from "../src/workflow.js";

const text = (lines: string[]): string => lines.map(stripAnsi).join("\n");

const dashboard = (overrides: Partial<DashboardModel> = {}): DashboardModel => ({
  planPath: "/app/.trinker/plan.json",
  planId: "trkp_x",
  applicationId: "juice-shop",
  targetRef: "local",
  targetUrl: "http://localhost:3000",
  lastScanAt: new Date(Date.now() - 30_000).toISOString(),
  status: "findings",
  routes: 5, checks: 7, passed: 3, findings: 4, untested: 0,
  verifiedPercent: 71, plannedPercent: 100, runtimeTokens: 0,
  oracles: ["differential-authorization", "state-mutation", "metamorphic-response"],
  recentFindings: [
    { id: "TRK-0002", severity: "high", title: "BOLA - cross-customer read", method: "GET", path: "/api/BasketItems/:id", oracle: "Differential Authorization" },
    { id: "TRK-0003", severity: "medium", title: "Scope tampering", method: "GET", path: "/api/BasketItems", oracle: "Metamorphic Response" },
  ],
  ...overrides,
});

describe("dashboard", () => {
  it("shows target, plan, last scan, and status", () => {
    const rendered = text(dashboardScreen(dashboard(), 70));
    expect(rendered).toContain("http://localhost:3000");
    expect(rendered).toContain("FINDINGS");
    expect(rendered).toMatch(/Last scan\s+\d+s ago/);
  });

  it("shows the metrics row with real values", () => {
    const rendered = text(dashboardScreen(dashboard(), 70));
    expect(rendered).toContain("ROUTES");
    expect(rendered).toContain("RUNTIME LLM");
    expect(rendered).toContain("71%");
    expect(rendered).toContain("0 tok");
  });

  it("lists recent findings with severity, id, title, and endpoint", () => {
    const rendered = text(dashboardScreen(dashboard(), 70));
    expect(rendered).toContain("HIGH");
    expect(rendered).toContain("TRK-0002");
    expect(rendered).toContain("BOLA - cross-customer read");
    expect(rendered).toContain("GET /api/BasketItems/:id");
  });

  it("says there is no scan rather than showing a fabricated coverage figure", () => {
    const rendered = text(dashboardScreen(dashboard({
      lastScanAt: undefined, status: "no-scan", verifiedPercent: undefined,
      passed: 0, findings: 0, untested: 0, recentFindings: [],
    }), 70));
    expect(rendered).toContain("never");
    expect(rendered).toContain("NOT SCANNED");
    expect(rendered).toContain("No scan has been run yet.");
    expect(rendered).not.toMatch(/\d+%/);
  });

  it("reports a broken plan instead of rendering an empty dashboard", () => {
    const rendered = text(dashboardScreen(dashboard({ problem: "plan.json is invalid: checks.0: Required" }), 70));
    expect(rendered).toContain("could not be read");
    expect(rendered).toContain("checks.0: Required");
  });
});

/* --------------------------------------------------------------- live scan */

const ROUTE = "route_get_orders_1";
const plan: Plan = {
  schemaVersion: 1, planId: "trkp_x", surfaceDigest: `sha256:${"a".repeat(64)}`,
  target: { applicationId: "a", allowedTargetRefs: ["local"] },
  surface: { frameworks: ["express"], routes: [{ id: ROUTE, method: "GET", pathTemplate: "/o/:id", parameters: [], sourceRefs: [], confidence: "high" }], resources: [] },
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

describe("live scan receives the complete event lifecycle", () => {
  /**
   * Regression for the session-1 subscription race, asserted at the layer the console actually
   * uses: a listener handed to `runPlan` must observe every event from sequence 1, with no gaps.
   */
  it("observes every lifecycle event, in order, with no gaps", async () => {
    const seen: ScanEvent[] = [];
    const oracle: Oracle = {
      name: "differential-authorization",
      execute: async (context) => {
        context.emit("check.progress", { checkId: context.check.id, identityId: "identity_b", status: 200 });
        context.emit("oracle.calibrated", { checkId: context.check.id, denialStatuses: [200] });
        return { status: "passed", reason: "ok" };
      },
    };
    await runPlan({ plan, runtime, oracles: [oracle], http, scanId: "s", onEvent: (event) => seen.push(event) }).result;

    const types = seen.map((event) => event.type);
    expect(types[0]).toBe("scan.started");
    expect(types.at(-1)).toBe("scan.completed");
    expect(types).toEqual(expect.arrayContaining([
      "scan.started", "phase.started", "usage.updated", "check.started",
      "check.progress", "oracle.calibrated", "check.passed", "scan.completed",
    ]));
    // Sequence numbers are core-owned and must be contiguous from 1.
    expect(seen.map((event) => event.sequence)).toEqual(seen.map((_, index) => index + 1));
  });

  it("renders a live view built from those events, never raw JSON", async () => {
    let view: ScanView = emptyScanView();
    const oracle: Oracle = { name: "differential-authorization", execute: async () => ({ status: "failed", finding: finding("TRK-0001") as never, reason: "matched" }) };
    await runPlan({ plan, runtime, oracles: [oracle], http, scanId: "s", onEvent: (event) => { view = applyScanEvent(view, event); } }).result;

    const rendered = text(scanScreen({ view, plannedCheckIds: ["chk_a"], elapsedMs: 1200, width: 70, height: 30 }));
    expect(rendered).toContain("http://localhost:3000");
    expect(rendered).toContain("1/1");
    expect(rendered).toContain("chk_a");
    expect(rendered).toContain("FAILED");
    expect(rendered).toContain("TRK-0001");
    expect(rendered).not.toContain("{\"");
  });

  it("shows planned checks as pending before they run, and running while in flight", () => {
    const started = applyScanEvent(
      applyScanEvent(emptyScanView(), event("scan.started", { plannedChecks: 2 })),
      event("check.started", { checkId: "chk_a", oracle: "differential-authorization", routeId: ROUTE }),
    );
    const rendered = text(scanScreen({ view: started, plannedCheckIds: ["chk_a", "chk_b"], elapsedMs: 0, width: 70, height: 30 }));
    expect(rendered).toMatch(/chk_a\s+RUNNING/);
    expect(rendered).toMatch(/chk_b\s+PENDING/);
  });

  it("surfaces a safety abort rather than a silent stop", () => {
    const aborted = applyScanEvent(emptyScanView(), event("scan.failed", { reason: "Target example.com is blocked" }));
    expect(text(scanScreen({ view: aborted, plannedCheckIds: [], elapsedMs: 0, width: 70, height: 20 })))
      .toContain("Scan aborted: Target example.com is blocked");
  });

  it("warns when checks produced no verdict", () => {
    let view = applyScanEvent(emptyScanView(), event("scan.started", { plannedChecks: 1 }));
    view = applyScanEvent(view, event("check.unavailable", { checkId: "chk_x", reason: "no oracle" }));
    view = applyScanEvent(view, event("scan.completed", {}));
    expect(text(scanScreen({ view, plannedCheckIds: ["chk_x"], elapsedMs: 0, width: 70, height: 20 })))
      .toContain("did not test everything");
  });

  it("displays checkLabels next to check identifiers", () => {
    const started = applyScanEvent(
      applyScanEvent(emptyScanView(), event("scan.started", { plannedChecks: 1 })),
      event("check.started", { checkId: "chk_a", oracle: "differential-authorization", routeId: ROUTE }),
    );
    const rendered = text(scanScreen({
      view: started,
      plannedCheckIds: ["chk_a"],
      checkLabels: { chk_a: "GET /api/BasketItems/:id" },
      elapsedMs: 0,
      width: 80,
      height: 30,
    }));
    expect(rendered).toContain("chk_a");
    expect(rendered).toContain("GET /api/BasketItems/:id");
    expect(rendered).toContain("RUNNING");
  });
});

let sequence = 0;
const event = (type: ScanEvent["type"], data: Record<string, unknown> = {}): ScanEvent =>
  ({ version: 1, scanId: "s", sequence: ++sequence, timestamp: "", type, data });

/* ---------------------------------------------------------------- findings */

function finding(id: string, overrides: Partial<Finding> = {}): Finding {
  return {
    id, status: "confirmed", title: "Broken Object Level Authorization", severity: "high",
    invariant: "Only the owner may read the order.", routeId: ROUTE, oracle: "Differential Authorization",
    verdict: "identity_b received the exact successful response returned to identity_a.",
    evidence: {
      requests: [{ method: "GET", url: "http://localhost:3000/o/42", headers: { authorization: "[REDACTED]" } }],
      responses: [{ status: 200, headers: {}, bodyDigest: "sha256:abc", bodyPreview: '{"id":"42"}' }],
      notes: ["Byte-equivalent witness."],
    },
    replay: { command: `trinker verify ${id}`, checkId: "chk_a" }, remediation: "Authorize.",
    ...overrides,
  };
}

const routeLabel = (): string => "GET /o/:id";

describe("findings list", () => {
  const many = Array.from({ length: 30 }, (_, index) => finding(`TRK-${String(index + 1).padStart(4, "0")}`));

  it("shows an empty state rather than a blank panel", () => {
    expect(text(findingsScreen({ findings: [], routeLabel, selected: 0, query: "", searching: false, width: 70, height: 20 })))
      .toContain("No mechanically confirmed findings.");
  });

  it("marks the selected row and shows its endpoint", () => {
    const rendered = text(findingsScreen({ findings: many.slice(0, 3), routeLabel, selected: 1, query: "", searching: false, width: 70, height: 20 }));
    expect(rendered).toContain("TRK-0002");
    expect(rendered).toContain("GET /o/:id");
    expect(rendered.split("\n").some((line) => line.includes("❯") && line.includes("TRK-0002"))).toBe(true);
  });

  it("scrolls a long list and keeps a selection beyond nine on screen", () => {
    // Regression: selection used to be limited to a single digit, so findings past 9 were unreachable.
    const rendered = text(findingsScreen({ findings: many, routeLabel, selected: 23, query: "", searching: false, width: 70, height: 24 }));
    expect(rendered).toContain("TRK-0024");
    expect(rendered).toContain("of 30");
  });

  it("shows the active filter", () => {
    const rendered = text(findingsScreen({ findings: many.slice(0, 2), routeLabel, selected: 0, query: "bola", searching: true, width: 70, height: 20 }));
    expect(rendered).toContain("bola");
    expect(rendered).toContain("match(es)");
  });
});

describe("finding detail", () => {
  it("shows identity, evidence, digests, and the replay command", () => {
    const rendered = text(findingDetailScreen(finding("TRK-0001"), "GET /o/:id", 70));
    expect(rendered).toContain("TRK-0001");
    expect(rendered).toContain("HIGH");
    expect(rendered).toContain("GET /o/:id");
    expect(rendered).toContain("Differential Authorization");
    expect(rendered).toContain("chk_a");
    expect(rendered).toContain("sha256:abc");
    expect(rendered).toContain("trinker verify TRK-0001");
  });

  it("renders redacted headers as redacted and never a raw credential", () => {
    const rendered = text(findingDetailScreen(finding("TRK-0001"), "GET /o/:id", 70));
    expect(rendered).toContain("authorization: [REDACTED]");
    expect(rendered).not.toMatch(/Bearer\s+\S/);
  });

  it("masks sensitive tokens or leaked API keys in raw evidence", () => {
    const rawWithSecret = finding("TRK-0001", {
      evidence: {
        notes: ["Witness note with sk-proj-abc12345678901234567890"],
        requests: [{ method: "GET", url: "http://localhost:3000/api/items", headers: { "x-auth-header": "Bearer secret-token-xyz123" } }],
        responses: [{ status: 200, headers: {}, bodyDigest: "sha256:abc", bodyPreview: '{"key": "sk-ant-api03-abcdefghijklmnopq12345678"}' }],
      },
    });
    const rendered = text(findingDetailScreen(rawWithSecret, "GET /o/:id", 70));
    expect(rendered).not.toContain("secret-token-xyz123");
    expect(rendered).not.toContain("sk-proj-abc");
    expect(rendered).toContain("Bearer [REDACTED]");
    expect(rendered).toContain("[REDACTED_KEY]");
  });

  it("wraps long prose instead of overflowing the panel", () => {
    const long = finding("TRK-0001", { verdict: "word ".repeat(120).trim() });
    for (const line of findingDetailScreen(long, "GET /o/:id", 60)) {
      expect(stripAnsi(line).length).toBeLessThanOrEqual(62);
    }
  });

  it("scrolls from an offset", () => {
    const full = findingDetailScreen(finding("TRK-0001"), "GET /o/:id", 70);
    expect(findingDetailScreen(finding("TRK-0001"), "GET /o/:id", 70, 5)).toEqual(full.slice(5));
  });
});

describe("wrap", () => {
  it("never exceeds the width and preserves the indent", () => {
    for (const line of wrap("alpha beta gamma delta epsilon zeta eta theta", 24, "  ")) {
      expect(line.length).toBeLessThanOrEqual(24);
      expect(line.startsWith("  ")).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ report */

const report = (overrides: Record<string, unknown> = {}): SecurityReport => ({
  generatedAt: new Date().toISOString(),
  plan: { planId: "trkp_x", surfaceDigest: "sha256:x" },
  coverage: { inScopeRoutes: 5, coveredRoutes: 5, uncoveredRouteIds: [], percent: 100, verifiedRoutes: 4, verifiedPercent: 80, unverifiedRouteIds: ["r"], inconclusiveRouteIds: ["r"], erroredRouteIds: [], unavailableRouteIds: [] },
  result: {
    scanId: "scan_1", planId: "trkp_x", startedAt: "", completedAt: "", durationMs: 247,
    checks: { planned: 5, passed: 2, failed: 3, inconclusive: 0, errored: 0, unavailable: 0 },
    outcomes: [], findings: [finding("TRK-0001")],
    tokens: { compileInput: 0, compileOutput: 0, runtimeInput: 0, runtimeOutput: 0, calls: 0 },
    ...overrides,
  },
}) as never;

describe("report view", () => {
  it("renders a readable summary rather than JSON", () => {
    const rendered = text(reportScreen(report() as never, 70));
    expect(rendered).toContain("CHECKS");
    expect(rendered).toContain("FINDINGS BY SEVERITY");
    expect(rendered).toContain("HIGH (1)");
    expect(rendered).not.toContain('{"');
  });

  it("calls out checks that produced no verdict", () => {
    const withGap = report({
      checks: { planned: 2, passed: 1, failed: 0, inconclusive: 1, errored: 0, unavailable: 0 },
      findings: [],
      outcomes: [{ checkId: "chk_gap", routeId: "r", oracle: "state-mutation", status: "inconclusive", reason: "state already changed" }],
    });
    const rendered = text(reportScreen(withGap as never, 70));
    expect(rendered).toContain("PRODUCED NO VERDICT");
    expect(rendered).toContain("chk_gap");
    expect(rendered).toContain("state already changed");
  });
});

/* ---------------------------------------------------------------- coverage */

describe("coverage", () => {
  const planned = { inScopeRoutes: 5, coveredRoutes: 4, uncoveredRouteIds: ["route_x"], percent: 80 };

  it("reports factual oracle usage, not invented percentages", () => {
    const rendered = text(coverageScreen({
      planned, executed: undefined,
      outcomes: [{ checkId: "c", routeId: "r", oracle: "differential-authorization", status: "passed", reason: "" }],
      oracles: ["differential-authorization", "state-mutation", "metamorphic-response"], width: 70,
    }));
    expect(rendered).toContain("1/1 reached a verdict");
    expect(rendered).toContain("no checks use this oracle");
    expect(rendered).toContain("unknown — no scan has been run yet");
  });

  it("lists the unimplemented oracles honestly", () => {
    const rendered = text(coverageScreen({ planned, outcomes: [], oracles: ["differential-authorization"], width: 70 }));
    expect(rendered).toContain("browser-execution");
    expect(rendered).toContain("out-of-band");
    expect(rendered).toContain("not implemented");
  });

  it("names routes with no check", () => {
    expect(text(coverageScreen({ planned, outcomes: [], oracles: [], width: 70 }))).toContain("route_x");
  });
});

/* ----------------------------------------------------------- configuration */

describe("configuration", () => {
  const runtimeConfig: RuntimeConfig = {
    targets: { local: { url: "http://localhost:3000", allowHosts: [] } },
    identities: { owner: { headers: { authorization: "Bearer SUPER-SECRET-TOKEN" } } },
    fixtures: { order: { id: "42" } },
    values: { apiToken: "ANOTHER-SECRET" },
    mutationAuthorized: true,
  };

  it("never renders a credential value", () => {
    const rendered = text(configScreen(runtimeConfig, undefined, "/app/.trinker/runtime.json", 70));
    expect(rendered).not.toContain("SUPER-SECRET-TOKEN");
    expect(rendered).not.toContain("ANOTHER-SECRET");
    expect(rendered).toContain("authorization");
    expect(rendered).toContain("[values hidden]");
    expect(rendered).toContain("apiToken");
  });

  it("shows targets, fixtures, and the mutation flag", () => {
    const rendered = text(configScreen(runtimeConfig, undefined, "/p", 70));
    expect(rendered).toContain("http://localhost:3000");
    expect(rendered).toContain("order");
    expect(rendered).toContain("authorized");
  });

  it("reports an invalid config instead of a blank screen", () => {
    expect(text(configScreen(undefined, "runtime.json is invalid: targets: Required", "/p", 70)))
      .toContain("targets: Required");
  });
});

/* ---------------------------------------------------------------- compiler */

const proposal = (): RecordedProposal => ({
  basePlanId: "trkp_x",
  record: {
    provider: "openai:gpt-5.6-terra", model: "gpt-5.6-terra", promptVersion: "2026-09-11.1+openai-wire.1",
    inputTokens: 3680, outputTokens: 812, totalTokens: 4492, tokenBudget: 40000,
    checksProposed: 2, checksAccepted: 1, checksRejected: 1, routesConsidered: 5,
  },
  added: { identities: [], fixtures: [], invariants: ["inv_new"], checks: ["chk_new"] },
  rejected: [{ kind: "check", id: "chk_ghost", reason: 'Oracle "out-of-band" has no implementation' }],
  rationales: { chk_new: "The route takes an :id path parameter." },
  notes: [],
  plan: {
    ...plan,
    identities: [...plan.identities],
    invariants: [...plan.invariants, { id: "inv_new", kind: "authorization", statement: "s", routeIds: [ROUTE], provenance: "llm-assisted" }],
    checks: [...plan.checks, {
      id: "chk_new", invariantId: "inv_new", enabled: true, oracle: "differential-authorization",
      request: { routeId: ROUTE, pathBindings: {}, queryBindings: {}, headerBindings: {} },
      allowedIdentityIds: ["identity_a"], deniedIdentityIds: ["identity_b"], calibration: { trials: 3 },
    }],
  } as Plan,
});

describe("AI compiler screen", () => {
  it("prompts to compile when nothing is recorded", () => {
    const rendered = text(compilerScreen({ proposal: undefined, planLabel: routeLabel, width: 70 }));
    expect(rendered).toContain("No proposal recorded yet.");
    expect(rendered).toContain("A scan never contacts a provider.");
  });

  it("shows provider, model, tokens, budget, and cost", () => {
    const rendered = text(compilerScreen({ proposal: proposal(), planLabel: routeLabel, width: 70 }));
    expect(rendered).toContain("openai:gpt-5.6-terra");
    expect(rendered).toContain("4,492 / 40,000");
    expect(rendered).toContain("~$0.017");
  });

  it("shows proposed, accepted, and rejected counts with the rejection reason", () => {
    const rendered = text(compilerScreen({ proposal: proposal(), planLabel: routeLabel, width: 70 }));
    expect(rendered).toContain("PROPOSED");
    expect(rendered).toContain("REJECTED BY VALIDATION");
    expect(rendered).toContain("has no implementation");
  });

  it("describes each proposed check and why it was proposed", () => {
    const rendered = text(compilerScreen({ proposal: proposal(), planLabel: routeLabel, width: 70 }));
    expect(rendered).toContain("chk_new");
    expect(rendered).toContain("GET /o/:id");
    expect(rendered).toContain("oracle differential-authorization");
    expect(rendered).toContain(":id path parameter");
  });

  it("states the approval gate and that applying makes no model call", () => {
    const rendered = text(compilerScreen({ proposal: proposal(), planLabel: routeLabel, width: 70 }));
    expect(rendered).toContain("AI-GENERATED PROPOSAL");
    expect(rendered).toContain("VALIDATED BY TRINKER");
    expect(rendered).toContain("WAITING FOR YOUR APPROVAL");
    expect(rendered).toContain("makes no further model call");
  });

  it("reports a compilation failure instead of an empty panel", () => {
    expect(text(compilerScreen({ proposal: undefined, planLabel: routeLabel, width: 70, error: "OPENAI_API_KEY is not set." })))
      .toContain("OPENAI_API_KEY is not set.");
  });
});

describe("validation checklist", () => {
  it("reports every reference resolving for a clean proposal", () => {
    expect(Object.fromEntries(validationChecklist(proposal()))).toMatchObject({
      "route resolved": true, "identity resolved": true, "fixture resolved": true,
      "safety policy unchanged": true, "no secrets detected": true,
    });
  });

  it("flags a secret if one ever reached the proposal", () => {
    const dirty = proposal();
    dirty.rationales["chk_new"] = "use Bearer sk-ant-leaked";
    expect(Object.fromEntries(validationChecklist(dirty))["no secrets detected"]).toBe(false);
  });
});

describe("cost estimate", () => {
  it("prices known models and declines to guess for unknown ones", () => {
    expect(estimateCost("gpt-5.6-terra", 3680, 812)).toBe("~$0.017");
    expect(estimateCost("claude-opus-5", 1_000_000, 0)).toBe("~$5.000");
    expect(estimateCost("some-future-model", 1000, 1000)).toBe("—");
  });
});

describe("export", () => {
  it("offers only formats that exist", () => {
    const rendered = text(exportScreen(undefined, 70));
    expect(rendered).toContain("Markdown");
    expect(rendered).toContain("JSON");
    expect(rendered).toContain("SARIF");
  });

  it("confirms with the real path", () => {
    expect(text(exportScreen("/app/.trinker/reports/2026-09-11-security-report.md", 70)))
      .toContain("/app/.trinker/reports/2026-09-11-security-report.md");
  });
});

describe("helpScreen", () => {
  it("renders navigation shortcuts, search instructions, and Trinker core workflow", () => {
    const rendered = text(helpScreen(80));
    expect(rendered).toContain("KEYBOARD NAVIGATION & SHORTCUTS");
    expect(rendered).toContain("SCREEN ACTIONS");
    expect(rendered).toContain("CORE TRINKER WORKFLOW");
    expect(rendered).toContain("0 runtime LLM tokens");
  });
});

