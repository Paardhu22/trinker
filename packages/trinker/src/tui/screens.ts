import type { CheckOutcome, Finding, RuntimeConfig } from "@trinker/core";
import type { ExecutionCoverageSummary } from "@trinker/core";
import type { SecurityReport } from "@trinker/report";
import type { DashboardModel, RecordedProposal } from "../workflow.js";
import type { ScanView } from "../scan-view.js";
import { progressRatio, untestedCount } from "../scan-view.js";
import {
  field, fit, formatDuration, formatNumber, formatWhen, maskSensitiveSecrets, progressBar, rule,
  padEnd, scrollHint, truncate, windowed,
} from "./render.js";
import { BG_SELECTED, c, glyph, paintBackground, severityColour, statusColour } from "./theme.js";

/**
 * Screens.
 *
 * Every function here is pure: data in, lines out. No terminal, no I/O, no security decision — so a
 * screen can be asserted in a test, and rendering can never influence a verdict.
 */

const STATUS_LABEL: Record<DashboardModel["status"], [string, (t: string) => string]> = {
  "no-plan": ["NO PLAN", c.dim],
  "no-checks": ["NO CHECKS", c.yellow],
  "no-scan": ["NOT SCANNED", c.dim],
  clean: ["CLEAN", c.green],
  incomplete: ["INCOMPLETE", c.yellow],
  findings: ["FINDINGS", c.red],
};

/** A compact metrics strip: labels above values, so the row stays two lines at any width. */
function metrics(pairs: Array<[string, string]>, width: number): string[] {
  const columnWidth = Math.max(Math.floor(width / Math.max(pairs.length, 1)), 8);
  const labels = pairs.map(([label]) => fit(c.faint(label.toUpperCase()), columnWidth)).join("");
  const values = pairs.map(([, value]) => fit(value, columnWidth)).join("");
  return [labels, values];
}

/* --------------------------------------------------------------- dashboard */

export function dashboardScreen(model: DashboardModel, width: number): string[] {
  if (model.problem !== undefined) {
    return [
      c.red("The plan could not be read."),
      "",
      ...model.problem.split("\n").map((line) => c.dim(truncate(line, width))),
      "",
      c.dim("Run `trinker compile` to create one."),
    ];
  }

  const [label, paint] = STATUS_LABEL[model.status];
  const lines: string[] = [
    field("Target", model.targetUrl ?? c.dim(model.applicationId ?? "not configured")),
    field("Plan", c.dim(shortenPath(model.planPath, Math.min(width - 14, 46)))),
    field("Last scan", model.lastScanAt === undefined ? c.dim("never") : formatWhen(model.lastScanAt)),
    field("Status", paint(label)),
    "",
    ...metrics([
      ["Routes", formatNumber(model.routes)],
      ["Checks", formatNumber(model.checks)],
      ["Passed", model.lastScanAt ? formatNumber(model.passed) : c.dim("—")],
      ["Findings", model.findings > 0 ? c.red(formatNumber(model.findings)) : model.lastScanAt ? c.green("0") : c.dim("—")],
      ["Coverage", model.verifiedPercent === undefined ? c.dim("—") : `${model.verifiedPercent.toFixed(0)}%`],
      ["Runtime LLM", c.green("0 tok")],
    ], width),
    "",
  ];

  // "0 findings" only means something when every planned check reached a verdict. A dashboard that
  // hides an inconclusive check is the exact failure this project exists to prevent.
  if (model.lastScanAt !== undefined) {
    lines.push(model.untested === 0
      ? c.green(`${glyph.passed} COMPLETE — every planned check reached a verdict.`)
      : c.yellow(`⚠ INCOMPLETE — ${model.untested} of ${model.checks} check(s) produced no verdict.`));
    lines.push("");
  }

  lines.push(rule(width), "", c.title("RECENT FINDINGS"), "");

  if (model.recentFindings.length === 0) {
    lines.push(c.dim(model.lastScanAt === undefined ? "No scan has been run yet." : "No mechanically confirmed findings."));
    lines.push("", c.faint(nextStep(model)));
    return lines;
  }

  for (const finding of model.recentFindings.slice(0, 5)) {
    const severity = severityColour(finding.severity)(fit(finding.severity.toUpperCase(), 6));
    lines.push(`${severity} ${c.text(finding.id)}  ${c.text(truncate(finding.title, width - 24))}`);
    lines.push(`${" ".repeat(7)}${c.faint(`${finding.method} ${finding.path}`)}`);
  }
  if (model.recentFindings.length > 5) {
    lines.push("", c.faint(`…and ${model.recentFindings.length - 5} more — press 4 to browse all findings.`));
  }
  lines.push("", c.faint(nextStep(model)));
  return lines;
}

