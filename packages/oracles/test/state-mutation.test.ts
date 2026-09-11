import { describe, expect, it } from "vitest";
import { exitCodeForScan, runPlan, type HttpClient, type HttpRequest, type Plan, type RuntimeConfig } from "@trinker/core";
import { readPath, stateMutationOracle } from "../src/index.js";

const READ = "route_get_orders_11111111";
const WRITE = "route_patch_orders_22222222";

const template = (routeId: string, extra: Record<string, unknown> = {}) =>
  ({ routeId, pathBindings: { id: { fixtureRef: "fixture_order", field: "id" } }, queryBindings: {}, headerBindings: {}, ...extra });

const plan = (checkOverrides: Record<string, unknown> = {}): Plan => ({
  schemaVersion: 1, planId: "trkp_demo", surfaceDigest: `sha256:${"a".repeat(64)}`,
  target: { applicationId: "demo", allowedTargetRefs: ["local"] },
  surface: {
    frameworks: ["express"],
    routes: [
      { id: READ, method: "GET", pathTemplate: "/orders/:id", parameters: [{ name: "id", location: "path", required: true }], sourceRefs: [], confidence: "high" },
      { id: WRITE, method: "PATCH", pathTemplate: "/orders/:id", parameters: [{ name: "id", location: "path", required: true }], sourceRefs: [], confidence: "high" },
    ],
    resources: [],
  },
  identities: [
    { id: "identity_owner", credentialRef: "owner", roles: [], capabilities: [] },
    { id: "identity_peer", credentialRef: "peer", roles: [], capabilities: [] },
  ],
  fixtures: [{ id: "fixture_order", runtimeRef: "order", ownerIdentityId: "identity_owner" }],
  invariants: [{ id: "inv_owner_writes", kind: "state-mutation", statement: "Only the owner may change an order.", routeIds: [WRITE], provenance: "manual" }],
  checks: [{
    id: "chk_mutation", invariantId: "inv_owner_writes", enabled: true, oracle: "state-mutation",
    request: template(WRITE, { body: { ownerId: "peer" } }),
    readRequest: template(READ),
    readIdentityId: "identity_owner",
    unauthorizedIdentityIds: ["identity_peer"],
    protectedPaths: ["ownerId"],
    calibration: { stabilityReads: 1 },
    ...checkOverrides,
  } as never],
  coverage: { inScopeRouteIds: [READ, WRITE], exclusions: [] },
  // A write check requires both of these; the runner refuses otherwise.
  safety: { mutationPolicy: "explicit-authorization-required", allowedMethods: ["GET", "PATCH"] },
  provenance: { sources: [], compiler: { mode: "manual", compilerVersion: "0.1.0" } },
});

const runtime: RuntimeConfig = {
  targets: { local: { url: "http://localhost:3000", allowHosts: [] } },
  identities: { owner: { headers: { authorization: "Bearer owner-token" } }, peer: { headers: { authorization: "Bearer peer-token" } } },
  fixtures: { order: { id: "42" } }, values: {}, mutationAuthorized: true,
};

/** A tiny in-memory order server. `enforce` decides whether the PATCH is authorized. */
function server(options: { enforce: boolean; acceptButIgnore?: boolean; drift?: boolean }): { client: HttpClient; seen: HttpRequest[] } {
  const state = { ownerId: "owner", total: 99 };
  let reads = 0;
  const seen: HttpRequest[] = [];
  const client: HttpClient = {
    request: async (request) => {
      seen.push(request);
      const isOwner = request.headers["authorization"] === "Bearer owner-token";
      if (request.method === "GET") {
        reads++;
        const body = options.drift === true ? { ...state, ownerId: `${state.ownerId}-${reads}` } : state;
        return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(body), elapsedMs: 1 };
      }
      if (options.enforce && !isOwner) return { status: 403, headers: {}, body: '{"error":"forbidden"}', elapsedMs: 1 };
      if (options.acceptButIgnore !== true) state.ownerId = "peer";
      return { status: 200, headers: {}, body: '{"ok":true}', elapsedMs: 1 };
    },
  };
  return { client, seen };
}

const scan = (client: HttpClient, checkOverrides: Record<string, unknown> = {}, planOverrides: Partial<Plan> = {}) =>
  runPlan({ plan: { ...plan(checkOverrides), ...planOverrides }, runtime, oracles: [stateMutationOracle], http: client, scanId: "scan_test" }).result;

