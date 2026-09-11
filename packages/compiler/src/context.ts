import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plan, Route } from "@trinker/core";
import type { ProposalRequest } from "./provider.js";

/** A few lines around a route declaration, so the model can see how the handler is wired. */
export interface SourceExcerpt {
  file: string;
  line: number;
  text: string;
}

export interface CompilerContext extends ProposalRequest {
  applicationId: string;
  frameworks: string[];
  mutationPolicy: Plan["safety"]["mutationPolicy"];
  sourceExcerpts: SourceExcerpt[];
}

export interface BuildContextOptions {
  plan: Plan;
  availableOracles: readonly string[];
  /** Where to read source excerpts from. Omit to build a context with no excerpts. */
  rootDir?: string | undefined;
  /** Lines of context on each side of a route declaration. */
  excerptRadius?: number;
  /** Upper bound on excerpts, so a large application cannot blow up the prompt. */
  maxExcerpts?: number;
}

const DEFAULT_RADIUS = 6;
const DEFAULT_MAX_EXCERPTS = 40;

/**
 * Assemble everything the model is allowed to see.
 *
 * The model gets the discovered surface, the safety constraints it must respect, what the plan
 * already contains, and a narrow window of source around each route declaration. It does not get
 * runtime configuration, credentials, or a target URL — it has no use for them, and they must not
 * leave the machine. `compileWithProvider` asserts that separation independently.
 *
 * Excerpts are deliberately narrow. Pasting whole files would cost tokens proportional to the
 * repository rather than to its attack surface, and cost efficiency is the point of compiling once.
 */
export async function buildCompilerContext(options: BuildContextOptions): Promise<CompilerContext> {
  const { plan } = options;
  const radius = options.excerptRadius ?? DEFAULT_RADIUS;
  const limit = options.maxExcerpts ?? DEFAULT_MAX_EXCERPTS;

  return {
    applicationId: plan.target.applicationId,
    frameworks: [...plan.surface.frameworks],
    routes: plan.surface.routes,
    resources: plan.surface.resources,
    availableOracles: [...options.availableOracles],
    allowedMethods: [...plan.safety.allowedMethods],
    mutationPolicy: plan.safety.mutationPolicy,
    existing: {
      identities: plan.identities,
      fixtures: plan.fixtures,
      invariants: plan.invariants,
      checks: plan.checks,
    },
    sourceExcerpts: options.rootDir === undefined ? [] : await readExcerpts(options.rootDir, plan.surface.routes, radius, limit),
  };
}

async function readExcerpts(rootDir: string, routes: readonly Route[], radius: number, limit: number): Promise<SourceExcerpt[]> {
  // One excerpt per declaration site, deduplicated: several routes often share a handler block.
  const wanted = new Map<string, { file: string; line: number }>();
  for (const route of routes) {
    for (const reference of route.sourceRefs) {
      if (reference.kind !== "ast" || reference.path === undefined || reference.line === undefined) continue;
      const key = `${reference.path}:${Math.floor(reference.line / Math.max(radius, 1))}`;
      if (!wanted.has(key)) wanted.set(key, { file: reference.path, line: reference.line });
    }
  }

  const cache = new Map<string, string[] | undefined>();
  const excerpts: SourceExcerpt[] = [];
  for (const { file, line } of [...wanted.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
    if (excerpts.length >= limit) break;
    if (!cache.has(file)) {
      try { cache.set(file, (await readFile(join(rootDir, file), "utf8")).split("\n")); }
      catch { cache.set(file, undefined); }
    }
    const lines = cache.get(file);
    if (!lines) continue;
    const start = Math.max(line - radius - 1, 0);
    const end = Math.min(line + radius, lines.length);
    excerpts.push({ file, line, text: lines.slice(start, end).join("\n") });
  }
  return excerpts;
}
