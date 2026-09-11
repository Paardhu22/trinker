import { ProviderError, type CompilerProvider } from "../provider.js";
import { createAnthropicProvider, DEFAULT_MODEL as DEFAULT_ANTHROPIC_MODEL } from "./anthropic.js";
import { createOpenAiProvider, DEFAULT_OPENAI_MODEL } from "./openai.js";

export * from "./anthropic.js";
export * from "./openai.js";
export * from "./openai-wire.js";

/** Providers the compiler can be pointed at. Both author plans; neither ever executes a scan. */
export const PROVIDER_NAMES = ["openai", "anthropic"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export const isProviderName = (value: string): value is ProviderName =>
  (PROVIDER_NAMES as readonly string[]).includes(value);

/** Where each provider's key comes from. The key is only ever read from the environment. */
export const API_KEY_ENV: Record<ProviderName, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

export const DEFAULT_MODELS: Record<ProviderName, string> = {
  openai: DEFAULT_OPENAI_MODEL,
  anthropic: DEFAULT_ANTHROPIC_MODEL,
};

export interface SelectProviderOptions {
  provider: string;
  /** Read by the caller from the matching environment variable. */
  apiKey: string;
  model?: string | undefined;
  timeoutMs?: number | undefined;
  baseUrl?: string | undefined;
  maxRetries?: number | undefined;
}

/**
 * Build the requested provider.
 *
 * One place that knows which providers exist, so adding a third does not mean touching the CLI.
 * An unknown name fails here rather than falling back to a default: silently compiling with a
 * provider the operator did not ask for would misattribute both the cost and the plan.
 */
export function selectProvider(options: SelectProviderOptions): CompilerProvider {
  if (!isProviderName(options.provider)) {
    throw new ProviderError(`Unknown provider "${options.provider}". Available: ${PROVIDER_NAMES.join(", ")}.`);
  }
  const shared = {
    apiKey: options.apiKey,
    model: options.model,
    timeoutMs: options.timeoutMs,
    baseUrl: options.baseUrl,
    maxRetries: options.maxRetries,
  };
  return options.provider === "openai" ? createOpenAiProvider(shared) : createAnthropicProvider(shared);
}
