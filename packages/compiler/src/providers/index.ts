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

const KEY_PAGES: Record<ProviderName, string> = {
  openai: "https://platform.openai.com/api-keys",
  anthropic: "https://console.anthropic.com/settings/keys",
};
const SDK_PACKAGES: Record<ProviderName, string> = { openai: "openai", anthropic: "@anthropic-ai/sdk" };

/**
 * What to do when a provider's key is missing, written for someone who has never set an
 * environment variable. Shown by both the CLI and the console, so the instructions cannot drift.
 */
export function apiKeyHelp(provider: ProviderName): string {
  const variable = API_KEY_ENV[provider];
  return [
    `${variable} is not set, so the AI compiler cannot run. Scanning does not need a key; only compiling with AI does.`,
    "",
    `1. Create a key at ${KEY_PAGES[provider]}`,
    "2. Set it in the terminal you run trinker from:",
    `     bash / zsh:   export ${variable}="your-key"`,
    `     fish:         set -gx ${variable} "your-key"`,
    `     PowerShell:   $env:${variable}="your-key"`,
    "   To keep it for new terminals, add the bash/zsh line to ~/.bashrc or ~/.zshrc.",
    `3. Install the SDK once:  npm install ${SDK_PACKAGES[provider]}   (add -g if trinker is installed globally)`,
    "4. Start trinker again from that same terminal.",
    "",
    "The key is only read from the environment. Never put it in .trinker/plan.json or commit it.",
    ...(provider === "openai" ? ["Using Anthropic instead? Pass --provider anthropic, or set TRINKER_PROVIDER=anthropic for the console."] : []),
  ].join("\n");
}

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
