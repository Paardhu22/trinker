import { describe, expect, it } from "vitest";
import { detectFrameworksFromSource, extractRoutesFromSource, ingestOpenApi, joinPath } from "../src/index.js";

const paths = (source: string) => extractRoutesFromSource(source).map((route) => `${route.method} ${route.pathTemplate}`);
const only = (source: string) => extractRoutesFromSource(source)[0];

describe("route declaration shapes", () => {
  it("extracts Express app and router declarations", () => {
    const source = `import express from "express";
      const app = express();
      app.get('/health', h);
      app.post('/orders/:orderId', h);`;
    expect(paths(source)).toEqual(["GET /health", "POST /orders/:orderId"]);
  });

  it("extracts Fastify shorthand and route objects", () => {
    const source = `import Fastify from "fastify";
      const app = Fastify();
      app.get('/ping', h);
      app.route({ method: 'DELETE', url: '/orders/:id' });`;
    expect(paths(source)).toEqual(["GET /ping", "DELETE /orders/:id"]);
  });

  it("expands a Fastify route object declaring several methods", () => {
    expect(paths(`import Fastify from "fastify"; const app = Fastify(); app.route({ method: ['GET','HEAD'], url: '/x' });`))
      .toEqual(["GET /x", "HEAD /x"]);
  });

  it("derives path parameters", () => {
    expect(only(`import express from "express"; const app = express(); app.post('/orders/:orderId', h);`)?.parameters)
      .toEqual([{ name: "orderId", location: "path", required: true }]);
  });

  it("accepts a backtick path with no substitutions", () => {
    expect(paths("import express from 'express'; const app = express(); app.get(`/health`, h);")).toEqual(["GET /health"]);
  });
});

describe("regression: chained .route() links were dropped after the first", () => {
  it("captures every method in an Express route chain", () => {
    expect(paths(`import express from "express"; const app = express(); app.route('/books').get(h).post(h).put(h);`))
      .toEqual(["GET /books", "POST /books", "PUT /books"]);
  });

  it("captures a chain declared on a mounted router", () => {
    expect(paths(`import express from "express"; const app = express(); const router = express.Router(); router.route('/:id').get(h).delete(h); app.use('/api/books', router);`))
      .toEqual(["DELETE /api/books/:id", "GET /api/books/:id"]);
  });
});

describe("regression: any .get('/path') call was treated as a route", () => {
  it("does not invent a route from an unrelated receiver", () => {
    expect(paths(`const cache = new Map(); cache.get('/api/secret');`)).toEqual([]);
    expect(paths(`import express from "express"; const app = express(); const store = makeStore(); store.get('/api/secret'); app.get('/real', h);`))
      .toEqual(["GET /real"]);
  });

  it("does not treat a non-path string as a route", () => {
    expect(paths(`import express from "express"; const app = express(); app.get('etag', h);`)).toEqual([]);
  });

  it("still reports a conventionally named receiver, but never as high confidence", () => {
    const route = only(`app.get('/health', h);`);
    expect(route?.pathTemplate).toBe("/health");
    expect(route?.confidence).toBe("medium");
    expect(route?.sourceRefs[0]?.note).toMatch(/naming convention/);
  });
});

describe("regression: Express router mount prefixes were ignored", () => {
  it("applies a mount prefix declared in the same file", () => {
    expect(paths(`import express from "express"; const app = express(); const router = express.Router(); router.get('/:id', h); app.use('/api/orders', router);`))
      .toEqual(["GET /api/orders/:id"]);
  });

  it("handles a router route at the mount root without doubling the slash", () => {
    expect(paths(`import express from "express"; const app = express(); const router = express.Router(); router.get('/', h); app.use('/api/orders', router);`))
      .toEqual(["GET /api/orders"]);
  });

  it("emits one route per prefix when a router is mounted more than once", () => {
    expect(paths(`import express from "express"; const app = express(); const router = express.Router(); router.get('/:id', h); app.use('/api/orders', router); app.use('/api/v2/orders', router);`))
      .toEqual(["GET /api/orders/:id", "GET /api/v2/orders/:id"]);
  });

  it("applies a Fastify register prefix", () => {
    const source = `import Fastify from "fastify";
      const app = Fastify();
      async function orderRoutes(instance) { instance.get('/:id', h); }
      app.register(orderRoutes, { prefix: '/api/orders' });`;
    expect(paths(source)).toEqual(["GET /api/orders/:id"]);
  });

  it("marks an unmounted router low confidence instead of implying a complete path", () => {
    const route = only(`import express from "express"; const router = express.Router(); router.get('/:id', h);`);
    expect(route?.pathTemplate).toBe("/:id");
    expect(route?.confidence).toBe("low");
    expect(route?.sourceRefs[0]?.note).toMatch(/never mounted/);
  });
});

describe("confidence reflects real extraction certainty", () => {
  it("is high only for a proven receiver on a fully resolved path", () => {
    expect(only(`import express from "express"; const app = express(); app.get('/health', h);`)?.confidence).toBe("high");
    expect(only(`import express from "express"; const app = express(); const r = express.Router(); r.get('/x', h); app.use('/api', r);`)?.confidence).toBe("high");
  });

  it("drops to medium when a router is mounted at several prefixes", () => {
    const routes = extractRoutesFromSource(`import express from "express"; const app = express(); const r = express.Router(); r.get('/x', h); app.use('/a', r); app.use('/b', r);`);
    expect(routes.every((route) => route.confidence === "medium")).toBe(true);
  });
});

describe("known limitation: template literals with substitutions", () => {
  it("skips a dynamic path rather than inventing one", () => {
    expect(paths("import express from 'express'; const app = express(); app.get(`/api/${version}/x`, h);")).toEqual([]);
  });
});

describe("joinPath", () => {
  it.each([
    ["/api", "/x", "/api/x"],
    ["/api/", "/x", "/api/x"],
    ["/api", "/", "/api"],
    ["", "/x", "/x"],
    ["/api", "/:id", "/api/:id"],
  ])("joins %s + %s => %s", (prefix, path, expected) => expect(joinPath(prefix, path)).toBe(expected));
});

describe("OpenAPI ingestion", () => {
  it("normalises path parameters and keeps the operation id", () => {
    const surface = ingestOpenApi({ paths: { "/api/users/{id}": { get: { operationId: "getUser" } } } });
    expect(surface.routes[0]).toMatchObject({ method: "GET", pathTemplate: "/api/users/:id", operationId: "getUser", confidence: "high" });
    expect(surface.routes[0]?.parameters).toEqual([{ name: "id", location: "path", required: true }]);
  });

  it("produces a stable digest", () => {
    const document = { paths: { "/a": { get: {} } } };
    expect(ingestOpenApi(document).digest).toBe(ingestOpenApi(document).digest);
  });
});

describe("framework detection", () => {
  it("uses imports rather than route-call shapes", () => {
    expect(detectFrameworksFromSource(`import Fastify from "fastify"; const app = Fastify();`)).toEqual(["fastify"]);
    expect(detectFrameworksFromSource(`const app = {}; app.get("/health", h);`)).toEqual(["unknown"]);
    expect(detectFrameworksFromSource(`const express = require("express"); const app = express();`)).toEqual(["express"]);
  });
});
