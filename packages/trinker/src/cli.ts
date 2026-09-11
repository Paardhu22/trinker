#!/usr/bin/env node
import { cwd } from "node:process";
import { renderReport } from "@trinker/report";
import { launchTui } from "./tui.js";
import { compileProject, coverageForProject, exportLatestReport, initialiseProject, runProject, verifyFinding } from "./workflow.js";

const [command, ...args] = process.argv.slice(2);
const projectDir = cwd();
const write = (value: unknown): void => { process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`); };

async function main(): Promise<void> {
  if (!command) return launchTui(projectDir);
  if (command === "init") { const result = await initialiseProject(projectDir); write(result.created.length ? `Created ${result.created.join(", ")}` : "Trinker is already initialized."); return; }
  if (command === "compile") { const plan = await compileProject(projectDir); write(`Compiled ${plan.surface.routes.length} routes to .trinker/plan.json (${plan.planId}). Runtime LLM tokens: 0`); return; }
  if (command === "coverage") { const coverage = await coverageForProject(projectDir); write(args.includes("--ci") ? coverage : `Coverage: ${coverage.percent.toFixed(1)}% (${coverage.coveredRoutes}/${coverage.inScopeRoutes})\nUncovered: ${coverage.uncoveredRouteIds.join(", ") || "none"}`); return; }
  if (command === "run") {
    const ci = args.includes("--ci"); const formatIndex = args.indexOf("--format"); const format = formatIndex >= 0 ? args[formatIndex + 1] : "json";
    const { result, report } = await runProject(projectDir, ci ? undefined : (event) => write(`${event.type} ${JSON.stringify(event.data)}`));
    if (ci) { write(renderReport(report, format === "sarif" ? "sarif" : "json")); process.exitCode = result.findings.length > 0 ? 1 : 0; }
    else write(`Scan complete: ${result.findings.length} confirmed findings. Runtime LLM tokens: 0`);
    return;
  }
  if (command === "verify") { const findingId = args[0]; if (!findingId) throw new Error("Usage: trinker verify <finding-id>"); const { report } = await verifyFinding(projectDir, findingId); write(renderReport(report, "markdown")); process.exitCode = report.result.findings.length > 0 ? 1 : 0; return; }
  if (command === "report") { const format = args.includes("--sarif") ? "sarif" : args.includes("--json") ? "json" : "markdown"; write(await exportLatestReport(projectDir, format)); return; }
  throw new Error(`Unknown command: ${command}`);
}
main().catch((error: unknown) => { process.stderr.write(`trinker: ${error instanceof Error ? error.message : "Unknown error"}\n`); process.exitCode = 2; });
