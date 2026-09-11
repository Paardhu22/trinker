import { z } from "zod";

/**
 * The optional LLM boundary. No provider or network client is included in the MVP.
 * A future adapter must enforce this budget before every call and report real usage.
 */
export const TokenUsageSchema = z.object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative(), calls: z.number().int().nonnegative() }).strict();
export type TokenUsage = z.infer<typeof TokenUsageSchema>;
export class TokenBudget {
  private used = 0;
  public constructor(readonly limit: number) { if (!Number.isInteger(limit) || limit < 0) throw new Error("Token budget must be a non-negative integer"); }
  reserve(tokens: number): void { if (!Number.isInteger(tokens) || tokens < 0 || this.used + tokens > this.limit) throw new Error(`Compilation token budget exceeded (${this.used}/${this.limit})`); this.used += tokens; }
  get remaining(): number { return this.limit - this.used; }
}
