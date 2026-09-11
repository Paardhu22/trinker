import { describe, expect, it } from "vitest";
import { BindingResolutionError, buildRequest, maskSecrets, redactHeaders, resolveBinding } from "../src/index.js";
import { ROUTE_GET, ROUTE_POST, makePlan, makeRuntime } from "./fixtures.js";

const plan = makePlan();
const runtime = makeRuntime({ values: { tenantId: "acme", pageSize: 25, beta: true, apiToken: "super-secret-token" } });
const template = (overrides: Record<string, unknown> = {}) =>
  ({ routeId: ROUTE_GET, pathBindings: {}, queryBindings: {}, headerBindings: {}, ...overrides }) as never;

describe("resolveBinding", () => {
  it("resolves a literal", () => {
    expect(resolveBinding(plan, runtime, { literal: "abc" })).toEqual({ value: "abc", sensitive: false });
    expect(resolveBinding(plan, runtime, { literal: 7 })).toEqual({ value: "7", sensitive: false });
    expect(resolveBinding(plan, runtime, { literal: true })).toEqual({ value: "true", sensitive: false });
  });

  it("resolves a fixture field and does not mark it sensitive", () => {
    expect(resolveBinding(plan, runtime, { fixtureRef: "fixture_order", field: "id" })).toEqual({ value: "42", sensitive: false });
  });

  it("resolves a runtimeRef and marks it sensitive (regression: this used to throw)", () => {
    expect(resolveBinding(plan, runtime, { runtimeRef: "tenantId" })).toEqual({ value: "acme", sensitive: true });
    expect(resolveBinding(plan, runtime, { runtimeRef: "pageSize" })).toEqual({ value: "25", sensitive: true });
  });

  it("fails loudly and specifically on a missing runtime value", () => {
    expect(() => resolveBinding(plan, runtime, { runtimeRef: "nope" })).toThrow(BindingResolutionError);
    expect(() => resolveBinding(plan, runtime, { runtimeRef: "nope" })).toThrow(/"nope" is not defined.*runtime\.json/s);
  });

  it("fails loudly on a missing fixture, a missing fixture bag, and a non-primitive field", () => {
    expect(() => resolveBinding(plan, runtime, { fixtureRef: "fixture_ghost", field: "id" })).toThrow(/no fixture "fixture_ghost"/);
    const empty = makeRuntime({ fixtures: {} });
    expect(() => resolveBinding(plan, empty, { fixtureRef: "fixture_order", field: "id" })).toThrow(/"order" is not defined/);
    const nested = makeRuntime({ fixtures: { order: { id: { deep: true } } } });
    expect(() => resolveBinding(plan, nested, { fixtureRef: "fixture_order", field: "id" })).toThrow(/must resolve to a string, number, or boolean/);
  });
});

describe("buildRequest", () => {
  it("substitutes path, query, and header bindings", () => {
    const built = buildRequest({
      plan, runtime, identityId: "identity_owner",
      template: template({
        pathBindings: { id: { fixtureRef: "fixture_order", field: "id" } },
        queryBindings: { tenant: { runtimeRef: "tenantId" }, limit: { literal: 10 } },
        headerBindings: { "x-request-id": { literal: "req-1" } },
      }),
    });
    expect(built.method).toBe("GET");
    expect(built.url).toBe("http://localhost:3000/orders/42?tenant=acme&limit=10");
    expect(built.headers).toMatchObject({ authorization: "Bearer owner-token", "x-request-id": "req-1" });
  });

  it("url-encodes a path binding rather than letting it alter the path", () => {
    const evil = makeRuntime({ fixtures: { order: { id: "../admin" } } });
    const built = buildRequest({ plan, runtime: evil, template: template({ pathBindings: { id: { fixtureRef: "fixture_order", field: "id" } } }) });
    expect(built.url).toBe("http://localhost:3000/orders/..%2Fadmin");
  });

  it("resolves bindings nested inside a request body", () => {
    const built = buildRequest({
      plan, runtime,
      template: template({ routeId: ROUTE_POST, body: { tenant: { runtimeRef: "tenantId" }, items: [{ id: { fixtureRef: "fixture_order", field: "id" } }], keep: "literal-string" } }),
    });
    expect(built.body).toEqual({ tenant: "acme", items: [{ id: "42" }], keep: "literal-string" });
  });

  it("omits credentials entirely for an unauthenticated request", () => {
    const built = buildRequest({ plan, runtime, template: template() });
    expect(built.headers).toEqual({});
  });

  it("collects credential and runtimeRef values as secrets, but not fixture data", () => {
    const built = buildRequest({
      plan, runtime, identityId: "identity_owner",
      template: template({ pathBindings: { id: { fixtureRef: "fixture_order", field: "id" } }, queryBindings: { token: { runtimeRef: "apiToken" } } }),
    });
    expect(built.sensitiveValues).toContain("super-secret-token");
    expect(built.sensitiveValues).toContain("Bearer owner-token");
    expect(built.sensitiveValues).not.toContain("42");
  });

  it("reports an unknown route, identity, or target clearly", () => {
    expect(() => buildRequest({ plan, runtime, template: template({ routeId: "route_ghost" }) })).toThrow(/no route "route_ghost"/);
    expect(() => buildRequest({ plan, runtime, identityId: "identity_ghost", template: template() })).toThrow(/no identity "identity_ghost"/);
    const noTarget = makeRuntime({ targets: { other: { url: "http://localhost:3000", allowHosts: [] } } });
    expect(() => buildRequest({ plan, runtime: noTarget, template: template() })).toThrow(/no target named "local"/);
  });
});

describe("evidence redaction", () => {
  it("redacts credential-bearing headers by name", () => {
    expect(redactHeaders({ authorization: "Bearer x", cookie: "a=b", "x-api-key": "k", accept: "json" }))
      .toEqual({ authorization: "[REDACTED]", cookie: "[REDACTED]", "x-api-key": "[REDACTED]", accept: "json" });
  });

  it("masks a known secret that appears in a non-credential header", () => {
    expect(redactHeaders({ "x-trace": "tenant=super-secret-token" }, ["super-secret-token"]))
      .toEqual({ "x-trace": "tenant=[REDACTED]" });
  });

  it("masks secrets in a URL", () => {
    expect(maskSecrets("http://h/x?token=super-secret-token", ["super-secret-token"]))
      .toBe("http://h/x?token=[REDACTED]");
  });

  it("masks a secret that the URL builder percent-encoded", () => {
    // A runtimeRef value carrying a slash survives into the URL encoded; masking must still catch it.
    const built = buildRequest({ plan, runtime: makeRuntime({ values: { path: "tok/en" } }), template: template({ queryBindings: { p: { runtimeRef: "path" } } }) });
    expect(built.url).toContain("tok%2Fen");
    expect(maskSecrets(built.url, built.sensitiveValues)).toBe("http://localhost:3000/orders/:id?p=[REDACTED]");
  });

  it("masks the longest secret first so overlapping values are fully removed", () => {
    expect(maskSecrets("value=abcdef", ["abc", "abcdef"])).toBe("value=[REDACTED]");
  });

  it("leaves text untouched when there are no secrets", () => {
    expect(maskSecrets("nothing to hide", [])).toBe("nothing to hide");
  });
});
