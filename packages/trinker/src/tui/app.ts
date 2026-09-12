import { emitKeypressEvents } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import type { Finding, ScanEvent } from "@trinker/core";
import { calculatePlanCoverage } from "@trinker/core";
import type { SecurityReport } from "@trinker/report";
import { applyScanEvent, emptyScanView, type ScanView } from "../scan-view.js";
import {
  applyRecordedProposal, coverageForProject, executionCoverageForProject, exportLatestReport,
  loadDashboard, loadLatestReport, loadPlan, loadRecordedProposal, loadRuntime, runProject,
  toggleMutationAuthorized, verifyFinding, type DashboardModel, type RecordedProposal,
} from "../workflow.js";
import { unifiedFrame, MENU } from "./chrome.js";
import { fit } from "./render.js";
import {
  compilerScreen, configScreen, coverageScreen, dashboardScreen, exportScreen, findingDetailScreen,
  findingsScreen, helpScreen, reportScreen, scanScreen,
} from "./screens.js";
import { BG_APP, c, paintBackground } from "./theme.js";

/**
 * The console shell.
 *
 * Owns only navigation, input, and painting. Every number it shows comes from the workflow layer,
 * and every scan event comes from the runner's own bus — the console makes no security decision and
 * duplicates no engine logic.
 */

const VERSION = "0.1.0";
const MIN_WIDTH = 72;
const SIDEBAR = 30;

type ScreenId =
  | "dashboard" | "scan" | "compile" | "report" | "findings" | "finding"
  | "coverage" | "export" | "config" | "verify" | "help";

/* ------------------------------------------------------------------- input */

/**
 * Keystrokes are buffered by one persistent listener.
 *
 * stdin is in flowing mode, so a key arriving while the screen is painting would otherwise be
 * emitted to nobody and lost — which loses keys from a fast typist, a paste, or a scripted session.
 */
const pending: string[] = [];
let waiting: ((key: string) => void) | undefined;
let ended = false;

function startInput(): () => void {
  const push = (key: string): void => {
    if (waiting) { const resolve = waiting; waiting = undefined; resolve(key); }
    else pending.push(key);
  };
  const onKey = (_value: string, key: { name?: string; sequence?: string; ctrl?: boolean } | undefined): void => {
    if (key?.ctrl === true && key.name === "c") { push("q"); return; }
    push(key?.name ?? key?.sequence ?? "");
  };
  const onEnd = (): void => { ended = true; push("q"); };
  input.on("keypress", onKey);
  input.on("end", onEnd);
  input.on("close", onEnd);
  return () => { input.off("keypress", onKey); input.off("end", onEnd); input.off("close", onEnd); };
}

/** Wake the render loop without a real keystroke, so a resize repaints immediately. */
function nudge(): void {
  if (waiting) { const resolve = waiting; waiting = undefined; resolve("\u0000resize"); }
}

const keypress = (): Promise<string> => {
  const queued = pending.shift();
  if (queued !== undefined) return Promise.resolve(queued);
  if (ended) return Promise.resolve("q");
  return new Promise((resolve) => { waiting = resolve; });
};

const isEnter = (key: string): boolean => key === "return" || key === "enter";
const isBack = (key: string): boolean => key === "q" || key === "escape";
const digitOf = (key: string): number | undefined => (/^[0-9]$/.test(key) ? Number(key) : undefined);

/* ----------------------------------------------------------------- painting */

const clear = (): void => { output.write("\x1B[2J\x1B[H"); };

const size = (): { width: number; height: number } => ({
  width: Math.max(output.columns ?? 100, MIN_WIDTH),
  height: Math.max(output.rows ?? 30, 18),
});

/** Paint a full frame. Every line is padded and background-filled so panels read as blocks. */
function paint(lines: string[], width: number): void {
  clear();
  output.write(lines.map((line) => paintBackground(BG_APP, fit(line, width))).join("\n"));
  output.write("\n");
}

interface FrameOptions {
  width: number;
  height: number;
  selected: number;
  title: string;
  body: string[];
  hints: Array<[string, string]>;
}

