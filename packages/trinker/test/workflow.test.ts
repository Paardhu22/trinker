import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileProject } from "../src/workflow.js";

describe("deterministic compilation", () => {
  it("creates a reviewable starter plan without invoking an LLM", async () => {
    const project = await mkdtemp(join(tmpdir(), "trinker-workflow-"));
    try {
      await writeFile(join(project, "app.ts"), "app.get('/api/orders/:id', handler);\n");
      const plan = await compileProject(project);
      expect(plan.surface.routes).toHaveLength(1);
      expect(plan.checks).toEqual([]);
      const persisted = JSON.parse(await readFile(join(project, ".trinker", "plan.json"), "utf8"));
      expect(persisted.planId).toBe(plan.planId);
    } finally { await rm(project, { recursive: true, force: true }); }
  });
});
