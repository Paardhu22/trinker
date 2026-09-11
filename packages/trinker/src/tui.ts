import { emitKeypressEvents } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import type { Finding, ScanEvent } from "@trinker/core";
import { trustSummary, type SecurityReport } from "@trinker/report";
import { applyScanEvent, emptyScanView, progressRatio, untestedCount, type ScanView } from "./scan-view.js";
import {
  coverageForProject, executionCoverageForProject, exportLatestReport,
  loadLatestReport, loadRuntime, runProject, verifyFinding,
} from "./workflow.js";

/* ------------------------------------------------------------------ styling */

const useColor = process.env["NO_COLOR"] === undefined && output.isTTY;
const paint = (code: string) => (text: string): string => (useColor ? `[${code}m${text}[0m` : text);
const bold = paint("1");
const dim = paint("2");
const red = paint("31");
const green = paint("32");
const yellow = paint("33");
const blue = paint("36");
const magenta = paint("35");

const SEVERITY_COLOR: Record<string, (text: string) => string> = {
  critical: paint("1;31"), high: red, medium: yellow, low: blue, info: dim,
};
const STATUS_COLOR: Record<string, (text: string) => string> = {
  passed: green, failed: red, inconclusive: yellow, errored: magenta, unavailable: magenta,
};

const clear = (): void => { output.write("[2J[H"); };
const write = (line = ""): void => { output.write(`${line}\n`); };
const rule = (): void => { write(dim("─".repeat(Math.min(output.columns ?? 80, 100)))); };

function header(projectDir: string): void {
  write(bold("TRINKER") + dim("  deterministic application security testing"));
  write(dim(projectDir));
  rule();
}

/* ------------------------------------------------------------------- input */

/**
 * Keystrokes are buffered by a single persistent listener.
 *
 * stdin is in flowing mode, so any key arriving while the console is busy rendering would be
 * emitted to nobody and lost. Queueing means a fast typist, a paste, or a scripted session keeps
 * every keystroke in order.
 */
const pending: string[] = [];
let waiting: ((key: string) => void) | undefined;
let ended = false;

function startInput(): () => void {
  const push = (key: string): void => {
    if (waiting) { const resolve = waiting; waiting = undefined; resolve(key); }
    else pending.push(key);
  };
  const onKey = (_value: string, key: { name?: string; sequence?: string } | undefined): void => push(key?.name ?? key?.sequence ?? "");
  // A closed stdin must end the console rather than leave it waiting for a key that cannot arrive.
  const onEnd = (): void => { ended = true; push("q"); };
  input.on("keypress", onKey);
  input.on("end", onEnd);
  input.on("close", onEnd);
  return () => { input.off("keypress", onKey); input.off("end", onEnd); input.off("close", onEnd); };
}

const keypress = (): Promise<string> => {
  const queued = pending.shift();
  if (queued !== undefined) return Promise.resolve(queued);
  if (ended) return Promise.resolve("q");
  return new Promise((resolve) => { waiting = resolve; });
};

/** Enter arrives as "return" on most terminals and "enter" through some pty layers. */
const isEnter = (key: string): boolean => key === "return" || key === "enter";
const isBack = (key: string): boolean => key === "q" || key === "escape";

const pause = async (message = "any key to go back"): Promise<void> => {
  write();
  write(dim(`— ${message} —`));
  await keypress();
};

/* -------------------------------------------------------------- scan view */

const bar = (ratio: number, width = 28): string => {
  const filled = Math.round(ratio * width);
  return `${"█".repeat(filled)}${dim("░".repeat(width - filled))}`;
};