/** Header, sidebar + main, footer. The unified layout matching the reference CLI design. */
function frame(options: FrameOptions): string[] {
  return unifiedFrame({
    width: options.width,
    height: options.height,
    selected: options.selected,
    title: options.title,
    body: options.body,
    hints: options.hints,
    sidebarWidth: SIDEBAR,
    version: VERSION,
    menuItems: MENU,
  });
}

const NAV_HINTS: Array<[string, string]> = [
  ["↑↓", "navigate"], ["Enter", "select"], ["1-9", "jump"], ["r", "refresh"], ["?", "help"], ["q", "quit"],
];

/* -------------------------------------------------------------------- app */

export async function launchTui(projectDir: string): Promise<void> {
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Interactive mode requires a TTY. Use `trinker run --ci` for automation.");
  }
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  const stopInput = startInput();
  // A resize wakes the loop rather than repainting behind its back, so the frame is rebuilt at the
  // new width instead of reusing a body laid out for the old one.
  const onResize = (): void => { nudge(); };
  output.on("resize", onResize);

  let selected = 0;
  let dashboard = await loadDashboard(projectDir);
  let status = "";

  const withStatus = (hints: Array<[string, string]>): Array<[string, string]> =>
    status === "" ? hints : [...hints, ["", status]];

  try {
    while (true) {
      const { width, height } = size();
      const body = dashboardScreen(dashboard, Math.max(width - SIDEBAR - 4, 20));
      paint(frame({ width, height, selected, title: TITLES.dashboard, body, hints: withStatus(NAV_HINTS) }), width);

      const key = await keypress();
      if (key === "\u0000resize") continue; // repaint at the new size
      status = "";
      if (isBack(key)) break;
      if (key === "?") {
        await showHelp(() => ({ ...size() }), selected);
        dashboard = await loadDashboard(projectDir);
        continue;
      }
      if (key === "/") {
        await findingsBrowser(projectDir, () => ({ ...size() }), selected, false, true);
        dashboard = await loadDashboard(projectDir);
        continue;
      }
      if (key === "up") { selected = (selected + MENU.length - 1) % MENU.length; continue; }
      if (key === "down") { selected = (selected + 1) % MENU.length; continue; }
      if (key === "r") { dashboard = await loadDashboard(projectDir); status = c.green("refreshed"); continue; }

      const digit = digitOf(key);
      if (digit !== undefined && digit >= 1 && digit <= MENU.length) { selected = digit - 1; continue; }

      if (isEnter(key)) {
        if (MENU[selected]?.label === "Exit") break;
        try {
          await activate(selected, projectDir, () => ({ ...size() }), selected);
        } catch (error) {
          await showMessage(c.red(error instanceof Error ? error.message : "Unknown error"), selected);
        }
        dashboard = await loadDashboard(projectDir);
      }
    }
  } finally {
    output.off("resize", onResize);
    stopInput();
    input.setRawMode(false);
    input.pause();
    clear();
  }
}

const TITLES: Record<ScreenId, string> = {
  dashboard: "DASHBOARD",
  scan: "LIVE SCAN",
  compile: "AI COMPILER",
  report: "SECURITY REPORT",
  findings: "FINDINGS",
  finding: "FINDING DETAIL",
  coverage: "SECURITY COVERAGE",
  export: "EXPORT REPORT",
  config: "CONFIGURATION",
  verify: "VERIFY FINDING",
  help: "HELP & KEYBOARD REFERENCE",
};

/* -------------------------------------------------------------- activation */

async function activate(index: number, projectDir: string, dimensions: () => { width: number; height: number }, selected: number): Promise<void> {
  const label = MENU[index]?.label;
  switch (label) {
    case "Run Security Scan": return runScanScreen(projectDir, dimensions, selected);
    case "Compile Security Plan": return compileScreen(projectDir, dimensions, selected);
    case "View Latest Report": return staticScreen("report", projectDir, dimensions, selected);
    case "View Findings": return findingsBrowser(projectDir, dimensions, selected, false);
    case "Verify Finding": return findingsBrowser(projectDir, dimensions, selected, true);
    case "Security Coverage": return staticScreen("coverage", projectDir, dimensions, selected);
    case "Export Report": return exportFlow(projectDir, dimensions, selected);
    case "Configuration": return staticScreen("config", projectDir, dimensions, selected);
    default: return;
  }
}

