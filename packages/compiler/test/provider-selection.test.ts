import { describe, expect, it } from "vitest";
import {
  API_KEY_ENV, DEFAULT_MODELS, isProviderName, PROVIDER_NAMES, ProviderError, selectProvider,
} from "../src/index.js";

describe("provider selection", () => {
  it("selects OpenAI, which is the default the CLI uses", () => {
    expect(selectProvider({ provider: "openai", apiKey: "k" }).name).toBe(`openai:${DEFAULT_MODELS.openai}`);
  });

  it("still selects Anthropic", () => {
    expect(selectProvider({ provider: "anthropic", apiKey: "k" }).name).toBe(`anthropic:${DEFAULT_MODELS.anthropic}`);
  });

  it("honours an explicit model for either provider", () => {
    expect(selectProvider({ provider: "openai", apiKey: "k", model: "gpt-5.6-luna" }).name).toBe("openai:gpt-5.6-luna");
    expect(selectProvider({ provider: "anthropic", apiKey: "k", model: "claude-sonnet-5" }).name).toBe("anthropic:claude-sonnet-5");
  });

  it("fails cleanly on an unknown provider instead of falling back to a default", () => {
    // Silently compiling with a provider nobody asked for would misattribute both cost and plan.
    expect(() => selectProvider({ provider: "gemini", apiKey: "k" })).toThrow(ProviderError);
    expect(() => selectProvider({ provider: "gemini", apiKey: "k" })).toThrow(/Unknown provider "gemini".*openai, anthropic/);
  });

  it("propagates the missing-key error from the provider it selected", () => {
    expect(() => selectProvider({ provider: "openai", apiKey: "" })).toThrow(/OPENAI_API_KEY/);
    expect(() => selectProvider({ provider: "anthropic", apiKey: "" })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("maps each provider to its own key variable", () => {
    expect(API_KEY_ENV).toEqual({ openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY" });
  });

  it("recognises exactly the providers it lists", () => {
    expect(PROVIDER_NAMES).toEqual(["openai", "anthropic"]);
    for (const name of PROVIDER_NAMES) expect(isProviderName(name)).toBe(true);
    expect(isProviderName("openai ")).toBe(false);
    expect(isProviderName("")).toBe(false);
  });
});
