import type { Plan } from "@trinker/core";
import { buildCompilerContext, type CompilerContext } from "./context.js";
import { COMPILER_PROMPT_VERSION } from "./prompt.js";
import { applyProposal, type ApplyProposalResult } from "./proposal.js";
import { addUsage, emptyUsage, TokenBudget, type CompilerProvider, type ProposalRequest, type TokenUsage } from "./provider.js";

export interface AssistedCompileOptions {
  plan: Plan;
  provider: CompilerProvider;
  /** Oracles with a real implementation. Proposals naming anything else are rejected. */
  availableOracles: readonly string[];
  /** Maximum tokens this compilation may spend. Required — there is no unlimited mode. */
  tokenBudget: number;
  /** Source root for route excerpts. Omit to send the surface without them. */
  rootDir?: string | undefined;
}

/**
 * What one compilation cost and produced.
 *
 * Recorded in full because cost efficiency is the point of compiling once and replaying forever:
 * spend has to be attributable to a provider, a model, and a prompt version, and comparable against
 * how much reviewed security knowledge it actually bought. This is the record a later cost
 * evaluation will aggregate.
 */
export interface CompilationRecord {
  provider: string;
  model: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  tokenBudget: number;
  checksProposed: number;
  checksAccepted: number;
  checksRejected: number;
  routesConsidered: number;
  compiledAt: string;
}

export interface AssistedCompileResult extends ApplyProposalResult {
  usage: TokenUsage;
  provider: string;
  record: CompilationRecord;
}

/**
 * Run one LLM-assisted compilation pass.
 *
 * The provider only ever sees the application's surface — routes, resources, narrow source
 * excerpts, and what the plan already contains. It is never given credentials, a target URL, or
 * runtime configuration, because it has no need for them and they must not leave the machine.
 *
 * Whatever comes back is treated as untrusted input: it is parsed, filtered against the plan, and
 * re-validated before it becomes a plan. This function is the only place an LLM touches Trinker,
 * and it runs during `compile`, never during a scan.
 */
export async function compileWithProvider(options: AssistedCompileOptions): Promise<AssistedCompileResult> {
  const { plan, provider } = options;
  const budget = new TokenBudget(options.tokenBudget);

  const context = await buildCompilerContext({
    plan,
    availableOracles: options.availableOracles,
    rootDir: options.rootDir,
  });
  assertNoRuntimeData(context);

  budget.assertFits(provider.estimate?.(context) ?? 0);

  const response = await provider.propose(context);
  // Recorded before the proposal is used, so an overrun is reported even if the content is fine.
  budget.record(response.usage);

  const applied = applyProposal(plan, response.proposal, { availableOracles: options.availableOracles });
  const proposed = countProposedChecks(response.proposal);

  return {
    ...applied,
    usage: addUsage(emptyUsage(), response.usage),
    provider: provider.name,
    record: {
      provider: provider.name,
      model: response.metadata?.model ?? "unknown",
      promptVersion: response.metadata?.promptVersion ?? COMPILER_PROMPT_VERSION,
      inputTokens: response.usage.input,
      outputTokens: response.usage.output,
      totalTokens: response.usage.input + response.usage.output,
      tokenBudget: options.tokenBudget,
      checksProposed: proposed,
      checksAccepted: applied.added.checks.length,
      checksRejected: applied.rejected.filter((item) => item.kind === "check").length,
      routesConsidered: plan.surface.routes.length,
      compiledAt: new Date().toISOString(),
    },
  };
}

/**
 * Belt and braces on the context boundary.
 *
 * `buildCompilerContext` never reads runtime configuration, but this is the one call that sends
 * data off the machine, so the absence of credentials is asserted here rather than assumed from
 * a function two modules away.
 */
function assertNoRuntimeData(context: CompilerContext): void {
  const fields = context as unknown as Record<string, unknown>;
  for (const forbidden of ["runtime", "targets", "credentials", "identitiesRuntime"]) {
    if (forbidden in fields) {
      throw new Error(`Compiler context must not carry runtime data, but it contains "${forbidden}".`);
    }
  }
}

const countProposedChecks = (proposal: unknown): number =>
  typeof proposal === "object" && proposal !== null && Array.isArray((proposal as { checks?: unknown }).checks)
    ? ((proposal as { checks: unknown[] }).checks).length
    : 0;

export type { ProposalRequest };
