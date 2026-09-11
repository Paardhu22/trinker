import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  calculateExecutionCoverage, hasFaults, isScanComplete,
  type CheckOutcome, type ExecutionCoverageSummary, type Finding, type Plan, type ScanResult,
} from "@trinker/core";

export type ReportFormat = "json" | "markdown" | "sarif";
export interface SecurityReport {
  generatedAt: string;
  plan: Pick<Plan, "planId" | "surfaceDigest">;
  result: ScanResult;
  coverage: ExecutionCoverageSummary;
}

export function createReport(plan: Plan, result: ScanResult): SecurityReport {
  return {
    generatedAt: new Date().toISOString(),
    plan: { planId: plan.planId, surfaceDigest: plan.surfaceDigest },
    result,
    coverage: calculateExecutionCoverage(plan, result),
  };
}

export function renderReport(report: SecurityReport, format: ReportFormat): string {
  if (format === "json") return `${JSON.stringify(report, null, 2)}\n`;
  if (format === "sarif") return `${JSON.stringify(toSarif(report), null, 2)}\n`;
  return toMarkdown(report);
}

export async function writeReport(projectDir: string, report: SecurityReport, format: ReportFormat): Promise<string> {
  const stamp = report.generatedAt.replace(/[:.]/g, "-").slice(0, 19);
  const extension = format === "markdown" ? "md" : format;
  const file = join(projectDir, ".trinker", "reports", `${stamp}-security-report.${extension}`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, renderReport(report, format), "utf8");
  return file;
}

/**
 * One sentence stating how much trust the result deserves. Rendered before the findings in every
 * format, because "0 findings" is only meaningful when every planned check actually ran.
 */
export function trustSummary(result: ScanResult): string {
  const { inconclusive, errored, unavailable } = result.checks;
  const untested = inconclusive + errored + unavailable;
  if (untested === 0) {
    return result.findings.length === 0
      ? "COMPLETE - every planned check produced a verdict and no violation was confirmed."
      : `COMPLETE - every planned check produced a verdict; ${result.findings.length} violation(s) confirmed.`;
  }
  const was = (count: number): string => (count === 1 ? "was" : "were");
  const parts = [
    unavailable > 0 ? `${unavailable} had no available oracle` : "",
    errored > 0 ? `${errored} errored` : "",
    inconclusive > 0 ? `${inconclusive} ${was(inconclusive)} inconclusive` : "",
  ].filter(Boolean);
  const noun = untested === 1 ? "check" : "checks";
  return `INCOMPLETE - ${untested} of ${result.checks.planned} planned ${noun} produced no verdict (${parts.join(", ")}). Absence of findings does NOT mean these routes are secure.`;
}

function toMarkdown(report: SecurityReport): string {
  const { result, coverage } = report;
  const counts = severityCounts(result.findings);
  const lines = [
    "# Trinker Security Report", "",
    `Plan: \`${result.planId}\``, `Scan: \`${result.scanId}\``, `Duration: ${result.durationMs}ms`,
    `Runtime LLM tokens: ${result.tokens.runtimeInput + result.tokens.runtimeOutput}`, "",
    `> **Scan status:** ${trustSummary(result)}`, "",
    "## Summary", "",
    `- Confirmed findings: ${result.findings.length}`,
    `- Checks: ${result.checks.passed} passed, ${result.checks.failed} failed, ${result.checks.inconclusive} inconclusive, ${result.checks.errored} errored, ${result.checks.unavailable} unavailable (of ${result.checks.planned} planned)`,
    `- Severity: ${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ${counts.low} low`,
    `- Route coverage: ${coverage.coveredRoutes}/${coverage.inScopeRoutes} planned (${coverage.percent.toFixed(1)}%), ${coverage.verifiedRoutes}/${coverage.inScopeRoutes} verified (${coverage.verifiedPercent.toFixed(1)}%)`,
    "",
  ];

  const untested = result.outcomes.filter((outcome) => outcome.status !== "passed" && outcome.status !== "failed");
  if (untested.length > 0) {
    lines.push("## ⚠️ Checks that produced no verdict", "",
      "These checks did not test anything. Do not read this report as evidence that the routes below are secure.", "",
      "| Check | Route | Oracle | Status | Reason |", "| --- | --- | --- | --- | --- |");
    for (const outcome of untested) {
      lines.push(`| \`${outcome.checkId}\` | \`${outcome.routeId}\` | ${outcome.oracle} | **${outcome.status.toUpperCase()}** | ${escapeCell(outcome.reason)} |`);
    }
    lines.push("");
  }

  if (result.findings.length === 0) lines.push("## Findings", "", "No mechanically confirmed findings.", "");
  for (const finding of result.findings) lines.push(...findingMarkdown(finding));
  return `${lines.join("\n")}\n`;
}

