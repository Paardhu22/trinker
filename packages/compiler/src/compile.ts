import type { Plan } from "@trinker/core";
import { applyProposal, type ApplyProposalResult } from "./proposal.js";
import { addUsage, emptyUsage, TokenBudget, type CompilerProvider, type ProposalRequest, type TokenUsage } from "./provider.js";

export interface AssistedCompileOptions {
  plan: Plan;
  provider: CompilerProvider;
  /** Oracles with a real implementation. Proposals naming anything else are rejected. */
  availableOracles: readonly string[];
  /** Maximum tokens this compilation may spend. Required — there is no unlimited mode. */
  tokenBudget: number;
}

export interface AssistedCompileResult extends ApplyProposalResult {
  usage: TokenUsage;
  provider: string;
}

/**
 * Run one LLM-assisted compilation pass.
 *
 * The provider only ever sees the application's surface — routes, resources, and what the plan
 * already contains. It is never given credentials, a target URL, or runtime configuration, because
 * it has no need for them and they must not leave the machine.
 *
 * Whatever comes back is treated as untrusted input: it is parsed, filtered against the plan, and
 * re-validated before it becomes a plan. This function is the only place an LLM touches Trinker,
 * and it runs during `compile`, never during a scan.
 */
export async function compileWithProvider(options: AssistedCompileOptions): Promise<AssistedCompileResult> {
  const { plan, provider } = options;
  const budget = new TokenBudget(options.tokenBudget);

  const request: ProposalRequest = {
    routes: plan.surface.routes,
    resources: plan.surface.resources,
    availableOracles: [...options.availableOracles],
    allowedMethods: [...plan.safety.allowedMethods],
    existing: {
      identities: plan.identities,
      fixtures: plan.fixtures,
      invariants: plan.invariants,
      checks: plan.checks,
    },
  };

  budget.assertFits(provider.estimate?.(request) ?? 0);

  const response = await provider.propose(request);
  // Recorded before the proposal is used, so an overrun is reported even if the content is fine.
  budget.record(response.usage);

  const applied = applyProposal(plan, response.proposal, { availableOracles: options.availableOracles });
  return { ...applied, usage: addUsage(emptyUsage(), response.usage), provider: provider.name };
}