function renderScan(view: ScanView, projectDir: string, startedAt: number): void {
  clear();
  header(projectDir);
  write(`${bold("Target")}    ${view.target ?? dim("resolving…")}${view.targetRef ? dim(`  (${view.targetRef})`) : ""}`);
  write(`${bold("Plan")}      ${view.planId ?? dim("…")}`);
  write(`${bold("Phase")}     ${view.phase ?? dim("…")}`);
  write(`${bold("Elapsed")}   ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  write(`${bold("LLM")}       ${view.tokens.runtimeInput + view.tokens.runtimeOutput} runtime tokens, ${view.tokens.calls} calls`);
  write();

  const done = view.completedChecks;
  write(`${bar(progressRatio(view))}  ${done}/${view.plannedChecks} checks`);
  write();

  if (view.failure) {
    write(red(bold("Scan aborted: ")) + view.failure);
  } else if (view.current) {
    write(`${bold("Running")}   ${view.current.checkId}  ${dim(view.current.oracle)}`);
    write(`${bold("Route")}     ${view.current.routeId}`);
    if (view.current.activity) write(`${bold("Activity")}  ${view.current.activity}`);
  } else if (!view.done) {
    write(dim("waiting…"));
  }

  write();
  const c = view.counts;
  write([
    green(`${c.passed} passed`), red(`${c.failed} failed`), yellow(`${c.inconclusive} inconclusive`),
    magenta(`${c.errored} errored`), magenta(`${c.unavailable} unavailable`),
  ].join(dim("  ·  ")));

  if (view.findings.length > 0) {
    write();
    write(bold("Findings"));
    for (const finding of view.findings) {
      write(`  ${(SEVERITY_COLOR[finding.severity] ?? dim)(finding.severity.toUpperCase().padEnd(8))} ${finding.findingId}  ${finding.title}`);
    }
  }

  const untested = untestedCount(view);
  if (view.done && untested > 0) {
    write();
    write(yellow(bold(`⚠ ${untested} check(s) produced no verdict — this scan did not test everything.`)));
  }
}

async function runScanView(projectDir: string): Promise<void> {
  let view = emptyScanView();
  const startedAt = Date.now();
  // Re-render on a timer as well as on events, so elapsed time advances during a slow request.
  const ticker = setInterval(() => renderScan(view, projectDir, startedAt), 250);
  const onEvent = (event: ScanEvent): void => { view = applyScanEvent(view, event); renderScan(view, projectDir, startedAt); };

  try {
    const { result } = await runProject(projectDir, onEvent);
    clearInterval(ticker);
    renderScan(view, projectDir, startedAt);
    write();
    rule();
    write(result.findings.length > 0 ? red(bold(`${result.findings.length} confirmed finding(s).`)) : green(bold("No confirmed findings.")));
    write(trustSummary(result));
  } catch (error) {
    clearInterval(ticker);
    renderScan(view, projectDir, startedAt);
    write();
    write(red(`Scan failed: ${error instanceof Error ? error.message : "Unknown error"}`));
  } finally {
    clearInterval(ticker);
  }
  await pause();
}

/* --------------------------------------------------------- findings views */

function renderFindingDetail(finding: Finding): void {
  clear();
  const severity = (SEVERITY_COLOR[finding.severity] ?? dim)(finding.severity.toUpperCase());
  write(`${bold(finding.id)}  ${severity}  ${bold(finding.title)}`);
  rule();
  write(`${bold("Status")}       ${green(finding.status.toUpperCase())}`);
  write(`${bold("Route")}        ${finding.routeId}`);
  write(`${bold("Oracle")}       ${finding.oracle}`);
  write();
  write(bold("Invariant"));
  write(`  ${finding.invariant}`);
  write();
  write(bold("Verdict"));
  write(`  ${finding.verdict}`);

  if (finding.evidence.notes.length > 0) {
    write();
    write(bold("Evidence"));
    for (const note of finding.evidence.notes) write(`  · ${note}`);
  }

  for (const [index, request] of finding.evidence.requests.entries()) {
    const response = finding.evidence.responses[index];
    write();
    write(bold(`Witness ${index + 1}`));
    write(`  ${blue(`${request.method} ${request.url}`)}`);
    for (const [name, value] of Object.entries(request.headers)) write(dim(`    ${name}: ${value}`));
    if (request.body !== undefined) write(dim(`    body: ${JSON.stringify(request.body).slice(0, 200)}`));
    if (response) {
      write(`  ${bold("->")} ${response.status}`);
      write(dim(`    digest: ${response.bodyDigest}`));
      for (const [name, value] of Object.entries(response.headers)) write(dim(`    ${name}: ${value}`));
      if (response.bodyPreview) write(dim(`    body: ${response.bodyPreview.slice(0, 300)}`));
    }
  }

  // Extra responses beyond the paired witnesses (state-mutation records before/after reads).
  for (const response of finding.evidence.responses.slice(finding.evidence.requests.length)) {
    write();
    write(bold("Observation"));
    write(`  ${response.status}  ${dim(response.bodyDigest)}`);
    if (response.bodyPreview) write(dim(`    body: ${response.bodyPreview.slice(0, 300)}`));
  }

  write();
  write(bold("Remediation"));
  write(`  ${finding.remediation}`);
  write();
  write(`${bold("Replay")}  ${green(finding.replay.command)}  ${dim(`(check ${finding.replay.checkId})`)}`);
}

async function findingsView(projectDir: string): Promise<void> {
  const report = await loadLatestReport(projectDir);
  const findings = report.result.findings;
  let selected = 0;

  while (true) {
    clear();
    header(projectDir);
    write(bold("FINDINGS"));
    write(dim(trustSummary(report.result)));
    write();

    if (findings.length === 0) {
      write(green("No mechanically confirmed findings."));
      const untested = report.result.outcomes.filter((outcome) => outcome.status !== "passed" && outcome.status !== "failed");
      if (untested.length > 0) {
        write();
        write(yellow(`${untested.length} check(s) produced no verdict:`));
        for (const outcome of untested) {
          write(`  ${(STATUS_COLOR[outcome.status] ?? dim)(outcome.status.padEnd(13))} ${outcome.checkId}  ${dim(outcome.reason)}`);
        }
      }
      await pause();
      return;
    }

    write(dim("  ID         SEVERITY  ORACLE                      ROUTE"));
    for (const [index, finding] of findings.entries()) {
      const marker = index === selected ? bold("❯") : " ";
      const severity = (SEVERITY_COLOR[finding.severity] ?? dim)(finding.severity.toUpperCase().padEnd(8));
      write(`${marker} ${finding.id}  ${severity}  ${finding.oracle.padEnd(26).slice(0, 26)}  ${dim(finding.routeId)}`);
      if (index === selected) write(`    ${finding.title}`);
    }
    write();
    write(dim("↑/↓ select   Enter open   v verify   q back"));

    const key = await keypress();
    if (isBack(key)) return;
    if (key === "up") selected = (selected + findings.length - 1) % findings.length;
    if (key === "down") selected = (selected + 1) % findings.length;
    if (isEnter(key)) { renderFindingDetail(findings[selected]!); await pause(); }
    if (key === "v") {
      const finding = findings[selected]!;
      clear();
      write(`Replaying ${finding.id}…`);
      try {
        const { reproduced } = await verifyFinding(projectDir, finding.id);
        write(reproduced ? red(`${finding.id} still reproduces.`) : green(`${finding.id} did not reproduce.`));
        if (!reproduced && finding.oracle === "State Mutation") {
          write(dim("A state-mutation finding may not reproduce because the first scan already changed the state."));
        }
      } catch (error) {
        write(red(`Verify failed: ${error instanceof Error ? error.message : "Unknown error"}`));
      }
      await pause();
    }
  }
}

/* --------------------------------------------------------- other sections */

async function coverageView(projectDir: string): Promise<void> {
  clear();
  header(projectDir);
  write(bold("SECURITY COVERAGE"));
  write();
  const planned = await coverageForProject(projectDir);
  write(`${bold("Planned")}   ${planned.coveredRoutes}/${planned.inScopeRoutes} routes have a check  (${planned.percent.toFixed(1)}%)`);

  const executed = await executionCoverageForProject(projectDir);
  if (!executed) {
    write(dim("Verified   unknown — no scan has been run yet"));
  } else {
    write(`${bold("Verified")}  ${executed.verifiedRoutes}/${executed.inScopeRoutes} routes reached a verdict  (${executed.verifiedPercent.toFixed(1)}%)`);
    write();
    const section = (label: string, ids: string[], colour: (text: string) => string): void => {
      if (ids.length === 0) return;
      write(colour(`${label} (${ids.length})`));
      for (const id of ids) write(`  ${id}`);
    };
    section("No oracle available", executed.unavailableRouteIds, magenta);
    section("Errored", executed.erroredRouteIds, magenta);
    section("Inconclusive", executed.inconclusiveRouteIds, yellow);
    if (executed.unverifiedRouteIds.length === 0) write(green("Every planned route reached a verdict."));
  }

  write();
  if (planned.uncoveredRouteIds.length > 0) {
    write(yellow(`Routes with no check at all (${planned.uncoveredRouteIds.length})`));
    for (const id of planned.uncoveredRouteIds) write(`  ${id}`);
  } else {
    write(green("Every in-scope route has at least one check."));
  }
  await pause();
}

async function configurationView(projectDir: string): Promise<void> {
  clear();
  header(projectDir);
  write(bold("CONFIGURATION") + dim("  (read-only)"));
  write();
  write(dim("Edit .trinker/runtime.json directly. It is gitignored and holds everything the"));
  write(dim("committed plan must not: target URLs, credentials, fixtures, and runtime values."));
  write();
  try {
    const runtime = await loadRuntime(projectDir);
    write(bold("Targets"));
    for (const [name, target] of Object.entries(runtime.targets)) {
      const allow = target.allowHosts.length > 0 ? ` allowHosts: ${target.allowHosts.join(", ")}` : "";
      write(`  ${name}: ${target.url}${dim(allow)}`);
    }
    write();
    write(bold("Identities"));
    const identities = Object.entries(runtime.identities);
    if (identities.length === 0) write(dim("  none configured"));
    for (const [name, identity] of identities) {
      // Header names only. Values are credentials and are never rendered.
      write(`  ${name}: ${Object.keys(identity.headers).join(", ") || dim("no headers")} ${dim("[values hidden]")}`);
    }
    write();
    write(bold("Fixtures"));
    const fixtures = Object.entries(runtime.fixtures);
    if (fixtures.length === 0) write(dim("  none configured"));
    for (const [name, bag] of fixtures) write(`  ${name}: ${Object.keys(bag).join(", ")}`);
    write();
    write(bold("Runtime values") + dim("  (treated as secret; names only)"));
    const values = Object.keys(runtime.values);
    write(values.length === 0 ? dim("  none configured") : `  ${values.join(", ")}`);
    write();
    write(`${bold("Mutations authorized")}  ${runtime.mutationAuthorized ? yellow("yes") : green("no")}`);
    write();
    write(green("Configuration is valid."));
  } catch (error) {
    write(red(`Configuration is invalid: ${error instanceof Error ? error.message : "Unknown error"}`));
  }
  await pause();
}

async function exportView(projectDir: string): Promise<void> {
  clear();
  header(projectDir);
  write(bold("EXPORT REPORT"));
  write();
  write("  m  Markdown");
  write("  j  JSON");
  write("  s  SARIF");
  write();
  write(dim("any other key cancels"));
  const key = await keypress();
  const format = key === "j" ? "json" : key === "s" ? "sarif" : key === "m" ? "markdown" : undefined;
  if (!format) return;
  write();
  write(`Exported: ${green(await exportLatestReport(projectDir, format))}`);
  await pause();
}

async function reportView(projectDir: string): Promise<void> {
  const report: SecurityReport = await loadLatestReport(projectDir);
  clear();
  header(projectDir);
  write(bold("LATEST SCAN"));
  write();
  write(`${bold("Plan")}      ${report.result.planId}`);
  write(`${bold("Scan")}      ${report.result.scanId}`);
  write(`${bold("Generated")} ${report.generatedAt}`);
  write(`${bold("Duration")}  ${report.result.durationMs}ms`);
  write(`${bold("LLM")}       ${report.result.tokens.runtimeInput + report.result.tokens.runtimeOutput} runtime tokens`);
  write();
  write(trustSummary(report.result));
  write();
  const c = report.result.checks;
  write([
    green(`${c.passed} passed`), red(`${c.failed} failed`), yellow(`${c.inconclusive} inconclusive`),
    magenta(`${c.errored} errored`), magenta(`${c.unavailable} unavailable`),
  ].join(dim("  ·  ")) + dim(`  (of ${c.planned} planned)`));
  write();
  write(bold("Check outcomes"));
  for (const outcome of report.result.outcomes) {
    write(`  ${(STATUS_COLOR[outcome.status] ?? dim)(outcome.status.padEnd(13))} ${outcome.checkId.padEnd(22).slice(0, 22)} ${dim(outcome.reason.slice(0, 80))}`);
  }
  await pause();
}

/* ------------------------------------------------------------------- shell */

interface MenuItem { label: string; hint: string; run?: (projectDir: string) => Promise<void> }

const MENU: MenuItem[] = [
  { label: "Run Security Scan", hint: "execute the plan against the configured target", run: runScanView },
  { label: "Findings", hint: "browse confirmed findings and their evidence", run: findingsView },
  { label: "Latest Scan", hint: "summary and per-check outcomes", run: reportView },
  { label: "Security Coverage", hint: "planned vs actually verified routes", run: coverageView },
  { label: "Export Report", hint: "write Markdown, JSON, or SARIF", run: exportView },
  { label: "Configuration", hint: "inspect .trinker/runtime.json", run: configurationView },
  { label: "Exit", hint: "leave the console" },
];

export async function launchTui(projectDir: string): Promise<void> {
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Interactive mode requires a TTY. Use `trinker run --ci` for automation.");
  }
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  const stopInput = startInput();

  let selected = 0;
  try {
    while (true) {
      clear();
      header(projectDir);
      write(dim("Deterministic scans. Zero runtime LLM tokens."));
      write();
      for (const [index, item] of MENU.entries()) {
        const active = index === selected;
        write(`${active ? bold("❯") : " "} ${active ? bold(item.label.padEnd(20)) : item.label.padEnd(20)} ${dim(item.hint)}`);
      }
      write();
      write(dim("↑/↓ navigate   Enter select   q quit"));

      const key = await keypress();
      if (isBack(key)) break;
      if (key === "up") selected = (selected + MENU.length - 1) % MENU.length;
      if (key === "down") selected = (selected + 1) % MENU.length;
      if (isEnter(key)) {
        const item = MENU[selected]!;
        if (!item.run) break;
        try {
          await item.run(projectDir);
        } catch (error) {
          clear();
          write(red(`Error: ${error instanceof Error ? error.message : "Unknown error"}`));
          await pause();
        }
      }
    }
  } finally {
    stopInput();
    input.setRawMode(false);
    input.pause();
    clear();
  }
}