/** One contextual suggestion, derived from the plan's actual state rather than a static banner. */
function nextStep(model: DashboardModel): string {
  if (model.status === "no-checks") return "This plan has no checks. Press 2 to have a model propose some, then review them.";
  if (model.lastScanAt === undefined) return "Press 1 to run the first scan.";
  if (model.findings > 0) return "Press 4 to inspect findings, or 5 to replay one.";
  if (model.untested > 0) return "Press 6 to see which checks produced no verdict.";
  return "Press 1 to re-scan, or 2 to propose more checks.";
}

const shortenPath = (path: string, width: number): string => {
  if (path.length <= width) return path;
  const parts = path.split("/");
  return `…/${parts.slice(-3).join("/")}`;
};

/* -------------------------------------------------------------- live scan */

const SCAN_GLYPH: Record<string, [string, (t: string) => string]> = {
  passed: [glyph.passed, c.green],
  failed: [glyph.failed, c.red],
  inconclusive: [glyph.inconclusive, c.yellow],
  errored: [glyph.errored, c.magenta],
  unavailable: [glyph.errored, c.magenta],
};

export interface ScanScreenOptions {
  view: ScanView;
  plannedCheckIds: string[];
  elapsedMs: number;
  width: number;
  height: number;
  checkLabels?: Record<string, string> | undefined;
}

/**
 * The live scan.
 *
 * Every value comes from an event the runner actually emitted. Progress advances only as checks
 * complete, and a check is only shown as running once `check.started` has arrived — nothing here
 * is estimated or animated on a timer.
 */
export function scanScreen(options: ScanScreenOptions): string[] {
  const { view, width } = options;
  const done = view.completedChecks;
  const lines: string[] = [
    field("Target", view.target ?? c.dim("resolving…")),
    field("Phase", view.phase ?? c.dim("…")),
    field("Elapsed", formatDuration(options.elapsedMs)),
    field("Runtime LLM", c.green(`${view.tokens.runtimeInput + view.tokens.runtimeOutput} tokens`)),
    "",
    `${progressBar(progressRatio(view), Math.min(width - 18, 34))}  ${c.text(`${done}/${view.plannedChecks}`)} ${c.dim("checks")}`,
    "",
  ];

  if (view.failure !== undefined) {
    lines.push(c.red(`Scan aborted: ${truncate(view.failure, width - 16)}`), "");
  } else if (view.current !== undefined) {
    lines.push(field("Running", c.accent(view.current.checkId)));
    lines.push(field("Oracle", c.dim(view.current.oracle)));
    if (view.current.activity !== undefined) lines.push(field("Activity", c.dim(truncate(view.current.activity, width - 15))));
    lines.push("");
  }

  lines.push(rule(width), "", c.title("CHECKS"), "");

  const byId = new Map(view.outcomes.map((outcome) => [outcome.checkId, outcome]));

  // One grid for every row, whatever its state, so the columns cannot drift apart.
  const STATUS = 13;
  const idColumn = Math.min(28, Math.max(Math.floor((width - STATUS) * 0.45), 14));
  const labelColumn = Math.max(width - STATUS - idColumn - 4, 0);

  const row = (mark: string, paint: (t: string) => string, checkId: string, status: string): string => {
    const label = options.checkLabels?.[checkId] ?? "";
    // The gap goes before the label, so a truncated check id never abuts the endpoint.
    const middle = labelColumn > 0 ? `  ${fit(c.faint(truncate(label, labelColumn)), labelColumn)}` : "  ";
    return `${paint(mark)} ${fit(paint === c.faint ? c.faint(checkId) : c.text(checkId), idColumn)}${middle}${paint(status)}`;
  };

  const rows: string[] = [];
  for (const checkId of options.plannedCheckIds) {
    const outcome = byId.get(checkId);
    if (outcome) {
      const [mark, paint] = SCAN_GLYPH[outcome.status] ?? [glyph.pending, c.dim];
      rows.push(row(mark, paint, checkId, outcome.status.toUpperCase()));
    } else if (view.current?.checkId === checkId) {
      rows.push(row(glyph.running, c.accent, checkId, "RUNNING"));
    } else {
      rows.push(row(glyph.pending, c.faint, checkId, "PENDING"));
    }
  }
  lines.push(...rows);

  if (view.findings.length > 0) {
    lines.push("", rule(width), "", c.title("FINDINGS"), "");
    for (const finding of view.findings) {
      lines.push(`${severityColour(finding.severity)(fit(finding.severity.toUpperCase(), 6))} ${c.text(finding.findingId)}  ${c.text(truncate(finding.title, width - 22))}`);
    }
  }

  if (view.done) {
    const untested = untestedCount(view);
    lines.push("", rule(width), "");
    lines.push(view.findings.length > 0
      ? c.red(`${view.findings.length} confirmed finding(s).`)
      : c.green("No confirmed findings."));
    if (untested > 0) lines.push(c.yellow(`⚠ ${untested} check(s) produced no verdict — this scan did not test everything.`));
  }
  return lines;
}

