import { emitKeypressEvents } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { coverageForProject, exportLatestReport, loadLatestReport, runProject, verifyFinding } from "./workflow.js";

const menu = ["Run Security Scan", "View Latest Report", "View Findings", "Verify Finding", "Security Coverage", "Export Report", "Configuration", "Exit"];
const clear = (): void => { output.write("\x1Bc"); };
const pause = async (message = "Press any key to return"): Promise<void> => new Promise((resolve) => {
  output.write(`\n${message}`);
  input.once("data", () => resolve());
});

export async function launchTui(projectDir: string): Promise<void> {
  if (!input.isTTY || !output.isTTY) throw new Error("Interactive mode requires a TTY. Use `trinker run --ci` for automation.");
  emitKeypressEvents(input); input.setRawMode(true); input.resume();
  let selected = 0;
  const render = (): void => {
    clear(); output.write("TRINKER\nDeterministic application security testing\n\n");
    output.write(`Target: ${projectDir}\nRuntime LLM tokens: 0 by default\n\n`);
    for (let index = 0; index < menu.length; index++) output.write(`${index === selected ? "❯" : " "} ${menu[index]}\n`);
    output.write("\n↑/↓ navigate  Enter select  q quit\n");
  };
  const choose = async (): Promise<void> => {
    const item = menu[selected];
    clear();
    if (item === "Run Security Scan") {
      output.write("TRINKER SECURITY SCAN\n\n");
      const { result } = await runProject(projectDir, (event) => output.write(`${event.type}: ${JSON.stringify(event.data)}\n`));
      output.write(`\nComplete. ${result.findings.length} confirmed findings. Runtime LLM tokens: 0\n`);
    } else if (item === "View Latest Report" || item === "View Findings") {
      const report = await loadLatestReport(projectDir);
      output.write(`${item}\n\n`);
      if (report.result.findings.length === 0) output.write("No mechanically confirmed findings.\n");
      for (const finding of report.result.findings) output.write(`${finding.id}  ${finding.severity.toUpperCase()}  ${finding.title}\n${finding.verdict}\nReplay: ${finding.replay.command}\n\n`);
    } else if (item === "Verify Finding") {
      const report = await loadLatestReport(projectDir);
      if (report.result.findings.length === 0) output.write("No confirmed finding is available to verify.\n");
      else {
        output.write("Select a finding by number:\n");
        report.result.findings.forEach((finding, index) => output.write(`${index + 1}. ${finding.id} ${finding.title}\n`));
        const selectedFinding = await new Promise<number>((resolve) => input.once("keypress", (_value, keypress) => resolve(Number(keypress.sequence))));
        const finding = report.result.findings[selectedFinding - 1];
        if (!finding) output.write("Invalid finding selection.\n");
        else { const verified = await verifyFinding(projectDir, finding.id); output.write(`${finding.id}: ${verified.reproduced ? "still confirmed" : "not reproduced"}\n`); }
      }
    } else if (item === "Security Coverage") {
      const coverage = await coverageForProject(projectDir);
      output.write(`SECURITY COVERAGE\n\n${coverage.coveredRoutes}/${coverage.inScopeRoutes} routes covered (${coverage.percent.toFixed(1)}%)\nUncovered: ${coverage.uncoveredRouteIds.join(", ") || "none"}\n`);
    } else if (item === "Export Report") {
      output.write("Press m for Markdown, j for JSON, or s for SARIF.\n");
      const formatKey = await new Promise<string>((resolve) => input.once("keypress", (_value, keypress) => resolve(keypress.name ?? "")));
      const format: "json" | "markdown" | "sarif" = formatKey === "j" ? "json" : formatKey === "s" ? "sarif" : "markdown";
      output.write(`Exported: ${await exportLatestReport(projectDir, format)}\n`);
    } else if (item === "Configuration") {
      output.write("Configuration lives in .trinker/runtime.json. It is intentionally separate from the reviewed plan and should not be committed.\n");
    }
    if (item !== "Exit") await pause();
  };
  try {
    while (true) {
      render();
      const key = await new Promise<string>((resolve) => input.once("keypress", (_value, keypress) => resolve(keypress.name ?? "")));
      if (key === "q" || key === "escape") break;
      if (key === "up") selected = (selected + menu.length - 1) % menu.length;
      if (key === "down") selected = (selected + 1) % menu.length;
      if (key === "return") { if (menu[selected] === "Exit") break; try { await choose(); } catch (error) { output.write(`\nError: ${error instanceof Error ? error.message : "Unknown error"}\n`); await pause(); } }
    }
  } finally { input.setRawMode(false); input.pause(); clear(); }
}
