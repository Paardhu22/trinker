import type { CompilerContext } from "../context.js";
import { COMPILER_PROMPT_VERSION, COMPILER_SYSTEM_PROMPT, buildUserPrompt } from "../prompt.js";
import { ProviderError, type CompilerProvider, type ProposalRequest, type ProposalResponse } from "../provider.js";
import {
  normaliseOpenAiProposal, OPENAI_PLAN_PROPOSAL_SCHEMA, OPENAI_WIRE_INSTRUCTIONS, OPENAI_WIRE_VERSION,
} from "./openai-wire.js";

/**
 * The OpenAI-backed compiler provider.
 *
 * Sits beside the Anthropic provider behind the same `CompilerProvider` interface, shares the same
 * versioned prompt and context builder, and feeds the same deterministic validation. Only the wire
 * encoding differs, because OpenAI's strict Structured Outputs mode is a narrower JSON Schema
 * subset — see `openai-wire.ts`.
 *
 * Like the Anthropic provider, the SDK is imported dynamically so that loading the compiler does
 * not pull a network client into the process, and `trinker run` never reaches this file at all.
 */

/**
 * Default model.
 *
 * `gpt-5.6-terra` ($2/$12 per MTok) rather than the frontier `gpt-6-astra` ($10/$50): compiling a
 * plan is a judgement task where a bad proposal costs a reviewer's time, so the cheapest tier is a
 * false economy, but it is not a task that needs the most expensive model available. Override with
 * `--model`.
 */
export const DEFAULT_OPENAI_MODEL = "gpt-5.6-terra";
const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;
const DEFAULT_TIMEOUT_MS = 180_000;

export interface OpenAiProviderOptions {
  /** Read from the environment by the caller. Never sourced from, or written to, the plan. */
  apiKey: string;
  model?: string | undefined;
  maxOutputTokens?: number | undefined;
  /** Milliseconds. */
  timeoutMs?: number | undefined;
  /** Override the endpoint, for a gateway. Also how the SDK path is tested locally. */
  baseUrl?: string | undefined;
  maxRetries?: number | undefined;
  /** Injected in tests so the provider runs without the real SDK or a network. */
  client?: ResponsesClient | undefined;
}

/** The narrow slice of the SDK this provider uses, so a fake can stand in for it in tests. */
export interface ResponsesClient {
  responses: {
    create(body: Record<string, unknown>): Promise<OpenAiResponse>;
  };
}

export interface OpenAiResponse {
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
  output_text?: string;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  status?: string;
  incomplete_details?: { reason?: string } | null;
}

export function createOpenAiProvider(options: OpenAiProviderOptions): CompilerProvider {
  if (!options.apiKey && !options.client) {
    throw new ProviderError("No API key. Set OPENAI_API_KEY before using `trinker compile --llm --provider openai`.");
  }
  const model = options.model ?? DEFAULT_OPENAI_MODEL;
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let clientPromise: Promise<ResponsesClient> | undefined;
  const client = async (): Promise<ResponsesClient> => {
    if (options.client) return options.client;
    clientPromise ??= loadSdk(options.apiKey, timeoutMs, options.baseUrl, options.maxRetries ?? 2);
    return clientPromise;
  };

  return {
    name: `openai:${model}`,

    estimate(request: ProposalRequest): number {
      const promptChars = COMPILER_SYSTEM_PROMPT.length + OPENAI_WIRE_INSTRUCTIONS.length
        + (isContext(request) ? buildUserPrompt(request).length : 0);
      return Math.ceil(promptChars / 3) + maxOutputTokens;
    },

    async propose(request: ProposalRequest): Promise<ProposalResponse> {
      if (!isContext(request)) {
        throw new ProviderError("The OpenAI provider needs a compiler context built by buildCompilerContext().");
      }

      const response = await send(await client(), {
        model,
        max_output_tokens: maxOutputTokens,
        input: [
          { role: "system", content: `${COMPILER_SYSTEM_PROMPT}\n\n${OPENAI_WIRE_INSTRUCTIONS}` },
          { role: "user", content: buildUserPrompt(request) },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "plan_proposal",
            schema: OPENAI_PLAN_PROPOSAL_SCHEMA,
            strict: true,
          },
        },
      }, options.apiKey);

      if (response.status === "incomplete") {
        const reason = response.incomplete_details?.reason ?? "unknown";
        throw new ProviderError(
          `The model stopped before finishing the proposal (${reason}). Nothing was applied; raise the output limit or narrow the surface.`,
        );
      }

      const text = outputTextOf(response);
      if (text.trim() === "") {
        throw new ProviderError(`The model returned no proposal text (status: ${response.status ?? "unknown"}).`);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Structured Outputs should make this impossible. Failing beats guessing: scraping checks
        // out of prose is how unintended content reaches a security plan.
        throw new ProviderError(`The model did not return valid JSON. First 200 characters: ${text.slice(0, 200)}`);
      }

      return {
        proposal: normaliseOpenAiProposal(parsed),
        usage: {
          input: response.usage?.input_tokens ?? 0,
          output: response.usage?.output_tokens ?? 0,
          calls: 1,
        },
        metadata: { model, promptVersion: `${COMPILER_PROMPT_VERSION}+${OPENAI_WIRE_VERSION}` },
      };
    },
  };
}

