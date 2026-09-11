import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { Resource, Route } from "@trinker/core";
import {
  extractFile, methodFrom, pathParameters, resolveRoutes, routeId,
  type Framework, type ResolvedMount,
} from "./extract.js";

export * from "./extract.js";

export interface Surface {
  frameworks: Framework[];
  routes: Route[];
  resources: Resource[];
  digest: string;
}

export interface DiscoverOptions { rootDir: string; include?: RegExp }

const digest = (value: unknown): string => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

/** Single-file extraction. Routers mounted in another file cannot be resolved here. */
export function extractRoutesFromSource(source: string, file = "unknown.ts"): Route[] {
  return sortByDeclaration(dedupeRoutes(resolveRoutes(extractFile(source, file))));
}

/** Deterministic, readable order: declaration order, then method, since a chain shares one line. */
function sortByDeclaration(routes: Route[]): Route[] {
  return [...routes].sort((a, b) =>
    (a.sourceRefs[0]?.line ?? 0) - (b.sourceRefs[0]?.line ?? 0)
    || a.pathTemplate.localeCompare(b.pathTemplate)
    || a.method.localeCompare(b.method));
}

export function detectFrameworksFromSource(source: string, file = "unknown.ts"): Framework[] {
  const frameworks = [...extractFile(source, file).frameworks].filter((framework) => framework !== "unknown").sort();
  return frameworks.length > 0 ? frameworks : ["unknown"];
}

export function ingestOpenApi(document: unknown, source = "openapi"): Surface {
  const parsed = document as { paths?: Record<string, Record<string, unknown>> };
  const routes: Route[] = [];
  for (const [rawPath, operations] of Object.entries(parsed.paths ?? {})) {
    const path = rawPath.replace(/\{([^}]+)\}/g, ":$1");
    for (const [methodName, operation] of Object.entries(operations ?? {})) {
      const method = methodFrom(methodName);
      if (!method || !operation || typeof operation !== "object") continue;
      const operationId = "operationId" in operation && typeof operation.operationId === "string" ? operation.operationId : undefined;
      routes.push({
        id: routeId(method, path), method, pathTemplate: path,
        ...(operationId ? { operationId } : {}),
        parameters: pathParameters(path),
        sourceRefs: [{ kind: "openapi" as const, path: source }],
        // A specification is a declaration of intent, not an inference.
        confidence: "high",
      });
    }
  }
  return normaliseSurface(routes, ["openapi"]);
}

export async function discoverSurface(options: DiscoverOptions): Promise<Surface> {
  const files = await sourceFiles(options.rootDir, options.include ?? /\.[cm]?[jt]sx?$/);
  const extractions = await Promise.all(files.map(async (file) => extractFile(await readFile(join(options.rootDir, file), "utf8"), file)));
  const knownFiles = new Set(files);

  /**
   * Cross-file mounts: when one module does `app.use('/api/orders', ordersRouter)` and
   * `ordersRouter` came from `./routes/orders`, attribute that prefix to the routers declared in
   * that file. Without this, every router in a multi-file app looks unmounted.
   */
  const externalMounts = new Map<string, Map<string, ResolvedMount[]>>();
  for (const extraction of extractions) {
    for (const mount of extraction.mounts) {
      const specifier = extraction.imports.get(mount.target);
      if (!specifier || !specifier.startsWith(".")) continue;
      const targetFile = resolveModule(extraction.file, specifier, knownFiles);
      if (!targetFile) continue;
      const target = extractions.find((candidate) => candidate.file === targetFile);
      if (!target) continue;
      // Apply to every router this module declares and exports.
      for (const [name, kind] of target.receivers) {
        if (kind !== "router") continue;
        if (target.exported.size > 0 && !target.exported.has(name)) continue;
        const perFile = externalMounts.get(targetFile) ?? new Map<string, ResolvedMount[]>();
        perFile.set(name, [...(perFile.get(name) ?? []), { prefix: mount.prefix, confident: false }]);
        externalMounts.set(targetFile, perFile);
      }
    }
  }

  const routes: Route[] = [];
  const frameworks = new Set<Framework>();
  for (const extraction of extractions) {
    routes.push(...resolveRoutes(extraction, externalMounts.get(extraction.file)));
    for (const framework of extraction.frameworks) if (framework !== "unknown") frameworks.add(framework);
  }
  return normaliseSurface(routes, frameworks.size > 0 ? [...frameworks].sort() : ["unknown"]);
}

const CANDIDATE_SUFFIXES = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.js", "/index.mjs"];

/** Best-effort resolution of a relative import to one of the files we scanned. */
function resolveModule(fromFile: string, specifier: string, knownFiles: ReadonlySet<string>): string | undefined {
  const base = resolve("/", dirname(fromFile), specifier).slice(1);
  const withoutExt = base.replace(/\.[cm]?[jt]sx?$/, "");
  for (const suffix of CANDIDATE_SUFFIXES) {
    for (const candidate of [`${base}${suffix}`, `${withoutExt}${suffix}`]) {
      if (knownFiles.has(candidate)) return candidate;
    }
  }
  return undefined;
}

function normaliseSurface(routes: Route[], frameworks: Framework[]): Surface {
  const sortedRoutes = dedupeRoutes(routes).sort((a, b) => a.id.localeCompare(b.id));
  const resources = inferResources(sortedRoutes);
  return { frameworks, routes: sortedRoutes, resources, digest: digest({ frameworks, routes: sortedRoutes, resources }) };
}

const CONFIDENCE_RANK: Record<Route["confidence"], number> = { high: 3, medium: 2, low: 1 };

function dedupeRoutes(routes: Route[]): Route[] {
  const byId = new Map<string, Route>();
  for (const route of routes) {
    const existing = byId.get(route.id);
    if (!existing) { byId.set(route.id, route); continue; }
    // Same endpoint seen twice: keep every source reference, and the strongest evidence.
    byId.set(route.id, {
      ...existing,
      confidence: CONFIDENCE_RANK[route.confidence] > CONFIDENCE_RANK[existing.confidence] ? route.confidence : existing.confidence,
      sourceRefs: [...existing.sourceRefs, ...route.sourceRefs],
    });
  }
  return [...byId.values()];
}

function inferResources(routes: Route[]): Resource[] {
  const resourceRoutes = new Map<string, { routeIds: string[]; params: Set<string> }>();
  for (const route of routes) {
    for (const parameter of route.parameters.filter((value) => value.location === "path")) {
      const name = parameter.name.replace(/Id$/i, "") || parameter.name;
      const item = resourceRoutes.get(name) ?? { routeIds: [], params: new Set<string>() };
      item.routeIds.push(route.id);
      item.params.add(parameter.name);
      resourceRoutes.set(name, item);
    }
  }
  return [...resourceRoutes.entries()]
    .map(([name, item]) => ({
      id: `resource_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_") || "root"}`,
      name,
      routeParameter: [...item.params].sort()[0],
      routeIds: [...new Set(item.routeIds)].sort(),
      sourceRefs: [],
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function sourceFiles(rootDir: string, include: RegExp): Promise<string[]> {
  const out: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (["node_modules", "dist", "build", ".git", ".trinker"].includes(entry.name)) continue;
      const child = join(directory, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (include.test(entry.name) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) out.push(relative(rootDir, child));
    }
  };
  await walk(rootDir);
  return out.sort();
}
