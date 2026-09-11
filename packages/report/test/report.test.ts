import { describe, expect, it } from "vitest";
import type { CheckOutcome, Finding, ScanResult } from "@trinker/core";
import { createReport, renderReport, trustSummary, type SecurityReport } from "../src/index.js";

const finding: Finding = {
  id: "TRK-0001", status: "confirmed", title: "Broken Object Level Authorization", severity: "high",
  invariant: "Only the owner may read the order.", routeId: "route_x", oracle: "Differential Authorization",
  verdict: "peer matched owner.",
  evidence: {
    requests: [{ method: "GET", url: "http://localhost:3000/orders/42", headers: { authorization: "[REDACTED]" } }],
    responses: [{ status: 200, headers: {}, bodyDigest: "sha256:abc" }],
    notes: ["Byte-equivalent witness."],
  },
  replay: { command: "trinker verify TRK-0001", checkId: "chk_x" }, remediation: "Authorize.",
};

const result = (overrides: Partial<ScanResult> = {}): ScanResult => ({
  scanId: "scan_1", planId: "trkp_demo", startedAt: "", completedAt: "", durationMs: 3,
  checks: { planned: 1, passed: 0, failed: 1, inconclusive: 0, errored: 0, unavailable: 0 },
  outcomes: [{ checkId: "chk_x", routeId: "route_x", oracle: "differential-authorization", status: "failed", reason: "matched", findingId: "TRK-0001" }],
  findings: [finding], tokens: { compileInput: 0, compileOutput: 0, runtimeInput: 0, runtimeOutput: 0, calls: 0 },
  ...overrides,
});

const report = (scan: ScanResult): SecurityReport => ({
  generatedAt: "2026-09-11T00:00:00.000Z", plan: { planId: "trkp_demo", surfaceDigest: "sha256:x" }, result: scan,
  coverage: { inScopeRoutes: 1, coveredRoutes: 1, uncoveredRouteIds: [], percent: 100, verifiedRoutes: 1, verifiedPercent: 100, unverifiedRouteIds: [], inconclusiveRouteIds: [], erroredRouteIds: [], unavailableRouteIds: [] },
});

const unavailable: CheckOutcome = { checkId: "chk_gap", routeId: "route_gap", oracle: "state-mutation", status: "unavailable", reason: "No oracle is registered for \"state-mutation\". This check was NOT tested." };

describe("trustSummary", () => {
  it("says COMPLETE only when every planned check reached a verdict", () => {
    expect(trustSummary(result({ checks: { planned: 1, passed: 1, failed: 0, inconclusive: 0, errored: 0, unavailable: 0 }, findings: [] }))).toMatch(/^COMPLETE/);
  });
  it("says INCOMPLETE and warns when checks produced no verdict", () => {
    const summary = trustSummary(result({ checks: { planned: 2, passed: 1, failed: 0, inconclusive: 0, errored: 0, unavailable: 1 }, findings: [], outcomes: [unavailable] }));
    expect(summary).toMatch(/^INCOMPLETE/);
    expect(summary).toMatch(/had no available oracle/);
    expect(summary).toMatch(/does NOT mean these routes are secure/);
  });
});

describe("markdown rendering", () => {
  it("renders the replay command and the finding detail", () => {
    const markdown = renderReport(report(result()), "markdown");
    expect(markdown).toContain("trinker verify TRK-0001");
    expect(markdown).toContain("Only the owner may read the order.");
    expect(markdown).toContain("[REDACTED]");
    expect(markdown).toContain("sha256:abc");
  });

  it("puts an unmissable warning section above the findings when checks did not run", () => {
    const markdown = renderReport(report(result({
      checks: { planned: 2, passed: 1, failed: 0, inconclusive: 0, errored: 0, unavailable: 1 },
      findings: [], outcomes: [unavailable],
    })), "markdown");
    expect(markdown).toContain("Checks that produced no verdict");
    expect(markdown).toContain("UNAVAILABLE");
    expect(markdown).toContain("chk_gap");
    expect(markdown).toMatch(/Scan status:.*INCOMPLETE/);
    expect(markdown.indexOf("no verdict")).toBeLessThan(markdown.indexOf("No mechanically confirmed findings"));
  });

  it("reports both planned and verified coverage", () => {
    expect(renderReport(report(result()), "markdown")).toMatch(/1\/1 planned .*1\/1 verified/);
  });
});

describe("SARIF rendering", () => {
  it("emits valid SARIF 2.1.0 with the finding as an error", () => {
    const sarif = JSON.parse(renderReport(report(result()), "sarif"));
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0].results[0]).toMatchObject({ ruleId: "TRK-0001", level: "error" });
    expect(sarif.runs[0].invocations[0].executionSuccessful).toBe(true);
  });

  it("surfaces untested checks as SARIF results so a dashboard cannot show a clean run", () => {
    const sarif = JSON.parse(renderReport(report(result({
      checks: { planned: 1, passed: 0, failed: 0, inconclusive: 0, errored: 0, unavailable: 1 },
      findings: [], outcomes: [unavailable],
    })), "sarif"));
    expect(sarif.runs[0].invocations[0].executionSuccessful).toBe(false);
    expect(sarif.runs[0].results).toHaveLength(1);
    expect(sarif.runs[0].results[0]).toMatchObject({ ruleId: "TRK-UNTESTED", level: "warning" });
  });
});

describe("JSON rendering", () => {
  it("round-trips the full result including outcomes", () => {
    const parsed = JSON.parse(renderReport(report(result()), "json"));
    expect(parsed.result.outcomes).toHaveLength(1);
    expect(parsed.coverage.verifiedRoutes).toBe(1);
  });
});

describe("createReport", () => {
  it("computes execution coverage from the plan and the scan", () => {
    const plan = { planId: "trkp_demo", surfaceDigest: "sha256:x", checks: [], coverage: { inScopeRouteIds: ["route_x"], exclusions: [] } } as never;
    const built = createReport(plan, result());
    expect(built.coverage.inScopeRoutes).toBe(1);
    expect(built.coverage.verifiedRoutes).toBe(1);
  });
});
