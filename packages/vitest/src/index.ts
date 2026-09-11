import type { CheckOutcome, Finding, ScanResult } from "@trinker/core";

/**
 * Assertions for running a Trinker scan inside an existing test suite.
 *
 * These are plain functions that throw, so they work in Vitest, Jest, node:test, or anything else,
 * and this package depends on no test runner.
 *
 * The failure messages carry the verdict and the replay command, because a security assertion that
 * fails with "expected 1 to be 0" wastes the evidence the scan just produced.
 */
export class SecurityAssertionError extends Error {
  public constructor(message: string) { super(message); this.name = "SecurityAssertionError"; }
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

const describeFinding = (finding: Finding): string =>
  `  ${finding.id}  ${finding.severity.toUpperCase()}  ${finding.title}\n` +
  `    route:       ${finding.routeId}\n` +
  `    invariant:   ${finding.invariant}\n` +
  `    verdict:     ${finding.verdict}\n` +
  `    replay:      ${finding.replay.command}`;

const describeOutcome = (outcome: CheckOutcome): string =>
  `  ${outcome.status.toUpperCase().padEnd(13)} ${outcome.checkId} (${outcome.routeId})\n    ${outcome.reason}`;

/** Checks that produced no security verdict. */
export const untestedOutcomes = (result: ScanResult): CheckOutcome[] =>
  result.outcomes.filter((outcome) => outcome.status !== "passed" && outcome.status !== "failed");

/** One-line summary, useful in a test name or a log line. */
export function describeScan(result: ScanResult): string {
  const { passed, failed, inconclusive, errored, unavailable, planned } = result.checks;
  return `${planned} planned: ${passed} passed, ${failed} failed, ${inconclusive} inconclusive, ${errored} errored, ${unavailable} unavailable`;
}

/** Fails if the scan mechanically confirmed any violation. */
export function assertNoConfirmedFindings(result: ScanResult): void {
  if (result.findings.length === 0) return;
  throw new SecurityAssertionError(
    `Trinker confirmed ${plural(result.findings.length, "security finding")}:\n\n` +
    `${result.findings.map(describeFinding).join("\n\n")}\n`,
  );
}

/**
 * Fails if any planned check did not reach a verdict.
 *
 * Assert this alongside `assertNoConfirmedFindings`, or a suite can pass green while testing
 * nothing — a check whose oracle is unavailable produces no finding either.
 */
export function assertScanComplete(result: ScanResult): void {
  const untested = untestedOutcomes(result);
  if (untested.length === 0) return;
  throw new SecurityAssertionError(
    `${plural(untested.length, "planned security check")} produced no verdict, so this scan did not test everything:\n\n` +
    `${untested.map(describeOutcome).join("\n")}\n\n` +
    `Absence of findings does not mean these routes are secure.`,
  );
}

/** Fails only on execution faults, allowing a legitimately inconclusive check through. */
export function assertNoFaults(result: ScanResult): void {
  const faults = result.outcomes.filter((outcome) => outcome.status === "errored" || outcome.status === "unavailable");
  if (faults.length === 0) return;
  throw new SecurityAssertionError(
    `${plural(faults.length, "security check")} could not run:\n\n${faults.map(describeOutcome).join("\n")}`,
  );
}

/**
 * The assertion you almost always want: every planned check ran, and none confirmed a violation.
 *
 * Completeness is checked first, because "no findings" from a scan that executed nothing is the
 * failure this whole framework exists to prevent.
 */
export function assertSecure(result: ScanResult): void {
  assertScanComplete(result);
  assertNoConfirmedFindings(result);
}

/**
 * Assert an exact set of finding ids. For testing Trinker itself, or pinning a known-vulnerable
 * fixture so a regression that stops detecting it fails the suite.
 */
export function assertFindingIds(result: ScanResult, expected: readonly string[]): void {
  const actual = result.findings.map((finding) => finding.id).sort();
  const wanted = [...expected].sort();
  if (actual.length === wanted.length && actual.every((id, index) => id === wanted[index])) return;
  throw new SecurityAssertionError(
    `Expected findings [${wanted.join(", ") || "none"}] but got [${actual.join(", ") || "none"}].\n${describeScan(result)}`,
  );
}