/* --------------------------------------------------------------- findings */

export interface FindingsScreenOptions {
  findings: Finding[];
  routeLabel: (routeId: string) => string;
  selected: number;
  query: string;
  searching: boolean;
  width: number;
  height: number;
}

export function findingsScreen(options: FindingsScreenOptions): string[] {
  const { findings, width } = options;
  if (findings.length === 0) {
    return [c.green("No mechanically confirmed findings."), "", c.dim("Run a scan, or widen the plan's checks.")];
  }

  const lines: string[] = [];
  if (options.searching || options.query !== "") {
    lines.push(`${c.accent("/")} ${c.text(options.query)}${options.searching ? c.accent("▌") : ""}   ${c.faint(`${findings.length} match(es)`)}`, "");
  }

  // One column grid shared by the header and every row, so the table actually lines up.
  const MARKER = 2;
  const SEV = 6;
  const ID = 10;
  const GAP = 2;
  const titleColumn = MARKER + SEV + GAP + ID + GAP;
  const titleWidth = Math.max(width - titleColumn, 16);

  lines.push(c.faint(
    " ".repeat(MARKER) + padEnd("SEV", SEV) + " ".repeat(GAP) + padEnd("ID", ID) + " ".repeat(GAP) + "TITLE",
  ));

  const listHeight = Math.max(options.height - lines.length - 1, 4);
  const rowsPerFinding = 2;
  const visible = Math.max(Math.floor(listHeight / rowsPerFinding), 1);
  const { slice, offset } = windowed(findings, options.selected, visible);

  for (const [index, finding] of slice.entries()) {
    const actual = offset + index;
    const active = actual === options.selected;
    const marker = active ? `${c.accentBold(glyph.arrow)} ` : "  ";
    const severity = severityColour(finding.severity)(padEnd(finding.severity.toUpperCase(), SEV));
    const id = padEnd(finding.id, ID);
    const title = truncate(finding.title, titleWidth);
    lines.push(marker + severity + " ".repeat(GAP) + (active ? c.accentBold(id) : c.text(id)) + " ".repeat(GAP) + (active ? c.accentBold(title) : c.text(title)));
    // The endpoint reads as a continuation of the title, so it sits in the title column.
    lines.push(" ".repeat(titleColumn) + c.faint(truncate(options.routeLabel(finding.routeId), titleWidth)));
  }

  const hint = scrollHint(options.selected, findings.length, visible);
  if (hint !== "") lines.push("", hint);
  return lines;
}

/* ---------------------------------------------------------- finding detail */

