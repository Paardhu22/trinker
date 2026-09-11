import { describe, expect, it } from "vitest";
import { assertSafePlan, assertSafeTarget, PlanSchema } from "../src/index.js";
import { ROUTE_GET, ROUTE_POST, authCheck, makePlan, makeRuntime } from "./fixtures.js";

/**
 * These are security invariants, not coverage. Every case here corresponds to a way Trinker could
 * otherwise touch a host it was not authorized to touch, or mutate state it was not authorized to
 * mutate. Treat a failure as a release blocker.
 */
describe("safety: target allowlisting", () => {
  it.each([
    ["localhost", "http://localhost:3000"],
    ["127.0.0.1", "http://127.0.0.1:3000"],
    ["IPv6 loopback", "http://[::1]:3000"],
  ])("allows %s implicitly", (_label, url) => {
    const runtime = makeRuntime({ targets: { local: { url, allowHosts: [] } } });
    expect(() => assertSafeTarget(makePlan(), runtime)).not.toThrow();
  });

  it("rejects an external host that is not allowlisted", () => {
    const runtime = makeRuntime({ targets: { local: { url: "https://example.com", allowHosts: [] } } });
    expect(() => assertSafeTarget(makePlan(), runtime)).toThrow(/example\.com is blocked/);
  });

  it("accepts an external host only when it is explicitly allowlisted", () => {
    const runtime = makeRuntime({ targets: { local: { url: "https://staging.example.com", allowHosts: ["staging.example.com"] } } });
    expect(() => assertSafeTarget(makePlan(), runtime)).not.toThrow();
  });

  it("does not let an allowlist entry for one host authorize another", () => {
    const runtime = makeRuntime({ targets: { local: { url: "https://evil.example.com", allowHosts: ["staging.example.com"] } } });
    expect(() => assertSafeTarget(makePlan(), runtime)).toThrow(/blocked/);
  });

  it("rejects a target the runtime configuration does not define", () => {
    const runtime = makeRuntime({ targets: { other: { url: "http://localhost:3000", allowHosts: [] } } });
    expect(() => assertSafeTarget(makePlan(), runtime)).toThrow(/no target named local/);
  });
});

describe("safety: mutation gating", () => {
  const writePlan = (planOverrides: Record<string, unknown> = {}) => makePlan({
    checks: [authCheck({ id: "chk_write", request: { routeId: ROUTE_POST, pathBindings: {}, queryBindings: {}, headerBindings: {} } })],
    safety: { mutationPolicy: "explicit-authorization-required", allowedMethods: ["GET", "POST"] },
    invariants: [{ id: "inv_owner_only", kind: "authorization", statement: "Only an owner may write.", routeIds: [ROUTE_POST], provenance: "manual" }],
    ...planOverrides,
  });

  it("forbids a write check when the plan policy is forbid", () => {
    const plan = writePlan({ safety: { mutationPolicy: "forbid", allowedMethods: ["GET", "POST"] } });
    expect(() => assertSafePlan(plan, makeRuntime({ mutationAuthorized: true }))).toThrow(/mutationPolicy is forbid/);
  });

  it("forbids a write check when runtime authorization is absent, even if the plan permits it", () => {
    expect(() => assertSafePlan(writePlan(), makeRuntime({ mutationAuthorized: false }))).toThrow(/mutationAuthorized/);
  });

  it("requires BOTH plan permission and runtime authorization", () => {
    expect(() => assertSafePlan(writePlan(), makeRuntime({ mutationAuthorized: true }))).not.toThrow();
  });

  it("defaults to refusing mutation when runtime config omits the flag", () => {
    const runtime = makeRuntime();
    expect(runtime.mutationAuthorized).toBe(false);
    expect(() => assertSafePlan(writePlan(), runtime)).toThrow(/mutationAuthorized/);
  });

  it("allows read-only checks without any mutation authorization", () => {
    expect(() => assertSafePlan(makePlan({ checks: [authCheck()] }), makeRuntime())).not.toThrow();
  });
});

describe("safety: plan integrity", () => {
  it("rejects a check whose method is not in the plan's allowedMethods", () => {
    const plan = makePlan({
      checks: [authCheck({ id: "chk_write", request: { routeId: ROUTE_POST, pathBindings: {}, queryBindings: {}, headerBindings: {} } })],
      safety: { mutationPolicy: "explicit-authorization-required", allowedMethods: ["GET"] },
      invariants: [{ id: "inv_owner_only", kind: "authorization", statement: "x", routeIds: [ROUTE_POST], provenance: "manual" }],
    });
    expect(() => assertSafePlan(plan, makeRuntime({ mutationAuthorized: true }))).toThrow(/Method POST is not allowed/);
  });

  it("rejects a check referencing an unknown route at parse time", () => {
    expect(() => makePlan({ checks: [authCheck({ request: { routeId: "route_ghost", pathBindings: {}, queryBindings: {}, headerBindings: {} } })] }))
      .toThrow(/Unknown route/);
  });

  it("rejects a check referencing an unknown identity at parse time", () => {
    expect(() => makePlan({ checks: [authCheck({ deniedIdentityIds: ["identity_ghost"] })] })).toThrow(/Unknown identity/);
  });

  it("rejects a check referencing an unknown invariant at parse time", () => {
    expect(() => makePlan({ checks: [authCheck({ invariantId: "inv_ghost" })] })).toThrow(/Unknown invariant/);
  });
});

describe("safety: credentials never enter the plan", () => {
  it.each([
    ["a literal bearer token in a header binding", { checks: [authCheck({ request: { routeId: ROUTE_GET, pathBindings: {}, queryBindings: {}, headerBindings: { authorization: { literal: "Bearer leaked" } } } })] }],
    ["a cookie literal", { checks: [authCheck({ request: { routeId: ROUTE_GET, pathBindings: {}, queryBindings: {}, headerBindings: { cookie: { literal: "session=abc" } } } })] }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => makePlan(overrides)).toThrow(/inline credential-like values/);
  });

  it("rejects an arbitrary credential-shaped field anywhere in the plan", () => {
    const plan = { ...JSON.parse(JSON.stringify(makePlan())), provenance: { sources: [], compiler: { mode: "manual", compilerVersion: "0.1.0" }, apiKey: "do-not-commit" } };
    expect(PlanSchema.safeParse(plan).success).toBe(false);
  });

  it("permits the same header when bound by reference instead of by value", () => {
    expect(() => makePlan({ checks: [authCheck({ request: { routeId: ROUTE_GET, pathBindings: {}, queryBindings: {}, headerBindings: { authorization: { runtimeRef: "ownerToken" } } } })] })).not.toThrow();
  });
});
