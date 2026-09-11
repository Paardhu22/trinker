import type { CompilerContext } from "../context.js";
import { COMPILER_PROMPT_VERSION, COMPILER_SYSTEM_PROMPT, PLAN_PROPOSAL_JSON_SCHEMA, buildUserPrompt } from "../prompt.js";
import { ProviderError, type CompilerProvider, type ProposalRequest, type ProposalResponse } from "../provider.js";

/**
 * The Claude-backed compiler provider.
 *
 * This is the only file in Trinker that talks to a model API. It is reachable from `compile --llm`
 * and from nowhere else: the packages that execute a scan neither depend on nor import
 * `@trinker/compiler`, and `packages/core/test/architecture.test.ts` fails if that ever changes.
 *
 * The SDK is imported dynamically so that merely loading the compiler — which the CLI does for
 * every command — does not pull a network client into the process.
 */

export const DEFAULT_MODEL = "claude-opus-5";
const DEFAULT_MAX_TOKENS = 16_000;
const DEFAULT_TIMEOUT_MS = 120_000;

export interface AnthropicProviderOptions {
  /** Read from the environment by the caller. Never sourced from, or written to, the plan. */
  apiKey: string;
  model?: string | undefined;
  maxTokens?: number | undefined;
  /** Milliseconds. The SDK's own units for TypeScript. */
  timeoutMs?: number | undefined;
  /** Override the API endpoint, for a gateway or proxy. Also how the SDK path is tested locally. */
  baseUrl?: string | undefined;
  /** Retries for 429 and 5xx. Defaults to 2; a compilation is one call, so retrying is cheap. */
  maxRetries?: number | undefined;
  /** Injected in tests so the provider can be exercised without the real SDK or a network. */
  client?: MessageClient | undefined;
}

/** The narrow slice of the SDK this provider uses, so a fake can stand in for it in tests. */
export interface MessageClient {
  messages: {
    create(body: Record<string, unknown>): Promise<{
      content: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
      stop_reason?: string | null;
      stop_details?: { category?: string | null; explanation?: string | null } | null;
    }>;
  };
}

export function createAnthropicProvider(options: AnthropicProviderOptions): CompilerProvider {
  if (!options.apiKey && !options.client) {
    throw new ProviderError(
      "No API key. Set ANTHROPIC_API_KEY, or run `ant auth login`, before using `trinker compile --llm`.",
    );
  }
  const model = options.model ?? DEFAULT_MODEL;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let clientPromise: Promise<MessageClient> | undefined;
  const client = async (): Promise<MessageClient> => {
    if (options.client) return options.client;
    clientPromise ??= loadSdk(options.apiKey, timeoutMs, options.baseUrl, options.maxRetries ?? 2);
    return clientPromise;
  };

  return {
    name: `anthropic:${model}`,

    // Input is dominated by the prompt; output by the proposal. Both are deliberate
    // over-estimates, so the budget refuses a call it cannot afford rather than discovering the
    // overrun after paying for it.
    estimate(request: ProposalRequest): number {
      const context = request as CompilerContext;
      const promptChars = COMPILER_SYSTEM_PROMPT.length + (isContext(context) ? buildUserPrompt(context).length : 0);
      return Math.ceil(promptChars / 3) + maxTokens;
    },

    async propose(request: ProposalRequest): Promise<ProposalResponse> {
      if (!isContext(request)) {
        throw new ProviderError("The Claude provider needs a compiler context built by buildCompilerContext().");
      }

      const response = await send(await client(), {
        model,
        max_tokens: maxTokens,
        // The plan this produces is reviewed by a human and then replayed forever, so it is worth
        // thinking about properly. Cost is bounded by the token budget regardless.
        thinking: { type: "adaptive" },
        output_config: {
          effort: "high",
          format: { type: "json_schema", name: "plan_proposal", schema: PLAN_PROPOSAL_JSON_SCHEMA },
        },
        system: [
          // Stable prefix first so a repeated compilation of the same application can hit cache.
          { type: "text", text: COMPILER_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content: buildUserPrompt(request) }],
      }, options.apiKey);

      if (response.stop_reason === "refusal") {
        const category = response.stop_details?.category ?? "unspecified";
        throw new ProviderError(`The model declined to produce a plan (category: ${category}). Nothing was applied.`);
      }

      const text = response.content
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text ?? "")
        .join("");
      if (text.trim() === "") {
        throw new ProviderError(`The model returned no proposal text (stop_reason: ${response.stop_reason ?? "unknown"}).`);
      }

      return {
        proposal: parseProposal(text),
        usage: {
          input: response.usage?.input_tokens ?? 0,
          output: response.usage?.output_tokens ?? 0,
          calls: 1,
        },
        metadata: { model, promptVersion: COMPILER_PROMPT_VERSION },
      };
    },
  };
}

