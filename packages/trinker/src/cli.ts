#!/usr/bin/env node
import { cwd } from "node:process";
import { exitCodeForScan, type ScanEvent } from "@trinker/core";
import { renderReport, trustSummary, type ReportFormat } from "@trinker/report";
import { launchTui } from "./tui.js";
import {
  applyRecordedProposal, compileProject, coverageForProject, executionCoverageForProject,
  exportLatestReport, initialiseProject, llmCompileProject, runProject, verifyFinding,
} from "./workflow.js";

const [command, ...args] = process.argv.slice(2);
const projectDir = cwd();

// A closed stdout (`trinker run | head`) must not crash a scan mid-flight.
let stdoutOpen = true;
const onBrokenPipe = (error: NodeJS.ErrnoException): void => { if (error.code === "EPIPE") stdoutOpen = false; else throw error; };
process.stdout.on("error", onBrokenPipe);
process.stderr.on("error", onBrokenPipe);

const write = (value: unknown): void => {
  if (!stdoutOpen) return;
  try { process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`); }
  catch { stdoutOpen = false; }
};

const USAGE = `trinker - deterministic application security testing

  trinker                       interactive console (requires a TTY)
  trinker init                  create .trinker/runtime.json
  trinker compile [options]     extract routes into .trinker/plan.json
      --force                   discard authored checks and regenerate
      --openapi <file.json>     also ingest an OpenAPI document
      --llm                     ALSO ask a model to propose checks (opt-in, costs tokens)
      --provider <name>         openai (default) or anthropic
      --token-budget <n>        max tokens one LLM compilation may spend (default 60000)
      --model <id>              model to compile with (provider default if omitted)
      --apply                   with --llm, propose AND write in one call (no separate review)
      --apply-proposal          write the proposal already recorded, making no model call
  trinker coverage [--ci]       planned vs verified route coverage
  trinker run [options]         execute the plan
  trinker verify <finding-id>   replay the check behind a confirmed finding
                                exits 1 if it reproduces, 3 if it cannot be re-tested
  trinker report [--json|--sarif|--markdown]

run options:
  --ci                  non-interactive; print the report to stdout
  --format <fmt>        json | markdown | sarif (default json)
  --strict              treat inconclusive checks as a failure to test

'trinker run' never contacts a model. Only 'compile --llm' does, and only when you pass it.

exit codes:
  0  every planned check reached a verdict, nothing confirmed
  1  a violation was mechanically confirmed
  2  usage or configuration error
  3  the scan could not be trusted (a check errored or had no oracle)`;

const DEFAULT_TOKEN_BUDGET = 60_000;

function numericFlag(name: string, fallback: number): number {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const raw = args[index + 1];
  const value = Number(raw);
  if (raw === undefined || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} needs a positive whole number, for example ${name} ${fallback}.`);
  }
  return value;
}

/**
 * The LLM-assisted compile.
 *
 * Non-destructive by default: it records the proposal and prints what would change, and only
 * rewrites `.trinker/plan.json` when `--apply` is passed. The plan is a reviewed security artifact,
 * so a model's suggestion becomes one by a human's decision, not by running a command.
 */