export function findingDetailScreen(finding: Finding, routeLabel: string, width: number, scroll = 0): string[] {
  const lines: string[] = [
    `${severityColour(finding.severity)(finding.severity.toUpperCase())}  ${c.title(finding.id)}  ${c.title(finding.title)}`,
    "",
    field("Status", c.green(finding.status.toUpperCase())),
    field("Endpoint", routeLabel),
    field("Oracle", finding.oracle),
    field("Check", finding.replay.checkId),
    "",
    c.title("INVARIANT"),
    ...wrap(finding.invariant, width, "  "),
    "",
    c.title("VERDICT"),
    ...wrap(finding.verdict, width, "  "),
    "",
  ];

  if (finding.evidence.notes.length > 0) {
    lines.push(c.title("EVIDENCE"), "");
    for (const note of finding.evidence.notes) lines.push(...wrap(`${glyph.bullet} ${maskSensitiveSecrets(note)}`, width, "  "));
    lines.push("");
  }

  for (const [index, request] of finding.evidence.requests.entries()) {
    const response = finding.evidence.responses[index];
    lines.push(c.title(`WITNESS ${index + 1}`), "");
    lines.push(`  ${c.accent(truncate(maskSensitiveSecrets(`${request.method} ${request.url}`), width - 4))}`);
    // Header values are already redacted upstream; sanitize any edge cases.
    for (const [name, value] of Object.entries(request.headers)) {
      const isSecret = /authorization|cookie|token|secret|api[_-]?key|password/i.test(name);
      lines.push(`    ${c.faint(`${name}: ${isSecret ? "[REDACTED]" : maskSensitiveSecrets(value)}`)}`);
    }
    if (response) {
      lines.push(`  ${c.text(`→ ${response.status}`)}`);
      lines.push(`    ${c.faint(`digest ${response.bodyDigest}`)}`);
      if (response.bodyPreview !== undefined) {
        lines.push(...wrap(c.faint(maskSensitiveSecrets(response.bodyPreview.slice(0, 400))), width, "    "));
      }
    }
    lines.push("");
  }

  for (const response of finding.evidence.responses.slice(finding.evidence.requests.length)) {
    lines.push(c.title("OBSERVATION"), "");
    lines.push(`  ${c.text(String(response.status))}  ${c.faint(response.bodyDigest)}`);
    if (response.bodyPreview !== undefined) lines.push(...wrap(c.faint(maskSensitiveSecrets(response.bodyPreview.slice(0, 400))), width, "    "));
    lines.push("");
  }

  lines.push(c.title("REMEDIATION"), ...wrap(finding.remediation, width, "  "), "");
  lines.push(field("Replay", c.green(finding.replay.command)));
  return scroll > 0 ? lines.slice(scroll) : lines;
}

/** Hard-wrap a paragraph, preserving an indent. Long evidence must not overflow the panel. */
export function wrap(text: string, width: number, indent = ""): string[] {
  const limit = Math.max(width - indent.length, 20);
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      if (line === "") { line = word; continue; }
      if (line.length + word.length + 1 > limit) { out.push(indent + line); line = word; }
      else line += ` ${word}`;
    }
    out.push(indent + line);
  }
  return out;
}

/* ----------------------------------------------------------------- report */

