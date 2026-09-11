import { z } from "zod";
import type { Plan, Route } from "@trinker/core";

/**
 * The optional LLM boundary.
 *
 * No provider and no network client ships with Trinker. A provider is supplied by the caller, is
 * used only during `compile`, and is never reachable from the runner — that is what makes "a scan
 * costs zero tokens" a property of the dependency graph rather than a promise.
 */

export const TokenUsageSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
}).strict();
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const emptyUsage = (): TokenUsage => ({ input: 0, output: 0, calls: 0 });
export const addUsage = (left: TokenUsage, right: TokenUsage): TokenUsage => ({
  input: left.input + right.input,
  output: left.output + right.output,
  calls: left.calls + right.calls,
});

export class BudgetExceededError extends Error {
  public constructor(message: string) { super(message); this.name = "BudgetExceededError"; }
}

/**
 * A provider could not produce a proposal.
 *
 * Distinct from a validation failure: this means the model was never asked, refused, or answered
 * with something unusable. Messages must stay free of credentials and request bodies, because they
 * surface in terminal output and CI logs.
 */
export class ProviderError extends Error {
  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = "ProviderError";
  }
}

/**
 * Spend guard for a compilation.
 *
 * Two steps, deliberately: `assertFits` refuses a call whose estimate would overrun, and `record`
 * accounts for what the provider actually charged. A provider that reports more than it estimated
 * still trips the budget, so the overrun is visible rather than absorbed silently.
 */
export class TokenBudget {
  private used = 0;

  public constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 0) throw new Error("Token budget must be a non-negative integer");
  }

  /** Check an estimated cost before making a call. Consumes nothing. */
  assertFits(estimate: number): void {
    if (!Number.isInteger(estimate) || estimate < 0) throw new Error("Token estimate must be a non-negative integer");
    if (this.used + estimate > this.limit) {
      throw new BudgetExceededError(`Compilation would exceed its token budget: ${this.used} spent + ${estimate} estimated > ${this.limit} limit`);
    }
  }

  /** Account for what a call actually cost. Throws if the real cost overran the budget. */
  record(usage: TokenUsage): void {
    this.used += usage.input + usage.output;
    if (this.used > this.limit) {
      throw new BudgetExceededError(`Compilation exceeded its token budget: ${this.used} spent > ${this.limit} limit`);
    }
  }

  get spent(): number { return this.used; }
  get remaining(): number { return Math.max(this.limit - this.used, 0); }
}

/** What a provider is asked to reason about. Deliberately just the surface — never credentials. */
export interface ProposalRequest {
  /** The application's discovered routes. */
  routes: Route[];
  /** Resources inferred from shared path parameters. */
  resources: Plan["surface"]["resources"];
  /** Oracles that actually have an implementation. A proposal may not use anything else. */
  availableOracles: string[];
  /** HTTP methods the plan's safety policy already permits. A proposal may not widen this. */
  allowedMethods: string[];
  /** Identities, fixtures, invariants, and checks that already exist, so a provider can avoid duplicates. */
  existing: Pick<Plan, "identities" | "fixtures" | "invariants" | "checks">;
}

export interface ProposalResponse {
  /** Raw, unvalidated proposal. It is parsed and filtered before anything reaches a plan. */
  proposal: unknown;
  usage: TokenUsage;
  /** Recorded with the compilation so a plan can be traced to the model and prompt that produced it. */
  metadata?: { model?: string; promptVersion?: string } | undefined;
}

export interface CompilerProvider {
  readonly name: string;
  /** Rough token cost, checked against the budget before the call is made. */
  estimate?(request: ProposalRequest): number;
  propose(request: ProposalRequest): Promise<ProposalResponse>;
}
