import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileProject, loadPlan } from "../src/workflow.js";

const projects: string[] = [];
const newProject = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "trinker-workflow-"));
  projects.push(dir);
  return dir;
};
afterEach(async () => { await Promise.all(projects.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const authorChecks = async (project: string): Promise<string> => {
  const plan = await loadPlan(project);
  const routeId = plan.surface.routes[0]!.id;
  const authored = {
    ...plan,
    identities: [{ id: "identity_owner", credentialRef: "owner", roles: [], capabilities: [] }, { id: "identity_peer", credentialRef: "peer", roles: [], capabilities: [] }],
    fixtures: [{ id: "fixture_order", runtimeRef: "order" }],
    invariants: [{ id: "inv_owner_only", kind: "authorization", statement: "Only the owner may read.", routeIds: [routeId], provenance: "manual" }],
    checks: [{
      id: "chk_auth", invariantId: "inv_owner_only", enabled: true, oracle: "differential-authorization",
      request: { routeId, pathBindings: {}, queryBindings: {}, headerBindings: {} },
      allowedIdentityIds: ["identity_owner"], deniedIdentityIds: ["identity_peer"], calibration: { trials: 3 },
    }],
  };
  await writeFile(join(project, ".trinker", "plan.json"), JSON.stringify(authored, null, 2));
  return routeId;
};

describe("deterministic compilation", () => {
  it("creates a reviewable starter plan without invoking an LLM", async () => {
    const project = await newProject();
    await writeFile(join(project, "app.ts"), "import express from 'express';\nconst app = express();\napp.get('/api/orders/:id', handler);\n");
    const { plan, merged } = await compileProject(project);
    expect(plan.surface.routes).toHaveLength(1);
    expect(plan.checks).toEqual([]);
    expect(merged).toBe(false);
    expect(plan.safety).toMatchObject({ mutationPolicy: "forbid", allowedMethods: ["GET", "HEAD", "OPTIONS"] });
    const persisted = JSON.parse(await readFile(join(project, ".trinker", "plan.json"), "utf8"));
    expect(persisted.planId).toBe(plan.planId);
  });

  it("is deterministic: the same source yields the same plan id", async () => {
    const source = "import express from 'express';\nconst app = express();\napp.get('/api/orders/:id', handler);\n";
    const a = await newProject(); await writeFile(join(a, "app.ts"), source);
    const b = await newProject(); await writeFile(join(b, "app.ts"), source);
    const planA = (await compileProject(a)).plan;
    const planB = (await compileProject(b)).plan;
    expect(planA.surfaceDigest).toBe(planB.surfaceDigest);
  });
});

describe("recompilation preserves authored security knowledge", () => {
  it("keeps hand-authored checks, invariants, identities, and fixtures", async () => {
    const project = await newProject();
    await writeFile(join(project, "app.ts"), "import express from 'express';\nconst app = express();\napp.get('/api/orders/:id', handler);\n");
    await compileProject(project);
    await authorChecks(project);

    const { plan, merged } = await compileProject(project);
    expect(merged).toBe(true);
    expect(plan.checks.map((check) => check.id)).toEqual(["chk_auth"]);
    expect(plan.invariants).toHaveLength(1);
    expect(plan.identities).toHaveLength(2);
    expect(plan.fixtures).toHaveLength(1);
  });

  it("preserves a widened safety policy rather than resetting it", async () => {
    const project = await newProject();
    await writeFile(join(project, "app.ts"), "import express from 'express';\nconst app = express();\napp.get('/api/orders/:id', handler);\n");
    await compileProject(project);
    const plan = await loadPlan(project);
    await writeFile(join(project, ".trinker", "plan.json"), JSON.stringify({ ...plan, safety: { mutationPolicy: "explicit-authorization-required", allowedMethods: ["GET", "POST"] } }, null, 2));
    expect((await compileProject(project)).plan.safety).toMatchObject({ mutationPolicy: "explicit-authorization-required", allowedMethods: ["GET", "POST"] });
  });

  it("picks up newly added routes while keeping existing checks", async () => {
    const project = await newProject();
    await writeFile(join(project, "app.ts"), "import express from 'express';\nconst app = express();\napp.get('/api/orders/:id', handler);\n");
    await compileProject(project);
    await authorChecks(project);
    await writeFile(join(project, "app.ts"), "import express from 'express';\nconst app = express();\napp.get('/api/orders/:id', handler);\napp.get('/api/users/:id', handler);\n");

    const { plan, addedRouteIds } = await compileProject(project);
    expect(plan.surface.routes).toHaveLength(2);
    expect(addedRouteIds).toHaveLength(1);
    expect(plan.checks).toHaveLength(1);
    expect(plan.coverage.inScopeRouteIds).toHaveLength(2);
  });

  it("refuses to write, rather than silently dropping a check whose route disappeared", async () => {
    const project = await newProject();
    await writeFile(join(project, "app.ts"), "import express from 'express';\nconst app = express();\napp.get('/api/orders/:id', handler);\n");
    await compileProject(project);
    await authorChecks(project);
    await writeFile(join(project, "app.ts"), "import express from 'express';\nconst app = express();\napp.get('/api/something-else', handler);\n");

    await expect(compileProject(project)).rejects.toThrow(/chk_auth/);
    // The authored plan must survive the failed recompile untouched.
    expect((await loadPlan(project)).checks).toHaveLength(1);
  });

  it("discards authored content only when explicitly forced", async () => {
    const project = await newProject();
    await writeFile(join(project, "app.ts"), "import express from 'express';\nconst app = express();\napp.get('/api/orders/:id', handler);\n");
    await compileProject(project);
    await authorChecks(project);
    const { plan, merged } = await compileProject(project, { force: true });
    expect(merged).toBe(false);
    expect(plan.checks).toEqual([]);
  });

  it("refuses to recompile over an invalid plan instead of overwriting it", async () => {
    const project = await newProject();
    await writeFile(join(project, "app.ts"), "import express from 'express';\nconst app = express();\napp.get('/api/orders/:id', handler);\n");
    await compileProject(project);
    await writeFile(join(project, ".trinker", "plan.json"), JSON.stringify({ schemaVersion: 1, bogus: true }));
    await expect(compileProject(project)).rejects.toThrow(/invalid.*--force/s);
  });
});

describe("OpenAPI ingestion", () => {
  const spec = {
    openapi: "3.0.0",
    paths: {
      "/api/orders/{id}": { get: { operationId: "getOrder" }, delete: { operationId: "deleteOrder" } },
      "/api/reports": { get: { operationId: "listReports" } },
    },
  };

  it("merges specification routes with routes extracted from source", async () => {
    const project = await newProject();
    await writeFile(join(project, "app.ts"), "import express from 'express';\nconst app = express();\napp.get('/api/health', handler);\n");
    await writeFile(join(project, "openapi.json"), JSON.stringify(spec));

    const { plan } = await compileProject(project, { openApiPath: join(project, "openapi.json") });
    const routes = plan.surface.routes.map((route) => `${route.method} ${route.pathTemplate}`).sort();
    expect(routes).toEqual(["DELETE /api/orders/:id", "GET /api/health", "GET /api/orders/:id", "GET /api/reports"]);
  });

  it("records the specification in provenance", async () => {
    const project = await newProject();
    await writeFile(join(project, "openapi.json"), JSON.stringify(spec));
    const { plan } = await compileProject(project, { openApiPath: join(project, "openapi.json") });
    expect(plan.provenance.sources.some((source) => source.kind === "openapi")).toBe(true);
  });

  it("keeps both source references when a route appears in the code and the specification", async () => {
    const project = await newProject();
    await writeFile(join(project, "app.ts"), "import express from 'express';\nconst app = express();\napp.get('/api/reports', handler);\n");
    await writeFile(join(project, "openapi.json"), JSON.stringify(spec));

    const { plan } = await compileProject(project, { openApiPath: join(project, "openapi.json") });
    const route = plan.surface.routes.find((candidate) => candidate.pathTemplate === "/api/reports");
    expect(route?.sourceRefs.map((ref) => ref.kind).sort()).toEqual(["ast", "openapi"]);
  });

  it("works for a project with no extractable source at all", async () => {
    const project = await newProject();
    await writeFile(join(project, "openapi.json"), JSON.stringify(spec));
    const { plan } = await compileProject(project, { openApiPath: join(project, "openapi.json") });
    expect(plan.surface.routes).toHaveLength(3);
    expect(plan.coverage.inScopeRouteIds).toHaveLength(3);
  });

  it("refuses a YAML specification with a conversion hint rather than misparsing it", async () => {
    const project = await newProject();
    await writeFile(join(project, "openapi.yaml"), "openapi: 3.0.0\npaths:\n  /api/x:\n    get: {}\n");
    await expect(compileProject(project, { openApiPath: join(project, "openapi.yaml") }))
      .rejects.toThrow(/does not look like JSON.*js-yaml/s);
  });

  it("reports a missing file, malformed JSON, and an empty specification distinctly", async () => {
    const project = await newProject();
    await expect(compileProject(project, { openApiPath: join(project, "absent.json") })).rejects.toThrow(/Could not read/);
    await writeFile(join(project, "broken.json"), "{ not json");
    await expect(compileProject(project, { openApiPath: join(project, "broken.json") })).rejects.toThrow(/not valid JSON/);
    await writeFile(join(project, "empty.json"), JSON.stringify({ openapi: "3.0.0", paths: {} }));
    await expect(compileProject(project, { openApiPath: join(project, "empty.json") })).rejects.toThrow(/no usable operations/);
  });

  it("still preserves authored checks when recompiling with a specification", async () => {
    const project = await newProject();
    await writeFile(join(project, "app.ts"), "import express from 'express';\nconst app = express();\napp.get('/api/orders/:id', handler);\n");
    await compileProject(project);
    await authorChecks(project);
    await writeFile(join(project, "openapi.json"), JSON.stringify(spec));

    const { plan, merged } = await compileProject(project, { openApiPath: join(project, "openapi.json") });
    expect(merged).toBe(true);
    expect(plan.checks.map((check) => check.id)).toEqual(["chk_auth"]);
    expect(plan.surface.routes.length).toBeGreaterThan(1);
  });
});
