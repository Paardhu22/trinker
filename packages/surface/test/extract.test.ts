import { describe, expect, it } from "vitest";
import { detectFrameworksFromSource, extractRoutesFromSource, ingestOpenApi } from "../src/index.js";

describe("surface extraction", () => {
  it("extracts common Express and Fastify route declarations", () => {
    const surface = extractRoutesFromSource(`app.get('/health', h); router.post('/orders/:orderId', h); fastify.route({ method: 'DELETE', url: '/orders/:orderId' });`, "src/app.ts");
    expect(surface.map((route) => [route.method, route.pathTemplate])).toEqual([["GET", "/health"], ["POST", "/orders/:orderId"], ["DELETE", "/orders/:orderId"]]);
    expect(surface[1]?.parameters).toEqual([{ name: "orderId", location: "path", required: true }]);
  });

  it("normalises OpenAPI path parameters", () => {
    const surface = ingestOpenApi({ paths: { "/api/users/{id}": { get: { operationId: "getUser" } } } });
    expect(surface.routes[0]).toMatchObject({ method: "GET", pathTemplate: "/api/users/:id", operationId: "getUser" });
  });
  it("uses source imports rather than route guesses for framework metadata", () => {
    expect(detectFrameworksFromSource(`import Fastify from "fastify"; const app = Fastify();`)).toEqual(["fastify"]);
    expect(detectFrameworksFromSource(`const app = {}; app.get("/health", h);`)).toEqual(["unknown"]);
  });
});