const render = (screen: ScreenId, body: string[], dimensions: () => { width: number; height: number }, selected: number, hints: Array<[string, string]>): void => {
  const { width, height } = dimensions();
  paint(frame({ width, height, selected, title: TITLES[screen], body, hints }), width);
};

async function showMessage(message: string, selected: number): Promise<void> {
  render("dashboard", ["", message], () => ({ ...size() }), selected, [["any key", "back"]]);
  await keypress();
}

async function showHelp(dimensions: () => { width: number; height: number }, selected: number): Promise<void> {
  let scroll = 0;
  while (true) {
    const { width, height } = dimensions();
    const mw = Math.max(width - SIDEBAR - 4, 20);
    const lines = helpScreen(mw).slice(scroll);
    render("help", lines, dimensions, selected, [["↑↓", "scroll"], ["q / Esc / any key", "back"]]);
    const key = await keypress();
    if (key === "\u0000resize") continue;
    if (isBack(key) || key === "?" || isEnter(key) || key === " ") return;
    if (key === "down") { scroll += 1; continue; }
    if (key === "up") { scroll = Math.max(scroll - 1, 0); continue; }
    if (key === "pagedown") { scroll += Math.max(height - 18, 5); continue; }
    if (key === "pageup") { scroll = Math.max(scroll - Math.max(height - 18, 5), 0); continue; }
    return;
  }
}

/* ------------------------------------------------------------- live scan */

async function runScanScreen(projectDir: string, dimensions: () => { width: number; height: number }, selected: number): Promise<void> {
  const plan = await loadPlan(projectDir);
  const plannedCheckIds = plan.checks.filter((check) => check.enabled).map((check) => check.id).sort((a, b) => a.localeCompare(b));
  const routeById = new Map(plan.surface.routes.map((route) => [route.id, route]));
  const checkLabels: Record<string, string> = {};
  for (const check of plan.checks) {
    const route = routeById.get(check.request.routeId);
    if (route) checkLabels[check.id] = `${route.method} ${route.pathTemplate}`;
  }

  let view: ScanView = emptyScanView();
  const startedAt = Date.now();
  const draw = (): void => {
    const { width, height } = dimensions();
    render("scan", scanScreen({
      view, plannedCheckIds, elapsedMs: Date.now() - startedAt,
      width: Math.max(width - SIDEBAR - 4, 20), height,
      checkLabels,
    }), dimensions, selected, [["", c.dim("scanning…")]]);
  };

  // Repaint on a timer too, so elapsed time advances during a slow request.
  const ticker = setInterval(draw, 250);
  const onEvent = (event: ScanEvent): void => { view = applyScanEvent(view, event); draw(); };

  try {
    await runProject(projectDir, onEvent);
  } catch (error) {
    view = { ...view, failure: error instanceof Error ? error.message : "Scan failed", done: true };
  } finally {
    clearInterval(ticker);
  }
  draw();
  render("scan", scanScreen({
    view, plannedCheckIds, elapsedMs: Date.now() - startedAt,
    width: Math.max(dimensions().width - SIDEBAR - 4, 20), height: dimensions().height,
    checkLabels,
  }), dimensions, selected, [["any key", "back"]]);
  await keypress();
}

/* --------------------------------------------------------------- findings */