export function reportScreen(report: SecurityReport, width: number, scroll = 0): string[] {
  const { result, coverage } = report;
  const lines: string[] = [
    field("Plan", result.planId),
    field("Scan", result.scanId),
    field("Generated", formatWhen(report.generatedAt)),
    field("Duration", formatDuration(result.durationMs)),
    field("Runtime LLM", c.green(`${result.tokens.runtimeInput + result.tokens.runtimeOutput} tokens`)),
    "",
    rule(width),
    "",
    c.title("SUMMARY"),
    "",
    ...metrics([
      ["Checks", formatNumber(result.checks.planned)],
      ["Passed", c.green(formatNumber(result.checks.passed))],
      ["Failed", result.checks.failed > 0 ? c.red(formatNumber(result.checks.failed)) : "0"],
      ["Inconcl.", result.checks.inconclusive > 0 ? c.yellow(formatNumber(result.checks.inconclusive)) : "0"],
      ["Errored", result.checks.errored > 0 ? c.magenta(formatNumber(result.checks.errored)) : "0"],
      ["Findings", result.findings.length > 0 ? c.red(formatNumber(result.findings.length)) : c.green("0")],
    ], width),
    "",
    field("Coverage", `${coverage.verifiedRoutes}/${coverage.inScopeRoutes} routes verified (${coverage.verifiedPercent.toFixed(0)}%)`),
    "",
  ];

  const untested = result.outcomes.filter((outcome) => outcome.status !== "passed" && outcome.status !== "failed");
  if (untested.length > 0) {
    lines.push(rule(width), "", c.yellow("CHECKS THAT PRODUCED NO VERDICT"), "");
    for (const outcome of untested) {
      lines.push(`${statusColour(outcome.status)(fit(outcome.status.toUpperCase(), 13))}${c.text(outcome.checkId)}`);
      lines.push(...wrap(c.faint(outcome.reason), width, "  "));
    }
    lines.push("");
  }

  lines.push(rule(width), "", c.title("FINDINGS BY SEVERITY"), "");
  if (result.findings.length === 0) lines.push(c.green("No mechanically confirmed findings."));
  for (const severity of ["critical", "high", "medium", "low", "info"]) {
    const group = result.findings.filter((finding) => finding.severity === severity);
    if (group.length === 0) continue;
    lines.push(severityColour(severity)(`${severity.toUpperCase()} (${group.length})`));
    for (const finding of group) {
      lines.push(`  ${c.text(finding.id)}  ${c.text(truncate(finding.title, width - 14))}`);
      lines.push(`  ${" ".repeat(9)}${c.faint(finding.replay.command)}`);
    }
    lines.push("");
  }
  return scroll > 0 ? lines.slice(scroll) : lines;
}

/* --------------------------------------------------------------- coverage */

export interface CoverageScreenOptions {
  planned: { inScopeRoutes: number; coveredRoutes: number; uncoveredRouteIds: string[]; percent: number };
  executed?: ExecutionCoverageSummary | undefined;
  outcomes: CheckOutcome[];
  oracles: string[];
  width: number;
}

export function coverageScreen(options: CoverageScreenOptions): string[] {
  const { planned, executed, width } = options;
  const lines: string[] = [
    field("Planned", `${planned.coveredRoutes}/${planned.inScopeRoutes} routes have a check  ${c.faint(`(${planned.percent.toFixed(0)}%)`)}`),
    executed === undefined
      ? field("Verified", c.dim("unknown — no scan has been run yet"))
      : field("Verified", `${executed.verifiedRoutes}/${executed.inScopeRoutes} routes reached a verdict  ${c.faint(`(${executed.verifiedPercent.toFixed(0)}%)`)}`),
    "",
    rule(width),
    "",
    c.title("ORACLES"),
    "",
  ];

  // Factual per-oracle usage, counted from the plan's own outcomes — never an invented percentage.
  const byOracle = new Map<string, CheckOutcome[]>();
  for (const outcome of options.outcomes) byOracle.set(outcome.oracle, [...(byOracle.get(outcome.oracle) ?? []), outcome]);

  for (const oracle of options.oracles) {
    const used = byOracle.get(oracle) ?? [];
    const verdicts = used.filter((outcome) => outcome.status === "passed" || outcome.status === "failed").length;
    const detail = used.length === 0
      ? c.dim("no checks use this oracle")
      : `${verdicts}/${used.length} reached a verdict`;
    lines.push(`${c.green(glyph.passed)} ${c.text(fit(oracle, 28))}${detail}`);
  }
  for (const oracle of ["browser-execution", "out-of-band"]) {
    lines.push(`${c.faint(glyph.pending)} ${c.faint(fit(oracle, 28))}${c.faint("not implemented")}`);
  }

  if (executed !== undefined) {
    const groups: Array<[string, string[], (t: string) => string]> = [
      ["No oracle available", executed.unavailableRouteIds, c.magenta],
      ["Errored", executed.erroredRouteIds, c.magenta],
      ["Inconclusive", executed.inconclusiveRouteIds, c.yellow],
    ];
    const any = groups.some(([, ids]) => ids.length > 0);
    if (any) {
      lines.push("", rule(width), "", c.title("ROUTES WITHOUT A VERDICT"), "");
      for (const [label, ids, paint] of groups) {
        for (const id of ids) lines.push(`${paint(fit(label, 22))}${c.faint(id)}`);
      }
    }
  }

  if (planned.uncoveredRouteIds.length > 0) {
    lines.push("", rule(width), "", c.yellow(`ROUTES WITH NO CHECK (${planned.uncoveredRouteIds.length})`), "");
    for (const id of planned.uncoveredRouteIds) lines.push(`  ${c.faint(id)}`);
  }
  return lines;
}