const isContext = (request: ProposalRequest): request is CompilerContext =>
  "applicationId" in request && "sourceExcerpts" in request;

/** Read the assistant text out of a Responses API reply, tolerating either shape the SDK exposes. */
function outputTextOf(response: OpenAiResponse): string {
  if (typeof response.output_text === "string" && response.output_text !== "") return response.output_text;
  return (response.output ?? [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((block) => block.type === "output_text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("");
}

async function send(client: ResponsesClient, body: Record<string, unknown>, apiKey: string): Promise<OpenAiResponse> {
  try {
    return await client.responses.create(body);
  } catch (error) {
    throw new ProviderError(redactSecret(describeSdkError(error), apiKey), { cause: error });
  }
}

/**
 * Strip the API key from an error message.
 *
 * An upstream error can quote the request it failed on, and compiler errors land in terminal output
 * and CI logs. The key must not travel with them.
 */
function redactSecret(message: string, secret: string): string {
  return secret.length >= 8 ? message.split(secret).join("[REDACTED]") : message;
}

/**
 * Turn an SDK failure into something actionable.
 *
 * Reports status and message only. Request bodies and headers carry the API key and the
 * application's surface, and neither belongs in a log.
 */
function describeSdkError(error: unknown): string {
  const status = typeof error === "object" && error !== null && "status" in error ? (error as { status?: unknown }).status : undefined;
  const message = error instanceof Error ? error.message : "Unknown provider error";
  switch (status) {
    case 401:
    case 403:
      return "OpenAI rejected the credentials. Check OPENAI_API_KEY.";
    case 404:
      return `OpenAI does not recognise that model. Check --model. (${message})`;
    case 429:
      return `Rate limited or out of quota at OpenAI. (${message})`;
    case 400:
      // Most often a schema the strict Structured Outputs subset will not accept.
      return `OpenAI rejected the request (HTTP 400): ${message}`;
    default:
      if (typeof status === "number" && status >= 500) return `OpenAI is unavailable (HTTP ${status}). Retry shortly.`;
      if (/timeout|aborted|ETIMEDOUT/i.test(message)) return `The request to OpenAI timed out. Raise the timeout or retry. (${message})`;
      return typeof status === "number" ? `OpenAI request failed (HTTP ${status}): ${message}` : `OpenAI request failed: ${message}`;
  }
}

async function loadSdk(apiKey: string, timeoutMs: number, baseUrl: string | undefined, maxRetries: number): Promise<ResponsesClient> {
  let OpenAI: new (options: Record<string, unknown>) => ResponsesClient;
  try {
    ({ default: OpenAI } = (await import("openai")) as unknown as {
      default: new (options: Record<string, unknown>) => ResponsesClient;
    });
  } catch (error) {
    throw new ProviderError(
      "The openai package is not installed. Install it to use `trinker compile --llm --provider openai`.",
      { cause: error },
    );
  }
  return new OpenAI({ apiKey, timeout: timeoutMs, maxRetries, ...(baseUrl !== undefined ? { baseURL: baseUrl } : {}) });
}