async function compileWithLlm(openApiPath: string | undefined): Promise<void> {
  const { API_KEY_ENV, isProviderName, PROVIDER_NAMES } = await import("@trinker/compiler");

  const providerIndex = args.indexOf("--provider");
  const provider = providerIndex >= 0 ? args[providerIndex + 1] : "openai";
  if (provider === undefined || !isProviderName(provider)) {
    throw new Error(`Unknown provider "${provider ?? ""}". Available: ${PROVIDER_NAMES.join(", ")}.`);
  }

  const keyVariable = API_KEY_ENV[provider];
  const apiKey = process.env[keyVariable] ?? "";
  if (apiKey === "") throw new Error(`${keyVariable} is not set. Export it before using \`trinker compile --llm --provider ${provider}\`.`);

  const modelIndex = args.indexOf("--model");
  const apply = args.includes("--apply");

  const result = await llmCompileProject(projectDir, {
    provider,
    apiKey,
    ...(modelIndex >= 0 && args[modelIndex + 1] !== undefined ? { model: args[modelIndex + 1] } : {}),
    tokenBudget: numericFlag("--token-budget", DEFAULT_TOKEN_BUDGET),
    apply,
    ...(openApiPath !== undefined ? { openApiPath } : {}),
  });

  const record = result.record as Record<string, number | string>;
  write(`Compiled with ${record["provider"]} (prompt ${record["promptVersion"]}).`);
  if (!result.surfaceRefreshed) {
    write("Surface was NOT re-derived from source; the committed plan's routes were used as-is.");
    write("(Normal for a hand-declared or OpenAPI-derived surface.)");
  }
  write(`Tokens: ${record["inputTokens"]} in + ${record["outputTokens"]} out = ${record["totalTokens"]} of ${record["tokenBudget"]} budget.`);
  write(`Checks: ${record["checksProposed"]} proposed, ${record["checksAccepted"]} accepted, ${record["checksRejected"]} rejected, over ${record["routesConsidered"]} route(s).`);
  write("");

  const added = result.added;
  const total = added.identities.length + added.fixtures.length + added.invariants.length + added.checks.length;
  if (total === 0) write("No additions survived validation.");
  else {
    write("Proposed additions:");
    for (const [label, ids] of [["identity", added.identities], ["fixture", added.fixtures], ["invariant", added.invariants]] as const) {
      for (const id of ids) write(`  + ${label} ${id}`);
    }
    for (const id of added.checks) {
      write(`  + check ${id}`);
      const why = result.rationales[id];
      if (why) write(`      why: ${why}`);
    }
  }

  if (result.rejected.length > 0) {
    write("");
    write("Rejected by validation (never merged):");
    for (const item of result.rejected) write(`  - ${item.kind} ${item.id}: ${item.reason}`);
  }
  if (result.notes.length > 0) {
    write("");
    write("Compiler notes:");
    for (const note of result.notes) write(`  · ${note}`);
  }

  write("");
  write(`Full proposal written to ${result.proposalPath}`);
  write(result.applied
    ? "Applied to .trinker/plan.json. Review the diff before committing it."
    : "Nothing was written to .trinker/plan.json.\nReview the proposal, then run `trinker compile --apply-proposal` to apply exactly what you reviewed.");
}

/**
 * Apply the recorded proposal.
 *
 * Deliberately makes no model call: re-compiling to apply would produce a different proposal from
 * the one that was reviewed, because a model is not deterministic.
 */
async function applyProposalFile(): Promise<void> {
  const result = await applyRecordedProposal(projectDir);
  const record = result.record as Record<string, string | number>;
  write(`Applied the proposal recorded by ${record["provider"] ?? "the compiler"} (${record["totalTokens"] ?? "?"} tokens, already spent).`);
  const added = result.added;
  for (const [label, ids] of [["identity", added.identities], ["fixture", added.fixtures], ["invariant", added.invariants]] as const) {
    for (const id of ids) write(`  + ${label} ${id}`);
  }
  for (const id of added.checks) {
    write(`  + check ${id}`);
    const why = result.rationales[id];
    if (why) write(`      why: ${why}`);
  }
  write("");
  write("Written to .trinker/plan.json. No model was called. Review the diff before committing it.");
}

function parseFormat(value: string | undefined, fallback: ReportFormat): ReportFormat {
  if (value === undefined) return fallback;
  if (value === "json" || value === "markdown" || value === "sarif") return value;
  throw new Error(`Unknown --format "${value}". Use json, markdown, or sarif.`);
}