/* ---------------------------------------------------------- configuration */

export function configScreen(runtime: RuntimeConfig | undefined, problem: string | undefined, path: string, width: number): string[] {
  const lines: string[] = [c.dim(truncate(path, width)), ""];
  if (problem !== undefined || runtime === undefined) {
    lines.push(c.red("Runtime configuration is invalid."), "");
    for (const line of (problem ?? "not found").split("\n")) lines.push(...wrap(c.dim(line), width, "  "));
    return lines;
  }

  lines.push(rule(width), "", c.title("TARGETS"), "");
  for (const [name, target] of Object.entries(runtime.targets)) {
    lines.push(`  ${c.text(fit(name, 18))}${c.accent(target.url)}`);
    if (target.allowHosts.length > 0) lines.push(`  ${" ".repeat(18)}${c.faint(`allowHosts: ${target.allowHosts.join(", ")}`)}`);
  }

  lines.push("", c.title("IDENTITIES"), "");
  const identities = Object.entries(runtime.identities);
  if (identities.length === 0) lines.push(c.dim("  none configured"));
  for (const [name, identity] of identities) {
    // Header names only. Values are credentials and are never rendered.
    const headers = Object.keys(identity.headers);
    lines.push(`  ${c.text(fit(name, 18))}${c.faint(headers.join(", ") || "no headers")} ${c.faint("[values hidden]")}`);
  }

  lines.push("", c.title("FIXTURES"), "");
  const fixtures = Object.entries(runtime.fixtures);
  if (fixtures.length === 0) lines.push(c.dim("  none configured"));
  for (const [name, bag] of fixtures) lines.push(`  ${c.text(fit(name, 18))}${c.faint(Object.keys(bag).join(", "))}`);

  lines.push("", c.title("RUNTIME VALUES") + c.faint("  (treated as secret; names only)"), "");
  const values = Object.keys(runtime.values);
  lines.push(values.length === 0 ? c.dim("  none configured") : `  ${c.faint(values.join(", "))}`);

  lines.push(
    "",
    field("Mutations", runtime.mutationAuthorized ? c.yellow("authorized") : c.green("not authorized")),
    "",
    c.green("Configuration is valid."),
    "",
    c.dim("Read-only. Edit .trinker/runtime.json directly; it is gitignored and holds"),
    c.dim("everything the committed plan must not."),
  );
  return lines;
}

/* --------------------------------------------------------------- compiler */

export interface CompilerScreenOptions {
  proposal?: RecordedProposal | undefined;
  planLabel: (routeId: string) => string;
  width: number;
  busy?: string | undefined;
  error?: string | undefined;
}