describe("state mutation: confirmation requires an observed state change", () => {
  it("confirms when an unauthorized identity actually changes protected state", async () => {
    const result = await scan(server({ enforce: false }).client);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ id: "TRK-0001", status: "confirmed", title: "Unauthorized State Mutation", oracle: "State Mutation", routeId: WRITE });
    expect(result.findings[0]?.verdict).toMatch(/identity_peer changed protected state at ownerId/);
    expect(exitCodeForScan(result)).toBe(1);
  });

  it("passes when the server rejects the unauthorized write", async () => {
    const result = await scan(server({ enforce: true }).client);
    expect(result.findings).toHaveLength(0);
    expect(result.checks.passed).toBe(1);
    expect(exitCodeForScan(result)).toBe(0);
  });

  it("does NOT confirm on a 200 alone when the state did not actually change", async () => {
    const result = await scan(server({ enforce: false, acceptButIgnore: true }).client);
    expect(result.findings).toHaveLength(0);
    expect(result.checks.passed).toBe(1);
  });

  it("records the before and after values as evidence", async () => {
    const result = await scan(server({ enforce: false }).client);
    const notes = result.findings[0]!.evidence.notes;
    expect(notes.some((note) => note.includes('ownerId: "owner" -> "peer"'))).toBe(true);
    expect(notes.some((note) => /rests on the observed state change/.test(note))).toBe(true);
    expect(result.findings[0]!.evidence.responses).toHaveLength(3);
    // Writing is inherently destructive; the finding must say so rather than imply a clean replay.
    expect(notes.some((note) => /did not restore it/.test(note))).toBe(true);
  });
});

describe("state mutation: stability calibration prevents false positives", () => {
  it("is inconclusive when protected state drifts on its own", async () => {
    const result = await scan(server({ enforce: false, drift: true }).client);
    expect(result.findings).toHaveLength(0);
    expect(result.checks.inconclusive).toBe(1);
    expect(result.outcomes[0]?.reason).toMatch(/changed between control reads without any mutation/);
  });

  it("performs the configured number of control reads before mutating", async () => {
    const { client, seen } = server({ enforce: true });
    await scan(client, { calibration: { stabilityReads: 3 } });
    const methodsBeforeWrite = seen.slice(0, seen.findIndex((request) => request.method === "PATCH")).map((request) => request.method);
    expect(methodsBeforeWrite).toEqual(["GET", "GET", "GET", "GET"]); // baseline + 3 control reads
  });

  it("reads the state as the nominated read identity, not the unauthorized one", async () => {
    const { client, seen } = server({ enforce: true });
    await scan(client);
    const reads = seen.filter((request) => request.method === "GET");
    expect(reads.every((request) => request.headers["authorization"] === "Bearer owner-token")).toBe(true);
    expect(seen.find((request) => request.method === "PATCH")?.headers["authorization"]).toBe("Bearer peer-token");
  });
});

describe("state mutation: inconclusive rather than wrong", () => {
  it("is inconclusive when the baseline state cannot be read", async () => {
    const client: HttpClient = { request: async () => ({ status: 404, headers: {}, body: "{}", elapsedMs: 1 }) };
    const result = await scan(client);
    expect(result.checks.inconclusive).toBe(1);
    expect(result.outcomes[0]?.reason).toMatch(/could not be read as identity_owner/);
  });

  it("is inconclusive when no protected path exists in the response", async () => {
    const client: HttpClient = { request: async () => ({ status: 200, headers: {}, body: '{"unrelated":1}', elapsedMs: 1 }) };
    const result = await scan(client);
    expect(result.checks.inconclusive).toBe(1);
    expect(result.outcomes[0]?.reason).toMatch(/do not exist|none of the protected paths/i);
  });

  it("is inconclusive when the state cannot be re-read after the mutation", async () => {
    let reads = 0;
    const client: HttpClient = {
      request: async (request) => {
        if (request.method !== "GET") return { status: 200, headers: {}, body: "{}", elapsedMs: 1 };
        reads++;
        return reads <= 2
          ? { status: 200, headers: {}, body: '{"ownerId":"owner"}', elapsedMs: 1 }
          : { status: 500, headers: {}, body: "{}", elapsedMs: 1 };
      },
    };
    const result = await scan(client);
    expect(result.checks.inconclusive).toBe(1);
    expect(result.outcomes[0]?.reason).toMatch(/could not be re-read/);
  });
});

describe("state mutation: safety gating still applies", () => {
  it("refuses to run at all when runtime mutation authorization is absent", async () => {
    const handle = runPlan({ plan: plan(), runtime: { ...runtime, mutationAuthorized: false }, oracles: [stateMutationOracle], http: server({ enforce: false }).client, scanId: "s" });
    await expect(handle.result).rejects.toThrow(/mutationAuthorized/);
  });

  it("refuses to run when the plan forbids mutation", async () => {
    const forbidding = { ...plan(), safety: { mutationPolicy: "forbid" as const, allowedMethods: ["GET" as const, "PATCH" as const] } };
    const handle = runPlan({ plan: forbidding, runtime, oracles: [stateMutationOracle], http: server({ enforce: false }).client, scanId: "s" });
    await expect(handle.result).rejects.toThrow(/mutationPolicy is forbid/);
  });
});

describe("readPath", () => {
  const document = { owner: { id: "u1" }, items: [{ price: 10 }, { price: 20 }], nothing: null };
  it.each([
    ["owner.id", "u1"],
    ["items.0.price", 10],
    ["items.1.price", 20],
    ["nothing", null],
    ["missing", undefined],
    ["owner.missing.deep", undefined],
    ["items.9.price", undefined],
  ])("resolves %s", (path, expected) => expect(readPath(document, path)).toEqual(expected));
});
