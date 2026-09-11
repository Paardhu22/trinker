import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Finding, Plan, ScanResult } from "@trinker/core";

export type ReportFormat = "json" | "markdown" | "sarif";
export interface SecurityReport { generatedAt: string; plan: Pick<Plan, "planId" | "surfaceDigest">; result: ScanResult; }

export function createReport(plan: Plan, result: ScanResult): SecurityReport {
  return { generatedAt: new Date().toISOString(), plan: { planId: plan.planId, surfaceDigest: plan.surfaceDigest }, result };
}

export function renderReport(report: SecurityReport, format: ReportFormat): string {
  if (format === "json") return `${JSON.stringify(report, null, 2)}\n`;
  if (format === "sarif") return `${JSON.stringify(toSarif(report), null, 2)}\n`;
  return toMarkdown(report);
}

export async function writeReport(projectDir: string, report: SecurityReport, format: ReportFormat): Promise<string> {
  const stamp = report.generatedAt.slice(0, 10);
  const extension = format === "markdown" ? "md" : format;
  const file = join(projectDir, ".trinker", "reports", `${stamp}-security-report.${extension}`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, renderReport(report, format), "utf8");
  return file;
}

function toMarkdown(report: SecurityReport): string {
  const { result } = report;
  const counts = severityCounts(result.findings);
  const lines = [
    "# Trinker Security Report", "", `Plan: \`${result.planId}\``, `Scan: \`${result.scanId}\``, `Duration: ${result.durationMs}ms`, `Runtime LLM tokens: ${result.tokens.runtimeInput + result.tokens.runtimeOutput}`, "",
    "## Summary", "", `- Confirmed findings: ${result.findings.length}`, `- Checks: ${result.checks.passed} passed, ${result.checks.failed} failed, ${result.checks.skipped} skipped`, `- Severity: ${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ${counts.low} low`, "",
  ];
  if (result.findings.length === 0) lines.push("No mechanically confirmed findings.", "");
  for (const finding of result.findings) lines.push(...findingMarkdown(finding));
  return `${lines.join("\n")}\n`;
}

function findingMarkdown(finding: Finding): string[] {
  return [
    `## ${finding.id} - ${finding.severity.toUpperCase()} - ${finding.title}`, "", `**Status:** ${finding.status.toUpperCase()}`, "", `**Invariant:** ${finding.invariant}`, "", `**Oracle:** ${finding.oracle}`, "", `**Verdict:** ${finding.verdict}`, "", `**Replay:** \`${finding.replay.command}\``, "", `**Remediation:** ${finding.remediation}`, "",
  ];
}

function severityCounts(findings: Finding[]): Record<"critical" | "high" | "medium" | "low", number> {
  const output = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of findings) if (finding.severity !== "info") output[finding.severity]++;
  return output;
}

function toSarif(report: SecurityReport): Record<string, unknown> {
  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [{
      tool: { driver: { name: "Trinker", version: "0.1.0", informationUri: "https://github.com/trinker/trinker", rules: report.result.findings.map((finding) => ({ id: finding.id, name: finding.title, shortDescription: { text: finding.title } })) } },
      results: report.result.findings.map((finding) => ({ ruleId: finding.id, level: sarifLevel(finding.severity), message: { text: `${finding.verdict} Replay: ${finding.replay.command}` }, properties: { oracle: finding.oracle, invariant: finding.invariant, status: finding.status } })),
    }],
  };
}
function sarifLevel(severity: Finding["severity"]): "error" | "warning" | "note" { return severity === "critical" || severity === "high" ? "error" : severity === "medium" ? "warning" : "note"; }