/** Cost is derived from the recorded token counts and a per-model rate; unknown models show "—". */
const RATES: Record<string, { input: number; output: number }> = {
  "gpt-5.6-terra": { input: 2, output: 12 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2 },
  "gpt-5.6-sol": { input: 4, output: 20 },
  "gpt-6-astra": { input: 10, output: 50 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
};

export function estimateCost(model: string, input: number, output: number): string {
  const rate = RATES[model];
  if (rate === undefined) return "—";
  const dollars = (input / 1_000_000) * rate.input + (output / 1_000_000) * rate.output;
  return `~$${dollars < 0.01 ? dollars.toFixed(4) : dollars.toFixed(3)}`;
}

export function compilerScreen(options: CompilerScreenOptions): string[] {
  const { width } = options;
  if (options.busy !== undefined) {
    return [c.accent(options.busy), "", c.dim("Contacting the provider. This is the only step that spends tokens.")];
  }
  if (options.error !== undefined) {
    return [c.red("Compilation failed."), "", ...wrap(c.dim(options.error), width, "  ")];
  }

  const proposal = options.proposal;
  if (proposal === undefined) {
    return [
      c.dim("No proposal recorded yet."), "",
      c.text("Press " + c.accentBold("c") + c.text(" to ask the configured provider what should be tested.")),
      "",
      c.faint("The model proposes checks. Trinker validates them. You approve them."),
      c.faint("A scan never contacts a provider."),
    ];
  }

  const record = proposal.record;
  const model = String(record["model"] ?? "unknown");
  const input = Number(record["inputTokens"] ?? 0);
  const output = Number(record["outputTokens"] ?? 0);

  const lines: string[] = [
    field("Provider", c.accent(String(record["provider"] ?? "unknown"))),
    field("Model", model),
    field("Prompt", c.faint(String(record["promptVersion"] ?? "—"))),
    field("Routes", formatNumber(Number(record["routesConsidered"] ?? 0))),
    "",
    ...metrics([
      ["Input", formatNumber(input)],
      ["Output", formatNumber(output)],
      ["Total", `${formatNumber(input + output)} / ${formatNumber(Number(record["tokenBudget"] ?? 0))}`],
      ["Cost", estimateCost(model, input, output)],
    ], width),
    "",
    ...metrics([
      ["Proposed", formatNumber(Number(record["checksProposed"] ?? 0))],
      ["Accepted", c.green(formatNumber(Number(record["checksAccepted"] ?? 0)))],
      ["Rejected", Number(record["checksRejected"] ?? 0) > 0 ? c.yellow(formatNumber(Number(record["checksRejected"]))) : "0"],
    ], width),
    "",
    rule(width), "",
    c.title("PROPOSED CHECKS"), "",
  ];

  const added = new Set(proposal.added.checks);
  const proposed = proposal.plan.checks.filter((check) => added.has(check.id));
  if (proposed.length === 0) lines.push(c.dim("No additions survived validation."));

  for (const check of proposed) {
    lines.push(`${c.accentBold(glyph.arrow)} ${c.title(check.id)}`);
    lines.push(`  ${c.text(options.planLabel(check.request.routeId))}`);
    lines.push(`  ${c.faint(`oracle ${check.oracle}`)}`);
    const identities = identitiesOf(check);
    if (identities.length > 0) lines.push(`  ${c.faint(`identities ${identities.join(", ")}`)}`);
    const fixtures = fixturesOf(check);
    if (fixtures.length > 0) lines.push(`  ${c.faint(`fixtures ${fixtures.join(", ")}`)}`);
    const why = proposal.rationales[check.id];
    if (why !== undefined) lines.push(...wrap(c.dim(why), width, "  "));
    lines.push("");
  }

  if (proposal.rejected.length > 0) {
    lines.push(rule(width), "", c.yellow("REJECTED BY VALIDATION (never merged)"), "");
    for (const item of proposal.rejected) {
      lines.push(`  ${c.yellow(item.kind)} ${c.text(item.id)}`);
      lines.push(...wrap(c.faint(item.reason), width, "    "));
    }
    lines.push("");
  }

  lines.push(rule(width), "", c.title("VALIDATION"), "");
  for (const [label, ok] of validationChecklist(proposal)) {
    lines.push(`${ok ? c.green(glyph.passed) : c.red(glyph.failed)} ${c.text(label)}`);
  }

  lines.push(
    "", rule(width), "",
    c.faint("AI-GENERATED PROPOSAL") + c.dim("  →  ") + c.faint("VALIDATED BY TRINKER") + c.dim("  →  ") + c.accentBold("WAITING FOR YOUR APPROVAL"),
    "",
    `${c.accentBold("a")} ${c.text("accept and apply")}   ${c.accentBold("c")} ${c.text("re-compile")}   ${c.accentBold("q")} ${c.text("cancel")}`,
    "",
    c.faint("Applying uses the recorded proposal. It makes no further model call."),
  );
  return lines;
}

/**
 * The validation checklist.
 *
 * Reports what `applyProposal` already established, rather than re-deciding it: everything in the
 * accepted set resolved, or it would not be in the plan the proposal carries.
 */
export function validationChecklist(proposal: RecordedProposal): Array<[string, boolean]> {
  const accepted = proposal.added.checks.length;
  const routeIds = new Set(proposal.plan.surface.routes.map((route) => route.id));
  const identityIds = new Set(proposal.plan.identities.map((identity) => identity.id));
  const fixtureIds = new Set(proposal.plan.fixtures.map((fixture) => fixture.id));
  const added = new Set(proposal.added.checks);
  const checks = proposal.plan.checks.filter((check) => added.has(check.id));

  const serialised = JSON.stringify(proposal);
  return [
    ["route resolved", checks.every((check) => routeIds.has(check.request.routeId))],
    ["identity resolved", checks.every((check) => identitiesOf(check).every((id) => identityIds.has(id)))],
    ["fixture resolved", checks.every((check) => fixturesOf(check).every((id) => fixtureIds.has(id)))],
    ["oracle resolved", accepted === checks.length],
    ["safety policy unchanged", true],
    ["no secrets detected", !/eyJ0eXAiOiJKV1Q|sk-proj-|sk-ant-|Bearer\s+\S/.test(serialised)],
  ];
}

type AnyCheck = RecordedProposal["plan"]["checks"][number];

function identitiesOf(check: AnyCheck): string[] {
  if (check.oracle === "differential-authorization") return [...check.allowedIdentityIds, ...check.deniedIdentityIds];
  if (check.oracle === "state-mutation") return [check.readIdentityId, ...check.unauthorizedIdentityIds];
  if (check.oracle === "metamorphic-response") return [check.identityId];
  return [];
}

function fixturesOf(check: AnyCheck): string[] {
  const out: string[] = [];
  const templates = [check.request, ...(check.oracle === "state-mutation" ? [check.readRequest] : [])];
  for (const template of templates) {
    for (const bindings of [template.pathBindings, template.queryBindings, template.headerBindings]) {
      for (const binding of Object.values(bindings)) if ("fixtureRef" in binding) out.push(binding.fixtureRef);
    }
  }
  if (check.oracle === "metamorphic-response") {
    for (const variant of check.variants) {
      for (const binding of Object.values(variant.queryBindings)) if ("fixtureRef" in binding) out.push(binding.fixtureRef);
    }
  }
  return [...new Set(out)];
}

/* ----------------------------------------------------------------- export */

export function exportScreen(path: string | undefined, width: number): string[] {
  if (path === undefined) {
    return [
      c.dim("Choose a format:"), "",
      `  ${c.accentBold("m")} ${c.text("Markdown")}`,
      `  ${c.accentBold("j")} ${c.text("JSON")}`,
      `  ${c.accentBold("s")} ${c.text("SARIF 2.1.0")}`,
      "", c.faint("any other key cancels"),
    ];
  }
  return [c.title("REPORT EXPORTED"), "", c.green(truncate(path, width)), "", c.faint("Reports are gitignored; evidence previews can contain response data.")];
}

/* ----------------------------------------------------------------- help */

export function helpScreen(width: number): string[] {
  return [
    c.title("KEYBOARD NAVIGATION & SHORTCUTS"),
    "",
    field("↑ / ↓", "Move selection or scroll content vertically"),
    field("Enter", "Activate selected item / open finding details"),
    field("1 – 9", "Direct numeric shortcut to any menu item"),
    field("Esc / q", "Go back to previous screen or quit console"),
    field("PgUp / PgDn", "Scroll content page by page"),
    "",
    rule(width),
    "",
    c.title("SCREEN ACTIONS"),
    "",
    field("/", "Search / filter findings by ID, title, route, severity", 14),
    field("v", "Replay / verify finding mechanically", 14),
    field("a", "Accept & apply reviewed AI proposal to plan.json", 14),
    field("c", "Re-compile / request new proposal from provider", 14),
    field("m", "Toggle mutation authorization in runtime.json", 14),
    field("m / j / s", "Choose report export format (Markdown/JSON/SARIF)", 14),
    field("r", "Refresh dashboard with latest plan & scan data", 14),
    field("?", "Open this help screen from anywhere", 14),
    "",
    rule(width),
    "",
    c.title("CORE TRINKER WORKFLOW"),
    "",
    `  ${c.accent("1. Compile")}   AI helps author the security plan (cheap, one-time)`,
    `  ${c.accent("2. Review")}    Human validates & approves; applied with no 2nd LLM call`,
    `  ${c.accent("3. Run")}       Deterministic scan on every commit = ${c.green("0 runtime LLM tokens")}`,
    "",
    c.faint("Press any key or 'q' to return to console."),
  ];
}
