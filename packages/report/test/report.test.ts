import { describe, expect, it } from "vitest";
import { renderReport, type SecurityReport } from "../src/index.js";

const report: SecurityReport = { generatedAt: "2026-09-11T00:00:00.000Z", plan: { planId: "trkp_demo", surfaceDigest: "sha256:x" }, result: { scanId: "scan_1", planId: "trkp_demo", startedAt: "", completedAt: "", durationMs: 3, checks: { planned: 1, passed: 0, failed: 1, skipped: 0 }, findings: [{ id: "TRK-0001", status: "confirmed", title: "Broken Object Level Authorization", severity: "high", invariant: "Ownership", routeId: "route_x", oracle: "Differential Authorization", verdict: "Witness matched.", evidence: { requests: [], responses: [], notes: [] }, replay: { command: "trinker verify TRK-0001", checkId: "chk_x" }, remediation: "Authorize." }], tokens: { compileInput: 0, compileOutput: 0, runtimeInput: 0, runtimeOutput: 0, calls: 0 } } };
describe("report renderers", () => {
  it("renders replayable markdown and valid SARIF shape", () => {
    expect(renderReport(report, "markdown")).toContain("trinker verify TRK-0001");
    expect(JSON.parse(renderReport(report, "sarif")).version).toBe("2.1.0");
  });
});
