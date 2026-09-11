import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { PlanSchema, type Plan } from "@trinker/core";
import { buildCompilerContext, compileWithProvider, createAnthropicProvider, ProviderError } from "../src/index.js";

/**
 * Exercises the real @anthropic-ai/sdk client against a local stub of the Messages API.
 *
 * The other provider tests inject a fake client, which verifies our logic but not that the request
 * we build actually survives the SDK. These do: the SDK serialises, transports, and parses for
 * real. What remains unverified without credentials is only Anthropic's own acceptance of the
 * request — see the real-provider status note in the session handoff.
 */

const ROUTE = "route_get_orders_11111111";

const plan = (): Plan => PlanSchema.parse({
  schemaVersion: 1, planId: "trkp_example", surfaceDigest: `sha256:${"a".repeat(64)}`,
  target: { applicationId: "shop", allowedTargetRefs: ["local"] },
  surface: {
    frameworks: ["express"],
    routes: [{ id: ROUTE, method: "GET", pathTemplate: "/orders/:id", parameters: [{ name: "id", location: "path", required: true }], sourceRefs: [], confidence: "high" }],
    resources: [],
  },
  identities: [], fixtures: [], invariants: [], checks: [],
  coverage: { inScopeRouteIds: [ROUTE], exclusions: [] },
  safety: { mutationPolicy: "forbid", allowedMethods: ["GET"] },
  provenance: { sources: [], compiler: { mode: "deterministic", compilerVersion: "0.1.0" } },
});

const proposalText = JSON.stringify({
  identities: [
    { id: "identity_owner", credentialRef: "owner", roles: ["user"], capabilities: [] },
    { id: "identity_peer", credentialRef: "peer", roles: ["user"], capabilities: [] },
  ],
  fixtures: [{ id: "fixture_order", runtimeRef: "order" }],
  invariants: [{ id: "inv_owner", kind: "authorization", statement: "Only the owner may read an order.", routeIds: [ROUTE], provenance: "llm-assisted" }],
  checks: [{
    id: "chk_owner", invariantId: "inv_owner", enabled: true, oracle: "differential-authorization",
    request: { routeId: ROUTE, pathBindings: { id: { fixtureRef: "fixture_order", field: "id" } }, queryBindings: {}, headerBindings: {} },
    allowedIdentityIds: ["identity_owner"], deniedIdentityIds: ["identity_peer"], calibration: { trials: 3 },
  }],
  rationales: { chk_owner: "Takes an :id path parameter." },
  notes: [],
});

interface Stub { url: string; requests: Array<{ headers: IncomingMessage["headers"]; body: Record<string, unknown> }> }

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

async function stubApi(respond: (body: Record<string, unknown>, res: ServerResponse) => void): Promise<Stub> {
  const requests: Stub["requests"] = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      requests.push({ headers: req.headers, body });
      respond(body, res);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, requests };
}

const ok = (res: ServerResponse, payload: unknown): void => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
};

const message = (text: string) => ({
  id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5",
  content: [{ type: "text", text }],
  stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 2480, output_tokens: 512 },
});

describe("the real SDK client", () => {
  it("sends a well-formed request the SDK accepts, and parses the reply", async () => {
    const stub = await stubApi((_body, res) => ok(res, message(proposalText)));
    const provider = createAnthropicProvider({ apiKey: "sk-ant-test-key", baseUrl: stub.url });

    const response = await provider.propose(await buildCompilerContext({ plan: plan(), availableOracles: ["differential-authorization"] }));

    expect(response.usage).toEqual({ input: 2480, output: 512, calls: 1 });
    expect((response.proposal as { checks: unknown[] }).checks).toHaveLength(1);

    const sent = stub.requests[0]!;
    expect(sent.headers["x-api-key"]).toBe("sk-ant-test-key");
    expect(sent.body["model"]).toBe("claude-opus-5");
    expect(sent.body["output_config"]).toMatchObject({ effort: "high", format: { type: "json_schema" } });
    expect(sent.body["thinking"]).toEqual({ type: "adaptive" });
  });

  it("carries the application surface but no credentials in the request body", async () => {
    const stub = await stubApi((_body, res) => ok(res, message(proposalText)));
    const provider = createAnthropicProvider({ apiKey: "sk-ant-test-key", baseUrl: stub.url });
    await provider.propose(await buildCompilerContext({ plan: plan(), availableOracles: ["differential-authorization"] }));

    const body = JSON.stringify(stub.requests[0]!.body);
    expect(body).toContain(ROUTE);
    expect(body).not.toContain("sk-ant-test-key");
  });

  it("completes the whole pipeline: request -> proposal -> validation -> merged plan", async () => {
    const stub = await stubApi((_body, res) => ok(res, message(proposalText)));
    const provider = createAnthropicProvider({ apiKey: "sk-ant-test-key", baseUrl: stub.url });

    const result = await compileWithProvider({
      plan: plan(),
      provider,
      availableOracles: ["differential-authorization"],
      tokenBudget: 200_000,
    });

    expect(result.added.checks).toEqual(["chk_owner"]);
    expect(result.plan.provenance.compiler.mode).toBe("llm-assisted");
    expect(result.record).toMatchObject({
      provider: "anthropic:claude-opus-5",
      model: "claude-opus-5",
      inputTokens: 2480,
      outputTokens: 512,
      totalTokens: 2992,
      checksProposed: 1,
      checksAccepted: 1,
    });
  });

  it("maps an HTTP 401 from the wire to an actionable error", async () => {
    const stub = await stubApi((_body, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
    });
    const provider = createAnthropicProvider({ apiKey: "sk-ant-bad-key", baseUrl: stub.url, timeoutMs: 5000 });
    await expect(provider.propose(await buildCompilerContext({ plan: plan(), availableOracles: [] })))
      .rejects.toThrow(/rejected the credentials/);
  });

  it("maps a server error to a retry-shortly message", async () => {
    const stub = await stubApi((_body, res) => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "overloaded" } }));
    });
    const provider = createAnthropicProvider({ apiKey: "sk-ant-test-key", baseUrl: stub.url, timeoutMs: 5000, maxRetries: 0 });
    await expect(provider.propose(await buildCompilerContext({ plan: plan(), availableOracles: [] })))
      .rejects.toThrow(/unavailable \(HTTP 503\)/);
  });

  it("retries a 5xx before giving up, so a transient blip does not waste a compilation", async () => {
    let attempts = 0;
    const stub = await stubApi((_body, res) => {
      attempts += 1;
      if (attempts === 1) { res.writeHead(503, { "content-type": "application/json" }); res.end('{"type":"error"}'); return; }
      ok(res, message(proposalText));
    });
    const provider = createAnthropicProvider({ apiKey: "sk-ant-test-key", baseUrl: stub.url, timeoutMs: 5000, maxRetries: 2 });
    const response = await provider.propose(await buildCompilerContext({ plan: plan(), availableOracles: ["differential-authorization"] }));
    expect(attempts).toBeGreaterThan(1);
    expect((response.proposal as { checks: unknown[] }).checks).toHaveLength(1);
  }, 20_000);

  it("fails on prose from the wire rather than scraping checks out of it", async () => {
    const stub = await stubApi((_body, res) => ok(res, message("Here is what I would test: /orders/:id looks risky.")));
    const provider = createAnthropicProvider({ apiKey: "sk-ant-test-key", baseUrl: stub.url });
    await expect(provider.propose(await buildCompilerContext({ plan: plan(), availableOracles: [] })))
      .rejects.toThrow(ProviderError);
  });
});