async function findingsBrowser(
  projectDir: string,
  dimensions: () => { width: number; height: number },
  selected: number,
  verifyMode = false,
  startSearching = false,
): Promise<void> {
  const report = await loadLatestReport(projectDir);
  const plan = await loadPlan(projectDir);
  const routeById = new Map(plan.surface.routes.map((route) => [route.id, route]));
  const routeLabel = (routeId: string): string => {
    const route = routeById.get(routeId);
    return route ? `${route.method} ${route.pathTemplate}` : routeId;
  };

  const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const all = [...report.result.findings].sort((a, b) => {
    const sA = SEVERITY_ORDER[a.severity.toLowerCase()] ?? 5;
    const sB = SEVERITY_ORDER[b.severity.toLowerCase()] ?? 5;
    return sA !== sB ? sA - sB : a.id.localeCompare(b.id);
  });

  let cursor = 0;
  let query = "";
  let searching = startSearching;
  let status = "";

  while (true) {
    const findings = query === ""
      ? all
      : all.filter((finding) => `${finding.id} ${finding.title} ${finding.severity} ${routeLabel(finding.routeId)}`.toLowerCase().includes(query.toLowerCase()));
    cursor = Math.min(cursor, Math.max(findings.length - 1, 0));

    const { width, height } = dimensions();
    const hints: Array<[string, string]> = searching
      ? [["type", "filter"], ["Enter", "done"], ["Esc", "clear"]]
      : verifyMode
        ? [["Enter / v", "re-test finding"], ["↑↓", "select"], ["1-9", "jump"], ["q", "back"]]
        : [["↑↓", "select"], ["Enter", "open"], ["v", "verify"], ["/", "search"], ["1-9", "jump"], ["q", "back"]];
    const screenTitle = verifyMode ? "verify" : "findings";
    render(screenTitle, findingsScreen({
      findings, routeLabel, selected: cursor, query, searching,
      width: Math.max(width - SIDEBAR - 4, 20), height: height - 12,
    }).concat(status === "" ? [] : ["", status]), dimensions, selected, hints);

    const key = await keypress();
    if (key === "\u0000resize") continue;
    status = "";

    if (searching) {
      if (isEnter(key)) { searching = false; continue; }
      if (key === "escape") { searching = false; query = ""; continue; }
      if (key === "backspace") { query = query.slice(0, -1); continue; }
      if (key.length === 1) query += key;
      continue;
    }

    if (isBack(key)) return;
    if (key === "?") { await showHelp(dimensions, selected); continue; }
    if (key === "/") { searching = true; continue; }
    if (findings.length === 0) continue;
    if (key === "up") { cursor = (cursor + findings.length - 1) % findings.length; continue; }
    if (key === "down") { cursor = (cursor + 1) % findings.length; continue; }
    if (key === "home") { cursor = 0; continue; }
    if (key === "end") { cursor = Math.max(findings.length - 1, 0); continue; }
    if (key === "pagedown") { cursor = Math.min(cursor + 5, findings.length - 1); continue; }
    if (key === "pageup") { cursor = Math.max(cursor - 5, 0); continue; }

    const digit = digitOf(key);
    if (digit !== undefined && digit >= 1 && digit <= findings.length) {
      cursor = digit - 1;
      continue;
    }

    const finding = findings[cursor];
    if (finding === undefined) continue;
    if (verifyMode && isEnter(key)) {
      status = c.dim(`Verifying ${finding.id}…`);
      render(screenTitle, findingsScreen({
        findings, routeLabel, selected: cursor, query, searching,
        width: Math.max(width - SIDEBAR - 4, 20), height: height - 12,
      }).concat(["", status]), dimensions, selected, hints);
      status = await replay(projectDir, finding);
      continue;
    }
    if (key === "v") {
      status = c.dim(`Verifying ${finding.id}…`);
      render(screenTitle, findingsScreen({
        findings, routeLabel, selected: cursor, query, searching,
        width: Math.max(width - SIDEBAR - 4, 20), height: height - 12,
      }).concat(["", status]), dimensions, selected, hints);
      status = await replay(projectDir, finding);
      continue;
    }
    if (isEnter(key)) {
      await findingDetail(finding, routeLabel(finding.routeId), dimensions, selected);
      continue;
    }
  }
}

async function findingDetail(finding: Finding, routeLabel: string, dimensions: () => { width: number; height: number }, selected: number): Promise<void> {
  let scroll = 0;
  while (true) {
    const { width, height } = dimensions();
    const lines = findingDetailScreen(finding, routeLabel, Math.max(width - SIDEBAR - 4, 20), scroll);
    render("finding", lines, dimensions, selected, [["↑↓", "scroll"], ["PgUp/PgDn", "page"], ["q", "back"]]);
    const key = await keypress();
    if (key === "\u0000resize") continue;
    if (isBack(key)) return;
    if (key === "?") { await showHelp(dimensions, selected); continue; }
    if (key === "down") { scroll += 1; continue; }
    if (key === "up") { scroll = Math.max(scroll - 1, 0); continue; }
    if (key === "pagedown") { scroll += Math.max(height - 18, 5); continue; }
    if (key === "pageup") { scroll = Math.max(scroll - Math.max(height - 18, 5), 0); continue; }
  }
}

