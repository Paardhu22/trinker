import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import ts from "typescript";
import type { Resource, Route } from "@trinker/core";

export interface Surface {
  frameworks: Array<"express" | "fastify" | "openapi" | "unknown">;
  routes: Route[];
  resources: Resource[];
  digest: string;
}

export interface DiscoverOptions { rootDir: string; include?: RegExp; }

const METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
const methodFrom = (value: string): Route["method"] | undefined => {
  const method = value.toUpperCase();
  return ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(method) ? method as Route["method"] : undefined;
};
const literalText = (node: ts.Expression | undefined): string | undefined => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
const idPart = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "root";
const routeId = (method: string, path: string): string => `route_${idPart(method)}_${idPart(path)}_${createHash("sha256").update(`${method} ${path}`).digest("hex").slice(0, 8)}`;
const digest = (value: unknown): string => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

function parameters(pathTemplate: string): Route["parameters"] {
  return [...pathTemplate.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => ({ name: match[1]!, location: "path", required: true }));
}

export function extractRoutesFromSource(source: string, file = "unknown.ts"): Route[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const discovered: Route[] = [];
  const add = (methodValue: string, path: string, line: number, framework: "express" | "fastify") => {
    const method = methodFrom(methodValue);
    if (!method || !path.startsWith("/")) return;
    discovered.push({ id: routeId(method, path), method, pathTemplate: path, parameters: parameters(path), sourceRefs: [{ kind: "ast", path: file, line }], confidence: "high" });
    void framework;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const methodName = node.expression.name.text;
      const first = node.arguments[0];
      const directPath = literalText(first);
      if (METHODS.has(methodName) && directPath) add(methodName, directPath, ast.getLineAndCharacterOfPosition(node.getStart()).line + 1, "express");
      if (methodName === "route" && first && ts.isObjectLiteralExpression(first)) {
        const props = new Map(first.properties.filter(ts.isPropertyAssignment).map((prop) => [prop.name.getText(ast).replace(/["']/g, ""), prop.initializer]));
        const url = literalText(props.get("url")) ?? literalText(props.get("path"));
        const method = literalText(props.get("method"));
        if (url && method) add(method, url, ast.getLineAndCharacterOfPosition(node.getStart()).line + 1, "fastify");
      }
      if (METHODS.has(methodName) && ts.isCallExpression(node.expression.expression) && ts.isPropertyAccessExpression(node.expression.expression.expression) && node.expression.expression.expression.name.text === "route") {
        const routeCall = node.expression.expression;
        const routePath = literalText(routeCall.arguments[0]);
        if (routePath) add(methodName, routePath, ast.getLineAndCharacterOfPosition(node.getStart()).line + 1, "express");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return dedupeRoutes(discovered);
}

export function detectFrameworksFromSource(source: string, file = "unknown.ts"): Surface["frameworks"] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found = new Set<Surface["frameworks"][number]>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const module = literalText(node.moduleSpecifier);
      if (module === "express") found.add("express");
      if (module === "fastify") found.add("fastify");
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
      const module = literalText(node.arguments[0]);
      if (module === "express") found.add("express");
      if (module === "fastify") found.add("fastify");
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return found.size > 0 ? [...found].sort() as Surface["frameworks"] : ["unknown"];
}

export function ingestOpenApi(document: unknown, source = "openapi"): Surface {
  const parsed = document as { paths?: Record<string, Record<string, unknown>> };
  const routes: Route[] = [];
  for (const [path, operations] of Object.entries(parsed.paths ?? {})) {
    for (const [methodName, operation] of Object.entries(operations)) {
      const method = methodFrom(methodName);
      if (!method || !operation || typeof operation !== "object") continue;
      const operationId = "operationId" in operation && typeof operation.operationId === "string" ? operation.operationId : undefined;
      routes.push({ id: routeId(method, path), method, pathTemplate: path.replace(/\{([^}]+)\}/g, ":$1"), ...(operationId ? { operationId } : {}), parameters: parameters(path.replace(/\{([^}]+)\}/g, ":$1")), sourceRefs: [{ kind: "openapi", path: source }], confidence: "high" });
    }
  }
  return normaliseSurface(routes, ["openapi"]);
}

export async function discoverSurface(options: DiscoverOptions): Promise<Surface> {
  const files = await sourceFiles(options.rootDir, options.include ?? /\.[cm]?[jt]sx?$/);
  const routes: Route[] = [];
  const frameworks = new Set<Surface["frameworks"][number]>();
  for (const file of files) {
    const source = await readFile(join(options.rootDir, file), "utf8");
    routes.push(...extractRoutesFromSource(source, file));
    for (const framework of detectFrameworksFromSource(source, file)) if (framework !== "unknown") frameworks.add(framework);
  }
  const detectedFrameworks: Surface["frameworks"] = frameworks.size > 0 ? [...frameworks].sort() as Surface["frameworks"] : ["unknown"];
  return normaliseSurface(routes, detectedFrameworks);
}

function normaliseSurface(routes: Route[], frameworks: Surface["frameworks"]): Surface {
  const sortedRoutes = dedupeRoutes(routes).sort((a, b) => a.id.localeCompare(b.id));
  const resources = inferResources(sortedRoutes);
  return { frameworks, routes: sortedRoutes, resources, digest: digest({ frameworks, routes: sortedRoutes, resources }) };
}

function dedupeRoutes(routes: Route[]): Route[] {
  const byId = new Map<string, Route>();
  for (const route of routes) {
    const existing = byId.get(route.id);
    byId.set(route.id, existing ? { ...existing, sourceRefs: [...existing.sourceRefs, ...route.sourceRefs] } : route);
  }
  return [...byId.values()];
}

function inferResources(routes: Route[]): Resource[] {
  const resourceRoutes = new Map<string, { routeIds: string[]; params: Set<string> }>();
  for (const route of routes) for (const parameter of route.parameters.filter((value) => value.location === "path")) {
    const name = parameter.name.replace(/Id$/i, "") || parameter.name;
    const item = resourceRoutes.get(name) ?? { routeIds: [], params: new Set<string>() };
    item.routeIds.push(route.id); item.params.add(parameter.name); resourceRoutes.set(name, item);
  }
  return [...resourceRoutes.entries()].map(([name, item]) => ({ id: `resource_${idPart(name)}`, name, routeParameter: [...item.params].sort()[0], routeIds: [...new Set(item.routeIds)].sort(), sourceRefs: [] })).sort((a, b) => a.id.localeCompare(b.id));
}

async function sourceFiles(rootDir: string, include: RegExp): Promise<string[]> {
  const out: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (["node_modules", "dist", ".git", ".trinker"].includes(entry.name)) continue;
      const child = join(directory, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (include.test(entry.name) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) out.push(relative(rootDir, child));
    }
  };
  await walk(rootDir);
  return out.sort();
}
