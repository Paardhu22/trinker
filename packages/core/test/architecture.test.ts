import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards the dependency direction that makes Trinker's central claim structural rather than
 * aspirational: a scan cannot spend LLM tokens, because the code that runs a scan has no path to
 * anything that could.
 *
 * If one of these fails, do not relax the test — the import it is complaining about is the bug.
 */
const packagesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function manifest(name: string): Promise<{ dependencies?: Record<string, string> }> {
  return JSON.parse(await readFile(join(packagesDir, name, "package.json"), "utf8"));
}

async function sourceFiles(name: string): Promise<string[]> {
  const root = join(packagesDir, name, "src");
  const out: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.name.endsWith(".ts")) out.push(await readFile(child, "utf8"));
    }
  };
  await walk(root);
  return out;
}

/** Packages that execute a scan. None of them may reach the LLM boundary. */
const RUNTIME_PACKAGES = ["core", "oracles", "report", "surface"];

describe("the scan path cannot reach an LLM", () => {
  it.each(RUNTIME_PACKAGES)("%s does not depend on @trinker/compiler", async (name) => {
    const dependencies = (await manifest(name)).dependencies ?? {};
    expect(Object.keys(dependencies)).not.toContain("@trinker/compiler");
  });

  it.each(RUNTIME_PACKAGES)("%s does not import @trinker/compiler", async (name) => {
    for (const source of await sourceFiles(name)) {
      expect(source).not.toMatch(/@trinker\/compiler/);
    }
  });

  it.each(RUNTIME_PACKAGES)("%s carries no LLM provider dependency", async (name) => {
    const dependencies = Object.keys((await manifest(name)).dependencies ?? {});
    for (const dependency of dependencies) {
      expect(dependency).not.toMatch(/anthropic|openai|@ai-sdk|langchain|cohere|mistral|google-genai/i);
    }
  });

  it("core depends only on zod", async () => {
    expect(Object.keys((await manifest("core")).dependencies ?? {})).toEqual(["zod"]);
  });
});

describe("the CLI reaches the compiler only on the LLM path", () => {
  const cliSources = async (): Promise<Map<string, string>> => {
    const root = join(packagesDir, "trinker", "src");
    const files = new Map<string, string>();
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".ts")) files.set(entry.name, await readFile(join(root, entry.name), "utf8"));
    }
    return files;
  };

  it("never imports @trinker/compiler statically", async () => {
    // A static import would pull the compiler — and its provider — into every `trinker run`.
    // The LLM path uses `await import(...)` so a scan never loads a model client at all.
    for (const [name, source] of await cliSources()) {
      const staticImport = /^\s*import\s[^;]*from\s+["']@trinker\/compiler["']/m;
      expect(source, `${name} imports @trinker/compiler statically`).not.toMatch(staticImport);
    }
  });

  it("carries no direct provider SDK dependency outside the compiler", async () => {
    const dependencies = Object.keys((await manifest("trinker")).dependencies ?? {});
    for (const dependency of dependencies) {
      expect(dependency).not.toMatch(/anthropic|openai|@ai-sdk|langchain|cohere|mistral|google-genai/i);
    }
  });
});

describe("core stays independent of presentation and filesystem layout", () => {
  it("does not import terminal or CLI concerns", async () => {
    for (const source of await sourceFiles("core")) {
      expect(source).not.toMatch(/node:readline|process\.stdout|process\.stdin/);
    }
  });

  it("performs no filesystem I/O", async () => {
    // Reading and writing `.trinker/` belongs to the CLI's workflow adapter, not to the engine.
    // Core may *name* runtime.json in an error message — telling a user which file to edit is the
    // whole value of that diagnostic — but it must never open one.
    for (const source of await sourceFiles("core")) {
      expect(source).not.toMatch(/from "node:fs|require\("node:fs/);
    }
  });
});