async function replay(projectDir: string, finding: Finding): Promise<string> {
  try {
    const { verdict, summary } = await verifyFinding(projectDir, finding.id);
    const paint = verdict === "reproduced" ? c.red : verdict === "not-reproduced" ? c.green : c.yellow;
    return paint(summary);
  } catch (error) {
    return c.red(error instanceof Error ? error.message : "Verify failed");
  }
}

/* ------------------------------------------------------------ static screens */

async function staticScreen(screen: ScreenId, projectDir: string, dimensions: () => { width: number; height: number }, selected: number): Promise<void> {
  let scroll = 0;
  let status = "";
  while (true) {
    const { width, height } = dimensions();
    const mainWidth = Math.max(width - SIDEBAR - 4, 20);
    const lines = await buildStatic(screen, projectDir, mainWidth, scroll);
    const hints: Array<[string, string]> = screen === "config"
      ? [["m", "toggle mutations"], ["↑↓", "scroll"], ["q", "back"]]
      : [["↑↓", "scroll"], ["PgUp/PgDn", "page"], ["q", "back"]];
    const withStatus: Array<[string, string]> = status === "" ? hints : [...hints, ["", status] as [string, string]];
    render(screen, lines.concat(status === "" ? [] : ["", status]), dimensions, selected, withStatus);
    const key = await keypress();
    if (key === "\u0000resize") continue;
    status = "";
    if (isBack(key)) return;
    if (key === "?") { await showHelp(dimensions, selected); continue; }
    if (key === "down") { scroll += 1; continue; }
    if (key === "up") { scroll = Math.max(scroll - 1, 0); continue; }
    if (key === "pagedown") { scroll += Math.max(height - 18, 5); continue; }
    if (key === "pageup") { scroll = Math.max(scroll - Math.max(height - 18, 5), 0); continue; }

    if (screen === "config" && key === "m") {
      try {
        const authorized = await toggleMutationAuthorized(projectDir);
        status = authorized ? c.yellow("✓ mutationAuthorized set to true (writes allowed)") : c.green("✓ mutationAuthorized set to false (writes forbidden)");
      } catch (err) {
        status = c.red(err instanceof Error ? err.message : "Failed to toggle mutation");
      }
      continue;
    }
  }
}

async function buildStatic(screen: ScreenId, projectDir: string, width: number, scroll: number): Promise<string[]> {
  if (screen === "report") {
    const report: SecurityReport = await loadLatestReport(projectDir);
    return reportScreen(report, width, scroll);
  }
  if (screen === "coverage") {
    const plan = await loadPlan(projectDir);
    const planned = calculatePlanCoverage(plan);
    const executed = await executionCoverageForProject(projectDir);
    let outcomes: SecurityReport["result"]["outcomes"] = [];
    try { outcomes = (await loadLatestReport(projectDir)).result.outcomes; } catch { /* no scan yet */ }
    const { ORACLES } = await import("../workflow.js");
    return coverageScreen({ planned, executed, outcomes, oracles: ORACLES.map((oracle) => oracle.name), width }).slice(scroll);
  }
  // configuration
  try {
    const runtime = await loadRuntime(projectDir);
    return configScreen(runtime, undefined, `${projectDir}/.trinker/runtime.json`, width).slice(scroll);
  } catch (error) {
    return configScreen(undefined, error instanceof Error ? error.message : "unreadable", `${projectDir}/.trinker/runtime.json`, width).slice(scroll);
  }
}

/* ------------------------------------------------------------------ export */

