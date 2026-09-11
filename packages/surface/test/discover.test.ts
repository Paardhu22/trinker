import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverSurface } from "../src/index.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "trinker-surface-"));
  dirs.push(root);
  for (const [name, content] of Object.entries(files)) {
    const file = join(root, name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return root;
}

const summary = (routes: { method: string; pathTemplate: string }[]) => routes.map((route) => `${route.method} ${route.pathTemplate}`);

describe("cross-file router mounting", () => {
  it("applies a prefix declared in the file that imports the router", async () => {
    const root = await project({
      "routes/orders.ts": `import express from "express";\nexport const ordersRouter = express.Router();\nordersRouter.get('/:id', h);\nordersRouter.post('/', h);\n`,
      "app.ts": `import express from "express";\nimport { ordersRouter } from "./routes/orders";\nconst app = express();\napp.use('/api/orders', ordersRouter);\n`,
    });
    const surface = await discoverSurface({ rootDir: root });
    expect(summary(surface.routes).sort()).toEqual(["GET /api/orders/:id", "POST /api/orders"]);
  });

  it("resolves a default-imported router and an index module", async () => {
    const root = await project({
      "routes/users/index.ts": `import express from "express";\nconst router = express.Router();\nrouter.get('/:userId', h);\nexport default router;\n`,
      "app.ts": `import express from "express";\nimport users from "./routes/users";\nconst app = express();\napp.use('/api/users', users);\n`,
    });
    const surface = await discoverSurface({ rootDir: root });
    expect(summary(surface.routes)).toEqual(["GET /api/users/:userId"]);
  });

  it("marks a cross-file resolved route medium rather than high confidence", async () => {
    const root = await project({
      "routes/orders.ts": `import express from "express";\nexport const ordersRouter = express.Router();\nordersRouter.get('/:id', h);\n`,
      "app.ts": `import express from "express";\nimport { ordersRouter } from "./routes/orders";\nconst app = express();\napp.use('/api/orders', ordersRouter);\n`,
    });
    const surface = await discoverSurface({ rootDir: root });
    expect(surface.routes[0]).toMatchObject({ pathTemplate: "/api/orders/:id", confidence: "medium" });
  });

  it("leaves a router low confidence when nothing mounts it", async () => {
    const root = await project({
      "routes/orders.ts": `import express from "express";\nexport const ordersRouter = express.Router();\nordersRouter.get('/:id', h);\n`,
    });
    const surface = await discoverSurface({ rootDir: root });
    expect(surface.routes[0]).toMatchObject({ pathTemplate: "/:id", confidence: "low" });
  });
});

describe("discovery hygiene", () => {
  it("skips node_modules, dist, and test files", async () => {
    const root = await project({
      "app.ts": `import express from "express";\nconst app = express();\napp.get('/real', h);\n`,
      "node_modules/pkg/index.js": `const express = require("express");\nconst app = express();\napp.get('/from-node-modules', h);\n`,
      "dist/bundle.js": `const express = require("express");\nconst app = express();\napp.get('/from-dist', h);\n`,
      "app.test.ts": `import express from "express";\nconst app = express();\napp.get('/from-test', h);\n`,
    });
    const surface = await discoverSurface({ rootDir: root });
    expect(summary(surface.routes)).toEqual(["GET /real"]);
  });

  it("is deterministic across runs and records a stable digest", async () => {
    const files = { "app.ts": `import express from "express";\nconst app = express();\napp.get('/b', h);\napp.get('/a', h);\n` };
    const first = await discoverSurface({ rootDir: await project(files) });
    const second = await discoverSurface({ rootDir: await project(files) });
    expect(first.digest).toBe(second.digest);
    expect(first.routes.map((route) => route.id)).toEqual(second.routes.map((route) => route.id));
  });

  it("infers resources from shared path parameters", async () => {
    const root = await project({
      "app.ts": `import express from "express";\nconst app = express();\napp.get('/orders/:orderId', h);\napp.delete('/orders/:orderId', h);\n`,
    });
    const surface = await discoverSurface({ rootDir: root });
    expect(surface.resources[0]).toMatchObject({ id: "resource_order", name: "order", routeParameter: "orderId" });
    expect(surface.resources[0]?.routeIds).toHaveLength(2);
  });

  it("reports unknown frameworks rather than guessing", async () => {
    const root = await project({ "app.ts": `const app = {};\napp.get('/health', h);\n` });
    expect((await discoverSurface({ rootDir: root })).frameworks).toEqual(["unknown"]);
  });
});