async function main(): Promise<void> {
  if (!command) return launchTui(projectDir);
  if (command === "help" || command === "--help" || command === "-h") { write(USAGE); return; }

  if (command === "init") {
    const result = await initialiseProject(projectDir);
    write(result.created.length ? `Created ${result.created.join(", ")}` : "Trinker is already initialized.");
    return;
  }

  if (command === "compile") {
    const openApiIndex = args.indexOf("--openapi");
    const openApiPath = openApiIndex >= 0 ? args[openApiIndex + 1] : undefined;
    if (openApiIndex >= 0 && openApiPath === undefined) throw new Error("Usage: trinker compile --openapi <file.json>");

    if (args.includes("--apply-proposal")) { await applyProposalFile(); return; }
    if (args.includes("--llm")) { await compileWithLlm(openApiPath); return; }

    const { plan, merged, addedRouteIds, removedRouteIds } = await compileProject(projectDir, {
      force: args.includes("--force"),
      ...(openApiPath !== undefined ? { openApiPath } : {}),
    });
    write(`Compiled ${plan.surface.routes.length} routes to .trinker/plan.json (${plan.planId}). Runtime LLM tokens: 0`);
    if (merged) {
      write(`Preserved ${plan.checks.length} check(s), ${plan.invariants.length} invariant(s), ${plan.identities.length} identity/identities.`);
      if (addedRouteIds.length) write(`New routes: ${addedRouteIds.join(", ")}`);
      if (removedRouteIds.length) write(`Routes no longer in source: ${removedRouteIds.join(", ")}`);
    }
    if (plan.checks.length === 0) {
      write("\nNo checks yet. Add identities, fixtures, invariants, and checks to .trinker/plan.json;\nsee docs/PLAN_AUTHORING.md. A plan with no checks tests nothing.");
    }
    return;
  }

  if (command === "coverage") {
    const planned = await coverageForProject(projectDir);
    const executed = await executionCoverageForProject(projectDir);
    if (args.includes("--ci")) { write(executed ?? planned); return; }
    write(`Planned coverage:  ${planned.percent.toFixed(1)}% (${planned.coveredRoutes}/${planned.inScopeRoutes} routes have a check)`);
    if (executed) {
      write(`Verified coverage: ${executed.verifiedPercent.toFixed(1)}% (${executed.verifiedRoutes}/${executed.inScopeRoutes} routes reached a verdict in the last scan)`);
      if (executed.unavailableRouteIds.length) write(`  No oracle:     ${executed.unavailableRouteIds.join(", ")}`);
      if (executed.erroredRouteIds.length) write(`  Errored:       ${executed.erroredRouteIds.join(", ")}`);
      if (executed.inconclusiveRouteIds.length) write(`  Inconclusive:  ${executed.inconclusiveRouteIds.join(", ")}`);
    } else {
      write("Verified coverage: unknown (no scan has been run yet)");
    }
    write(`Uncovered routes:  ${planned.uncoveredRouteIds.join(", ") || "none"}`);
    return;
  }

  if (command === "run") {
    const ci = args.includes("--ci");
    const strict = args.includes("--strict");
    const formatIndex = args.indexOf("--format");
    const format = parseFormat(formatIndex >= 0 ? args[formatIndex + 1] : undefined, "json");
    const onEvent = ci ? undefined : (event: ScanEvent) => write(`${event.type} ${JSON.stringify(event.data)}`);
    const { result, report } = await runProject(projectDir, onEvent);
    if (ci) write(renderReport(report, format));
    else {
      write(`\nScan complete: ${result.findings.length} confirmed findings. Runtime LLM tokens: 0`);
      write(trustSummary(result));
    }
    process.exitCode = exitCodeForScan(result, { strict });
    return;
  }

  if (command === "verify") {
    const findingId = args[0];
    if (!findingId) throw new Error("Usage: trinker verify <finding-id>");
    const { report, summary } = await verifyFinding(projectDir, findingId);
    write(renderReport(report, "markdown"));
    write(summary);
    // A replay asks a direct question, so an inconclusive answer is a failure to answer it, not a
    // clean result. `strict` makes that exit 3 rather than 0.
    process.exitCode = exitCodeForScan(report.result, { strict: true });
    return;
  }

  if (command === "report") {
    const format = parseFormat(
      args.includes("--sarif") ? "sarif" : args.includes("--json") ? "json" : args.includes("--markdown") ? "markdown" : undefined,
      "markdown",
    );
    write(await exportLatestReport(projectDir, format));
    return;
  }

  throw new Error(`Unknown command: ${command}\n\n${USAGE}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`trinker: ${error instanceof Error ? error.message : "Unknown error"}\n`);
  process.exitCode = 2;
});