async function exportFlow(projectDir: string, dimensions: () => { width: number; height: number }, selected: number): Promise<void> {
  const { width } = dimensions();
  render("export", exportScreen(undefined, Math.max(width - SIDEBAR - 4, 20)), dimensions, selected, [["m/j/s", "format"], ["q", "cancel"]]);
  const key = await keypress();
  if (key === "?") { await showHelp(dimensions, selected); return; }
  const format = key === "j" ? "json" : key === "s" ? "sarif" : key === "m" ? "markdown" : undefined;
  if (format === undefined) return;
  const path = await exportLatestReport(projectDir, format);
  render("export", exportScreen(path, Math.max(dimensions().width - SIDEBAR - 4, 20)), dimensions, selected, [["any key", "back"]]);
  await keypress();
}

/* ---------------------------------------------------------------- compiler */

async function compileScreen(projectDir: string, dimensions: () => { width: number; height: number }, selected: number): Promise<void> {
  const plan = await loadPlan(projectDir);
  const routeById = new Map(plan.surface.routes.map((route) => [route.id, route]));
  const planLabel = (routeId: string): string => {
    const route = routeById.get(routeId);
    return route ? `${route.method} ${route.pathTemplate}` : routeId;
  };

  let proposal: RecordedProposal | undefined = await loadRecordedProposal(projectDir);
  let error: string | undefined;
  let scroll = 0;

  while (true) {
    const { width, height } = dimensions();
    const mainWidth = Math.max(width - SIDEBAR - 4, 20);
    const lines = compilerScreen({ proposal, planLabel, width: mainWidth, error }).slice(scroll);
    const hints: Array<[string, string]> = proposal === undefined
      ? [["c", "compile with AI"], ["q", "back"]]
      : [["a", "accept & apply"], ["c", "re-compile"], ["↑↓", "scroll"], ["q", "back"]];
    render("compile", lines, dimensions, selected, hints);

    const key = await keypress();
    if (key === "\u0000resize") continue;
    if (isBack(key)) return;
    if (key === "?") { await showHelp(dimensions, selected); continue; }
    if (key === "down") { scroll += 1; continue; }
    if (key === "up") { scroll = Math.max(scroll - 1, 0); continue; }
    if (key === "pagedown") { scroll += Math.max(height - 18, 5); continue; }
    if (key === "pageup") { scroll = Math.max(scroll - Math.max(height - 18, 5), 0); continue; }

    if (key === "c") {
      error = undefined;
      render("compile", compilerScreen({ proposal: undefined, planLabel, width: mainWidth, busy: "Asking the provider what should be tested…" }), dimensions, selected, [["", c.dim("working…")]]);
      try {
        const { llmCompileProject } = await import("../workflow.js");
        const { API_KEY_ENV } = await import("@trinker/compiler");
        const provider = process.env["TRINKER_PROVIDER"] ?? "openai";
        const variable = API_KEY_ENV[provider as keyof typeof API_KEY_ENV] ?? "OPENAI_API_KEY";
        const apiKey = process.env[variable] ?? "";
        if (apiKey === "") throw new Error(`${variable} is not set. Export it before compiling with ${provider}.`);
        await llmCompileProject(projectDir, { provider, apiKey, tokenBudget: 40_000 });
        proposal = await loadRecordedProposal(projectDir);
        scroll = 0;
      } catch (caught) {
        error = caught instanceof Error ? caught.message : "Compilation failed";
      }
      continue;
    }

    if (key === "a" && proposal !== undefined) {
      try {
        // Applies the recorded proposal. Deliberately makes no further model call, so what is
        // applied is exactly what was just reviewed.
        const applied = await applyRecordedProposal(projectDir);
        render("compile", [
          c.title("PROPOSAL APPLIED"), "",
          c.green(`${applied.added.checks.length} check(s) merged into .trinker/plan.json:`), "",
          ...applied.added.checks.map((id) => `  ${c.green("✓")} ${c.text(id)}`),
          "", c.faint("Applied with zero additional LLM tokens. Review the diff before committing it."),
        ], dimensions, selected, [["any key", "back"]]);
        await keypress();
        return;
      } catch (caught) {
        error = caught instanceof Error ? caught.message : "Apply failed";
      }
    }
  }
}
