import { describe, expect, it } from "vitest";
import { PlanSchema, RuntimeConfigSchema } from "../src/index.js";
import { makePlan } from "./fixtures.js";

describe("plan schema", () => {
  it("rejects unknown keys anywhere, so a typo cannot silently disable a check", () => {
    const plan = { ...JSON.parse(JSON.stringify(makePlan())), unexpected: true };
    expect(PlanSchema.safeParse(plan).success).toBe(false);
  });

  it("requires a reason for every coverage exclusion", () => {
    expect(() => makePlan({ coverage: { inScopeRouteIds: [], exclusions: [{ routeId: "route_x", reason: "" }] } })).toThrow();
  });

  it("accepts every declared oracle variant, including ones with no implementation yet", () => {
    for (const oracle of ["state-mutation", "metamorphic-response", "browser-execution", "out-of-band"]) {
      const base = { id: `chk_${oracle.replace(/-/g, "_")}`, invariantId: "inv_owner_only", enabled: true, oracle, request: { routeId: "route_get_orders_11111111", pathBindings: {}, queryBindings: {}, headerBindings: {} } };
      const extra = oracle === "state-mutation"
        ? { readRequest: { routeId: "route_get_orders_11111111", pathBindings: {}, queryBindings: {}, headerBindings: {} }, protectedPaths: ["ownerId"], readIdentityId: "identity_owner", unauthorizedIdentityIds: ["identity_peer"] }
        : oracle === "metamorphic-response"
          ? { variants: [{ name: "a", queryBindings: {} }, { name: "b", queryBindings: {} }] }
          : {};
      expect(() => makePlan({ checks: [{ ...base, ...extra }] })).not.toThrow();
    }
  });
});

describe("runtime config schema", () => {
  it("defaults to refusing mutation and to empty credential maps", () => {
    const runtime = RuntimeConfigSchema.parse({ targets: { local: { url: "http://localhost:3000" } } });
    expect(runtime).toMatchObject({ mutationAuthorized: false, identities: {}, fixtures: {}, values: {} });
  });

  it("requires a valid absolute target URL", () => {
    expect(RuntimeConfigSchema.safeParse({ targets: { local: { url: "not-a-url" } } }).success).toBe(false);
  });

  it("accepts scalar runtime values and rejects structured ones", () => {
    expect(RuntimeConfigSchema.safeParse({ targets: { local: { url: "http://localhost:3000" } }, values: { a: "x", b: 1, c: true } }).success).toBe(true);
    expect(RuntimeConfigSchema.safeParse({ targets: { local: { url: "http://localhost:3000" } }, values: { a: { nested: true } } }).success).toBe(false);
  });
});
