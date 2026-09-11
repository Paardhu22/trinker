import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { PlanSchema, type Plan } from "@trinker/core";
import { buildCompilerContext, compileWithProvider, createOpenAiProvider, ProviderError } from "../src/index.js";

/**
 * Exercises the real `openai` SDK against a local stub of the Responses API.
 *
 * The unit tests inject a fake client, which proves our logic but not that the request survives the
 * SDK. These do: real serialisation, transport, retry, and error mapping. What stays unverified
 * without credentials is only OpenAI's own acceptance of the request — in particular whether the
 * strict Structured Outputs schema is accepted as written.
 */

const ROUTE = "route_get_orders_11111111";
const ORACLES = ["differential-authorization"];

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

const wireProposal = JSON.stringify({
  identities: [
    { id: "identity_owner", credentialRef: "owner", roles: ["user"], capabilities: [] },
    { id: "identity_peer", credentialRef: "peer", roles: ["user"], capabilities: [] },
  ],
  fixtures: [{ id: "fixture_order", runtimeRef: "order", resourceId: null, ownerIdentityId: "identity_owner" }],
  invariants: [{ id: "inv_owner", kind: "authorization", statement: "Only the owner may read an order.", routeIds: [ROUTE], resourceId: null }],
  checks: [{
    id: "chk_owner", invariantId: "inv_owner", oracle: "differential-authorization",
    request: {
      routeId: ROUTE,
      pathBindings: [{ name: "id", literal: null, fixtureRef: "fixture_order", field: "id", runtimeRef: null }],
      queryBindings: [], headerBindings: [], bodyJson: null,
    },
    allowedIdentityIds: ["identity_owner"], deniedIdentityIds: ["identity_peer"], calibrationTrials: 3,
    readRequest: null, readIdentityId: null, unauthorizedIdentityIds: null, protectedPaths: null, stabilityReads: null,
    identityId: null, relation: null, variants: null,
  }],
  rationales: [{ checkId: "chk_owner", rationale: "Route takes an :id path parameter." }],
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
  return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`, requests };
}

const ok = (res: ServerResponse, payload: unknown): void => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
};

const response = (text: string) => ({
  id: "resp_1", object: "response", status: "completed", model: "gpt-5.6-terra",
  output: [{ id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
  usage: { input_tokens: 5120, output_tokens: 1180, total_tokens: 6300 },
});

const context = async () => buildCompilerContext({ plan: plan(), availableOracles: ORACLES });

describe("the real OpenAI SDK", () => {
  it("sends a Responses request the SDK accepts, and parses the reply", async () => {
    const stub = await stubApi((_body, res) => ok(res, response(wireProposal)));
    const provider = createOpenAiProvider({ apiKey: "sk-proj-test-key", baseUrl: stub.url });

    const result = await provider.propose(await context());

    expect(result.usage).toEqual({ input: 5120, output: 1180, calls: 1 });
    const sent = stub.requests[0]!;
    expect(sent.headers["authorization"]).toBe("Bearer sk-proj-test-key");
    expect(sent.body["model"]).toBe("gpt-5.6-terra");
    expect((sent.body["text"] as { format: { type: string; strict: boolean } }).format).toMatchObject({ type: "json_schema", strict: true });
  });

  it("carries the application surface but no credentials in the request body", async () => {
    const stub = await stubApi((_body, res) => ok(res, response(wireProposal)));
    const provider = createOpenAiProvider({ apiKey: "sk-proj-test-key", baseUrl: stub.url });
    await provider.propose(await context());

    const body = JSON.stringify(stub.requests[0]!.body);
    expect(body).toContain(ROUTE);
    expect(body).not.toContain("sk-proj-test-key");
  });

  it("completes the whole pipeline: request -> wire proposal -> validation -> merged plan", async () => {
    const stub = await stubApi((_body, res) => ok(res, response(wireProposal)));
    const provider = createOpenAiProvider({ apiKey: "sk-proj-test-key", baseUrl: stub.url });

    const result = await compileWithProvider({ plan: plan(), provider, availableOracles: ORACLES, tokenBudget: 200_000 });

    expect(result.added.checks).toEqual(["chk_owner"]);
    expect(result.plan.provenance.compiler.mode).toBe("llm-assisted");
    expect(result.record).toMatchObject({
      provider: "openai:gpt-5.6-terra", model: "gpt-5.6-terra",
      inputTokens: 5120, outputTokens: 1180, totalTokens: 6300,
      checksProposed: 1, checksAccepted: 1, checksRejected: 0,
    });
  });

  it("maps a 401 from the wire to an actionable error", async () => {
    const stub = await stubApi((_body, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Incorrect API key provided", type: "invalid_request_error" } }));
    });
    const provider = createOpenAiProvider({ apiKey: "sk-proj-bad-key", baseUrl: stub.url, maxRetries: 0 });
    await expect(provider.propose(await context())).rejects.toThrow(/rejected the credentials/);
  });

  it("maps a 400 schema rejection to a message naming the request", async () => {
    // The most likely real-world failure: strict Structured Outputs refusing the schema.
    const stub = await stubApi((_body, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid schema for response_format", type: "invalid_request_error" } }));
    });
    const provider = createOpenAiProvider({ apiKey: "sk-proj-test-key", baseUrl: stub.url, maxRetries: 0 });
    await expect(provider.propose(await context())).rejects.toThrow(/rejected the request \(HTTP 400\).*Invalid schema/s);
  });

  it("retries a 5xx before giving up", async () => {
    let attempts = 0;
    const stub = await stubApi((_body, res) => {
      attempts += 1;
      if (attempts === 1) { res.writeHead(503, { "content-type": "application/json" }); res.end('{"error":{"message":"overloaded"}}'); return; }
      ok(res, response(wireProposal));
    });
    const provider = createOpenAiProvider({ apiKey: "sk-proj-test-key", baseUrl: stub.url, maxRetries: 2 });
    await provider.propose(await context());
    expect(attempts).toBeGreaterThan(1);
  }, 20_000);

  it("fails on prose from the wire rather than scraping checks out of it", async () => {
    const stub = await stubApi((_body, res) => ok(res, response("I would test /orders/:id for IDOR.")));
    const provider = createOpenAiProvider({ apiKey: "sk-proj-test-key", baseUrl: stub.url });
    await expect(provider.propose(await context())).rejects.toThrow(ProviderError);
  });
});
