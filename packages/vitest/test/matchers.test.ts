import { describe, expect, it } from "vitest";
import type { ScanResult } from "@trinker/core";
import "../src/setup.js";

const base = (overrides: Partial<ScanResult> = {}): ScanResult => ({
  scanId: "scan_1", planId: "trkp_x", startedAt: "", completedAt: "", durationMs: 1,
  checks: { planned: 1, passed: 1, failed: 0, inconclusive: 0, errored: 0, unavailable: 0 },
  outcomes: [{ checkId: "chk_x", routeId: "route_x", oracle: "differential-authorization", status: "passed", reason: "held" }],
  findings: [], tokens: { compileInput: 0, compileOutput: 0, runtimeInput: 0, runtimeOutput: 0, calls: 0 },
  ...overrides,
});

describe("vitest matchers", () => {
  it("passes and negates like any matcher", () => {
    expect(base()).toBeSecure();
    expect(base()).toBeCompleteScan();
    expect(base()).toHaveFindingIds([]);
    const incomplete = base({
      checks: { planned: 1, passed: 0, failed: 0, inconclusive: 0, errored: 0, unavailable: 1 },
      outcomes: [{ checkId: "chk_x", routeId: "route_x", oracle: "out-of-band", status: "unavailable", reason: "no oracle" }],
    });
    expect(incomplete).not.toBeSecure();
    expect(incomplete).not.toBeCompleteScan();
  });

  it("fails with the assertion's own evidence-carrying message", () => {
    const incomplete = base({
      checks: { planned: 1, passed: 0, failed: 0, inconclusive: 0, errored: 1, unavailable: 0 },
      outcomes: [{ checkId: "chk_x", routeId: "route_x", oracle: "differential-authorization", status: "errored", reason: "ECONNREFUSED" }],
    });
    expect(() => expect(incomplete).toBeSecure()).toThrow(/ECONNREFUSED/);
  });
});