const isContext = (request: ProposalRequest): request is CompilerContext =>
  "applicationId" in request && "sourceExcerpts" in request;

/**
 * Parse the model's text as JSON.
 *
 * Structured output should make this exact, but a stray code fence is the one deviation worth
 * tolerating — everything beyond that is left to fail, because guessing at malformed output is how
 * unintended content reaches a security plan.
 */
function parseProposal(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    throw new ProviderError(
      `The model did not return valid JSON. First 200 characters: ${candidate.slice(0, 200)}`,
    );
  }
}

async function send(
  client: MessageClient,
  body: Record<string, unknown>,
  apiKey: string,
): Promise<Awaited<ReturnType<MessageClient["messages"]["create"]>>> {
  try {
    return await client.messages.create(body);
  } catch (error) {
    throw new ProviderError(redactSecret(describeSdkError(error), apiKey), { cause: error });
  }
}

/**
 * Strip the API key from an error message.
 *
 * An upstream error can quote the request it failed on, and compiler errors land in terminal
 * output and CI logs. The key must not travel with them.
 */
function redactSecret(message: string, secret: string): string {
  return secret.length >= 8 ? message.split(secret).join("[REDACTED]") : message;
}

/**
 * Turn an SDK failure into something actionable.
 *
 * Deliberately reports only status and message. Request bodies and headers can carry the API key
 * and the application's surface, and a compiler error ends up in terminal output and CI logs.
 */
function describeSdkError(error: unknown): string {
  const status = typeof error === "object" && error !== null && "status" in error ? (error as { status?: unknown }).status : undefined;
  const message = error instanceof Error ? error.message : "Unknown provider error";
  switch (status) {
    case 401:
    case 403:
      return "The provider rejected the credentials. Check ANTHROPIC_API_KEY, or re-run `ant auth login`.";
    case 404:
      return `The provider does not recognise that model. Check --model. (${message})`;
    case 429:
      return `Rate limited by the provider. Retry shortly. (${message})`;
    default:
      if (typeof status === "number" && status >= 500) return `The provider is unavailable (HTTP ${status}). Retry shortly.`;
      if (/timeout|aborted|ETIMEDOUT/i.test(message)) return `The provider timed out. Raise --timeout or retry. (${message})`;
      return typeof status === "number" ? `Provider request failed (HTTP ${status}): ${message}` : `Provider request failed: ${message}`;
  }
}

async function loadSdk(apiKey: string, timeoutMs: number, baseUrl: string | undefined, maxRetries: number): Promise<MessageClient> {
  let Anthropic: new (options: Record<string, unknown>) => MessageClient;
  try {
    ({ default: Anthropic } = (await import("@anthropic-ai/sdk")) as unknown as {
      default: new (options: Record<string, unknown>) => MessageClient;
    });
  } catch (error) {
    throw new ProviderError(
      "The @anthropic-ai/sdk package is not installed. Install it to use `trinker compile --llm`.",
      { cause: error },
    );
  }
  return new Anthropic({ apiKey, timeout: timeoutMs, maxRetries, ...(baseUrl !== undefined ? { baseURL: baseUrl } : {}) });
}