const escapeCell = (value: string): string => value.replace(/\|/g, "\\|").replace(/\n/g, " ");

function findingMarkdown(finding: Finding): string[] {
  const lines = [
    `## ${finding.id} - ${finding.severity.toUpperCase()} - ${finding.title}`, "",
    `**Status:** ${finding.status.toUpperCase()}`, "",
    `**Route:** \`${finding.routeId}\``, "",
    `**Invariant:** ${finding.invariant}`, "",
    `**Oracle:** ${finding.oracle}`, "",
    `**Verdict:** ${finding.verdict}`, "",
    `**Replay:** \`${finding.replay.command}\``, "",
  ];
  if (finding.evidence.notes.length > 0) {
    lines.push("**Evidence:**", "", ...finding.evidence.notes.map((note) => `- ${note}`), "");
  }
  for (const [index, request] of finding.evidence.requests.entries()) {
    const response = finding.evidence.responses[index];
    lines.push(`\`\`\`http`, `${request.method} ${request.url}`,
      ...Object.entries(request.headers).map(([name, value]) => `${name}: ${value}`),
      ...(response ? ["", `-> ${response.status}`, `-> body ${response.bodyDigest}`] : []), "```", "");
  }
  lines.push(`**Remediation:** ${finding.remediation}`, "");
  return lines;
}

function severityCounts(findings: Finding[]): Record<"critical" | "high" | "medium" | "low", number> {
  const output = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of findings) if (finding.severity !== "info") output[finding.severity]++;
  return output;
}

function toSarif(report: SecurityReport): Record<string, unknown> {
  const { result } = report;
  const findingRules = result.findings.map((finding) => ({
    id: finding.id, name: finding.title,
    shortDescription: { text: finding.title },
    fullDescription: { text: finding.invariant },
    properties: { severity: finding.severity, oracle: finding.oracle },
  }));
  const untested = result.outcomes.filter((outcome) => outcome.status === "errored" || outcome.status === "unavailable");
  const untestedRule = untested.length > 0
    ? [{ id: "TRK-UNTESTED", name: "Security check did not run", shortDescription: { text: "A planned security check produced no verdict" } }]
    : [];

  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [{
      tool: { driver: { name: "Trinker", version: "0.1.0", informationUri: "https://github.com/Paardhu22/trinker", rules: [...findingRules, ...untestedRule] } },
      invocations: [{
        executionSuccessful: !hasFaults(result),
        exitSignalName: isScanComplete(result) ? "complete" : "incomplete",
        properties: { trustSummary: trustSummary(result), checks: result.checks },
      }],
      results: [
        ...result.findings.map((finding) => ({
          ruleId: finding.id, level: sarifLevel(finding.severity),
          message: { text: `${finding.verdict} Replay: ${finding.replay.command}` },
          properties: { oracle: finding.oracle, invariant: finding.invariant, status: finding.status, routeId: finding.routeId },
        })),
        // Surface faults as SARIF results too, so a CI dashboard cannot show a clean run for a scan that never executed.
        ...untested.map((outcome: CheckOutcome) => ({
          ruleId: "TRK-UNTESTED", level: "warning" as const,
          message: { text: `Check ${outcome.checkId} on ${outcome.routeId} produced no verdict (${outcome.status}): ${outcome.reason}` },
          properties: { checkId: outcome.checkId, routeId: outcome.routeId, oracle: outcome.oracle, status: outcome.status },
        })),
      ],
    }],
  };
}

function sarifLevel(severity: Finding["severity"]): "error" | "warning" | "note" {
  return severity === "critical" || severity === "high" ? "error" : severity === "medium" ? "warning" : "note";
}
