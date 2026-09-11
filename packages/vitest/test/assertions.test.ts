import { describe, expect, it } from "vitest";
import type { CheckOutcome, Finding, ScanResult } from "@trinker/core";
import {
  assertFindingIds, assertNoConfirmedFindings, assertNoFaults, assertScanComplete, assertSecure,
  describeScan, SecurityAssertionError, untestedOutcomes,
} from "../src/index.js";

const finding = (id: string): Finding => ({
  id, status: "confirmed", title: "Broken Object Level Authorization", severity: "high",
  invariant: "Only the owner may read the order.", routeId: "route_x", oracle: "Differential Authorization",
  verdict: "identity_peer matched identity_owner.",
  evidence: { requests: [], responses: [], notes: [] },
  replay: { command: `trinker verify ${id}`, checkId: "chk_x" },
  remediation: "Authorize.",
});

const outcome = (status: CheckOutcome["status"], checkId = "chk_x", reason = "because"): CheckOutcome =>
  ({ checkId, routeId: "route_x", oracle: "differential-authorization", status, reason });

const result = (overrides: Partial<ScanResult> = {}): ScanResult => ({
  scanId: "scan_1", planId: "trkp_x", startedAt: "", completedAt: "", durationMs: 1,
  checks: { planned: 1, passed: 1, failed: 0, inconclusive: 0, errored: 0, unavailable: 0 },
  outcomes: [outcome("passed")], findings: [],
  tokens: { compileInput: 0, compileOutput: 0, runtimeInput: 0, runtimeOutput: 0, calls: 0 },
  ...overrides,
});

const vulnerable = () => result({
  checks: { planned: 1, passed: 0, failed: 1, inconclusive: 0, errored: 0, unavailable: 0 },
  outcomes: [outcome("failed")], findings: [finding("TRK-0001")],
});

const incomplete = () => result({
  checks: { planned: 2, passed: 1, failed: 0, inconclusive: 0, errored: 0, unavailable: 1 },
  outcomes: [outcome("passed"), outcome("unavailable", "chk_gap", 'No oracle is registered for "out-of-band".')],
});

describe("assertNoConfirmedFindings", () => {
  it("passes on a clean result", () => {
    expect(() => assertNoConfirmedFindings(result())).not.toThrow();
  });

  it("fails with the verdict and the replay command, not just a count", () => {
    try {
      assertNoConfirmedFindings(vulnerable());
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SecurityAssertionError);
      const message = (error as Error).message;
      expect(message).toContain("TRK-0001");
      expect(message).toContain("Only the owner may read the order.");
      expect(message).toContain("identity_peer matched identity_owner.");
      expect(message).toContain("trinker verify TRK-0001");
    }
  });

  it("pluralises correctly", () => {
    expect(() => assertNoConfirmedFindings(vulnerable())).toThrow(/1 security finding:/);
    const two = result({ findings: [finding("TRK-0001"), finding("TRK-0002")] });
    expect(() => assertNoConfirmedFindings(two)).toThrow(/2 security findings:/);
  });
});

describe("assertScanComplete", () => {
  it("passes when every check reached a verdict", () => {
    expect(() => assertScanComplete(result())).not.toThrow();
  });

  it("fails when a check produced no verdict, and says why", () => {
    expect(() => assertScanComplete(incomplete())).toThrow(/produced no verdict/);
    expect(() => assertScanComplete(incomplete())).toThrow(/chk_gap/);
    expect(() => assertScanComplete(incomplete())).toThrow(/does not mean these routes are secure/);
  });

  it.each(["inconclusive", "errored", "unavailable"] as const)("treats %s as untested", (status) => {
    const scan = result({ outcomes: [outcome(status)] });
    expect(untestedOutcomes(scan)).toHaveLength(1);
    expect(() => assertScanComplete(scan)).toThrow();
  });
});

describe("assertNoFaults", () => {
  it("allows a legitimately inconclusive check through", () => {
    expect(() => assertNoFaults(result({ outcomes: [outcome("inconclusive")] }))).not.toThrow();
  });

  it("fails on an execution fault", () => {
    expect(() => assertNoFaults(result({ outcomes: [outcome("errored")] }))).toThrow(/could not run/);
    expect(() => assertNoFaults(result({ outcomes: [outcome("unavailable")] }))).toThrow(/could not run/);
  });
});

describe("assertSecure", () => {
  it("passes only when the scan was complete and clean", () => {
    expect(() => assertSecure(result())).not.toThrow();
  });

  it("fails on a confirmed finding", () => {
    expect(() => assertSecure(vulnerable())).toThrow(/confirmed 1 security finding/);
  });

  it("fails on an incomplete scan even though there are no findings", () => {
    // The trap this whole framework exists to prevent: green because nothing ran.
    expect(incomplete().findings).toHaveLength(0);
    expect(() => assertSecure(incomplete())).toThrow(/produced no verdict/);
  });

  it("reports incompleteness before findings, since it is the more misleading failure", () => {
    const both = result({
      checks: { planned: 2, passed: 0, failed: 1, inconclusive: 0, errored: 0, unavailable: 1 },
      outcomes: [outcome("failed"), outcome("unavailable", "chk_gap")], findings: [finding("TRK-0001")],
    });
    expect(() => assertSecure(both)).toThrow(/produced no verdict/);
  });
});

describe("assertFindingIds", () => {
  it("passes on an exact match regardless of order", () => {
    const scan = result({ findings: [finding("TRK-0002"), finding("TRK-0001")] });
    expect(() => assertFindingIds(scan, ["TRK-0001", "TRK-0002"])).not.toThrow();
  });

  it("fails when a known-vulnerable fixture stops being detected", () => {
    expect(() => assertFindingIds(result(), ["TRK-0001"])).toThrow(/Expected findings \[TRK-0001\] but got \[none\]/);
  });

  it("fails on an unexpected extra finding", () => {
    expect(() => assertFindingIds(vulnerable(), [])).toThrow(/Expected findings \[none\] but got \[TRK-0001\]/);
  });
});

describe("describeScan", () => {
  it("summarises every outcome kind", () => {
    expect(describeScan(incomplete())).toBe("2 planned: 1 passed, 0 failed, 0 inconclusive, 0 errored, 1 unavailable");
  });
});
