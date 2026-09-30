import { describe, expect, it } from "vitest";
import { ingestHar } from "../src/index.js";

const har = (...requests: Array<[string, string]>) => ({ log: { entries: requests.map(([method, url]) => ({ request: { method, url } })) } });

describe("ingestHar", () => {
  it("templates value segments and merges repeated observations", () => {
    const surface = ingestHar(har(
      ["GET", "http://localhost:3000/rest/basket/1"],
      ["GET", "http://localhost:3000/rest/basket/6"],
      ["PUT", "http://localhost:3000/api/BasketItems/42?x=1"],
      ["GET", "http://localhost:3000/api/Users/3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b/orders/7"],
    ), "http://localhost:3000", "traffic.har");
    expect(surface.routes.map((route) => `${route.method} ${route.pathTemplate}`).sort()).toEqual([
      "GET /api/Users/:id/orders/:id2",
      "GET /rest/basket/:id",
      "PUT /api/BasketItems/:id",
    ]);
    const basket = surface.routes.find((route) => route.pathTemplate === "/rest/basket/:id")!;
    expect(basket.confidence).toBe("medium");
    expect(basket.sourceRefs).toEqual([{ kind: "crawler", path: "traffic.har", note: "observed 2 time(s) in recorded traffic" }]);
    const items = surface.routes.find((route) => route.method === "PUT")!;
    expect(items.parameters).toContainEqual({ name: "x", location: "query", required: false });
  });

  it("keeps only the target origin and drops assets and preflights", () => {
    const surface = ingestHar(har(
      ["GET", "https://cdn.example.com/api/tracking/1"],
      ["GET", "http://localhost:3000/main.js"],
      ["GET", "http://localhost:3000/assets/logo.png"],
      ["OPTIONS", "http://localhost:3000/api/orders"],
      ["GET", "http://localhost:3000/api/orders"],
    ), "http://localhost:3000");
    expect(surface.routes.map((route) => `${route.method} ${route.pathTemplate}`)).toEqual(["GET /api/orders"]);
  });

  it("is deterministic regardless of entry order", () => {
    const a = ingestHar(har(["GET", "http://localhost:3000/a/1"], ["POST", "http://localhost:3000/b"]), "http://localhost:3000");
    const b = ingestHar(har(["POST", "http://localhost:3000/b"], ["GET", "http://localhost:3000/a/9"]), "http://localhost:3000");
    expect(a.digest).toBe(b.digest);
  });

  it("refuses something that is not a HAR", () => {
    expect(() => ingestHar({ openapi: "3.0.0" }, "http://localhost:3000", "x.json")).toThrow(/not a HAR document/);
  });
});
