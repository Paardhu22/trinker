import { createHash } from "node:crypto";
import ts from "typescript";
import type { Route } from "@trinker/core";

export type Framework = "express" | "fastify" | "openapi" | "unknown";
export type ReceiverKind = "app" | "router";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
/**
 * Identifier names conventionally used for an app or router. Used only as weaker evidence when no
 * factory call is visible; a route found this way is never reported as high confidence.
 */
const CONVENTIONAL_APP_NAMES = new Set(["app", "server", "api", "fastify"]);
const CONVENTIONAL_ROUTER_NAMES = /^(router|routes)$|(?:Router|Routes)$/;

export const methodFrom = (value: string): Route["method"] | undefined => {
  const method = value.toUpperCase();
  return (["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const).find((candidate) => candidate === method);
};

/** Text of a string literal or a template literal that has no substitutions. */
const literalText = (node: ts.Expression | undefined): string | undefined =>
  node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;

const idPart = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "root";
export const routeId = (method: string, path: string): string =>
  `route_${idPart(method)}_${idPart(path)}_${createHash("sha256").update(`${method} ${path}`).digest("hex").slice(0, 8)}`;

export function pathParameters(pathTemplate: string): Route["parameters"] {
  return [...pathTemplate.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => ({ name: match[1]!, location: "path" as const, required: true }));
}

/** Join a mount prefix with a route path without producing doubled or trailing slashes. */
export function joinPath(prefix: string, path: string): string {
  const left = prefix.replace(/\/+$/, "");
  const right = path === "/" ? "" : path.replace(/^\/+/, "/");
  const joined = `${left}${right}`;
  return joined.startsWith("/") ? joined || "/" : `/${joined}`;
}

interface RawRoute {
  receiver: string;
  method: Route["method"];
  declaredPath: string;
  line: number;
  /** Name of the function the route was declared inside, for Fastify plugin prefixes. */
  enclosingFunction?: string;
}
interface RawMount { prefix: string; target: string }

export interface FileExtraction {
  file: string;
  frameworks: Set<Framework>;
  /** Identifiers proven to hold an app or router by a visible factory call. */
  receivers: Map<string, ReceiverKind>;
  routes: RawRoute[];
  mounts: RawMount[];
  /** Local identifier -> module specifier, for resolving a router mounted in another file. */
  imports: Map<string, string>;
  /** Identifiers this module exports, so an importer can attribute a mount to them. */
  exported: Set<string>;
  /** Function name -> its parameter names, so a Fastify plugin's instance parameter is recognised. */
  functionParameters: Map<string, Set<string>>;
}

const EXPRESS_ROUTER_CALL = /^(?:express\.Router|Router)$/;
const FASTIFY_CALL = /^(?:Fastify|fastify)$/;

/** Collect everything route-related in one file, without yet deciding final paths. */
export function extractFile(source: string, file = "unknown.ts"): FileExtraction {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out: FileExtraction = {
    file, frameworks: new Set(), receivers: new Map(), routes: [], mounts: [], imports: new Map(),
    exported: new Set(), functionParameters: new Map(),
  };
  const lineOf = (node: ts.Node): number => ast.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const expressFactories = new Set<string>();
  const fastifyFactories = new Set<string>();

  const noteFactory = (local: string, module: string): void => {
    if (module === "express") { out.frameworks.add("express"); expressFactories.add(local); }
    if (module === "fastify") { out.frameworks.add("fastify"); fastifyFactories.add(local); }
  };

  // Pass 1: imports and framework evidence.
  const collectImports = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const module = literalText(node.moduleSpecifier);
      if (module) {
        const clause = node.importClause;
        if (clause?.name) { out.imports.set(clause.name.text, module); noteFactory(clause.name.text, module); }
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) { out.imports.set(element.name.text, module); noteFactory(element.name.text, module); }
        }
        if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          out.imports.set(clause.namedBindings.name.text, module); noteFactory(clause.namedBindings.name.text, module);
        }
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === "require") {
      const module = literalText(node.initializer.arguments[0]);
      if (module) { out.imports.set(node.name.text, module); noteFactory(node.name.text, module); }
    }
    ts.forEachChild(node, collectImports);
  };
  collectImports(ast);

  // Pass 2: which identifiers actually hold an app or a router.
  const collectReceivers = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
      const callee = node.initializer.expression.getText(ast);
      if (EXPRESS_ROUTER_CALL.test(callee) && (expressFactories.size === 0 || callee === "Router" || expressFactories.has(callee.split(".")[0]!))) {
        out.receivers.set(node.name.text, "router");
        out.frameworks.add("express");
      } else if (expressFactories.has(callee)) {
        out.receivers.set(node.name.text, "app");
        out.frameworks.add("express");
      } else if (FASTIFY_CALL.test(callee) || fastifyFactories.has(callee)) {
        out.receivers.set(node.name.text, "app");
        out.frameworks.add("fastify");
      }
    }
    ts.forEachChild(node, collectReceivers);
  };
  collectReceivers(ast);

  // Pass 3: exports, route declarations, and mounts.
  const addRoute = (receiver: string, methodValue: string, path: string, line: number, enclosing?: string): void => {
    const method = methodFrom(methodValue);
    if (!method || !path.startsWith("/")) return;
    out.routes.push({ receiver, method, declaredPath: path, line, ...(enclosing ? { enclosingFunction: enclosing } : {}) });
  };

  /** Name of a function-like node, for `async function ordersRoutes(fastify) {}` and `const r = (f) => {}`. */
  const functionName = (node: ts.Node): string | undefined => {
    if (ts.isFunctionDeclaration(node)) return node.name?.text;
    if ((ts.isFunctionExpression(node) || ts.isArrowFunction(node)) && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
      return node.parent.name.text;
    }
    return undefined;
  };

  const collectRoutes = (node: ts.Node, enclosing?: string): void => {
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
      const name = functionName(node);
      if (name) {
        out.functionParameters.set(name, new Set(node.parameters.filter((parameter) => ts.isIdentifier(parameter.name)).map((parameter) => (parameter.name as ts.Identifier).text)));
        enclosing = name;
      }
    }
    if (ts.isExportAssignment(node) && ts.isIdentifier(node.expression)) out.exported.add(node.expression.text);
    if (ts.isVariableStatement(node) && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const declaration of node.declarationList.declarations) if (ts.isIdentifier(declaration.name)) out.exported.add(declaration.name.text);
    }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) out.exported.add(element.propertyName?.text ?? element.name.text);
    }

    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const methodName = node.expression.name.text;
      const first = node.arguments[0];

      // app.use('/prefix', router)  |  app.use(router)
      if (methodName === "use") {
        const prefix = literalText(first);
        const mounted = node.arguments.slice(prefix === undefined ? 0 : 1).filter(ts.isIdentifier);
        for (const target of mounted) out.mounts.push({ prefix: prefix ?? "", target: target.text });
      }

      // fastify.register(plugin, { prefix: '/x' })
      if (methodName === "register") {
        const plugin = node.arguments[0];
        const opts = node.arguments[1];
        if (plugin && ts.isIdentifier(plugin) && opts && ts.isObjectLiteralExpression(opts)) {
          const prefixProp = opts.properties.filter(ts.isPropertyAssignment)
            .find((property) => property.name.getText(ast).replace(/["']/g, "") === "prefix");
          const prefix = literalText(prefixProp?.initializer);
          if (prefix !== undefined) out.mounts.push({ prefix, target: plugin.text });
        }
      }

      // <receiver>.get('/path', handler)
      const directPath = literalText(first);
      if (HTTP_METHODS.has(methodName) && directPath !== undefined && ts.isIdentifier(node.expression.expression)) {
        addRoute(node.expression.expression.text, methodName, directPath, lineOf(node), enclosing);
      }

      // fastify.route({ method, url })
      if (methodName === "route" && first && ts.isObjectLiteralExpression(first) && ts.isIdentifier(node.expression.expression)) {
        const props = new Map(first.properties.filter(ts.isPropertyAssignment).map((property) => [property.name.getText(ast).replace(/["']/g, ""), property.initializer]));
        const url = literalText(props.get("url")) ?? literalText(props.get("path"));
        const methodNode = props.get("method");
        const methods = methodNode && ts.isArrayLiteralExpression(methodNode)
          ? methodNode.elements.map((element) => literalText(element)).filter((value): value is string => value !== undefined)
          : [literalText(methodNode)].filter((value): value is string => value !== undefined);
        if (url) for (const method of methods) addRoute(node.expression.expression.text, method, url, lineOf(node), enclosing);
      }

      // app.route('/books').get(h).post(h) — walk the whole chain, not just the first link.
      if (HTTP_METHODS.has(methodName)) {
        const chain = routeChainBase(node.expression.expression, ast);
        if (chain) addRoute(chain.receiver, methodName, chain.path, lineOf(node), enclosing);
      }
    }
    ts.forEachChild(node, (child) => collectRoutes(child, enclosing));
  };
  collectRoutes(ast);

  if (out.frameworks.size === 0) out.frameworks.add("unknown");
  return out;
}

/** Walk back through `.get(h).post(h)` links to the `x.route('/path')` call that started the chain. */
function routeChainBase(node: ts.Expression, ast: ts.SourceFile): { receiver: string; path: string } | undefined {
  let current: ts.Expression = node;
  for (let depth = 0; depth < 12; depth++) {
    if (!ts.isCallExpression(current) || !ts.isPropertyAccessExpression(current.expression)) return undefined;
    const name = current.expression.name.text;
    if (name === "route") {
      const path = literalText(current.arguments[0]);
      const receiver = current.expression.expression;
      if (path !== undefined && ts.isIdentifier(receiver)) return { receiver: receiver.text, path };
      return undefined;
    }
    if (!HTTP_METHODS.has(name) && name !== "all") return undefined;
    current = current.expression.expression;
  }
  return undefined;
}

export interface ResolvedMount { prefix: string; confident: boolean }

/**
 * Decide each raw route's final path and how much to trust it.
 *
 * A route is only emitted when its receiver is credibly an app or router. `cache.get('/x')` is not
 * a route, and guessing one would put a fabricated endpoint into a reviewed security plan.
 */
export function resolveRoutes(extraction: FileExtraction, externalMounts: Map<string, ResolvedMount[]> = new Map()): Route[] {
  const routes: Route[] = [];

  for (const raw of extraction.routes) {
    // A Fastify plugin receives the instance as a parameter; its prefix comes from the register call.
    const pluginOf = raw.enclosingFunction !== undefined
      && extraction.functionParameters.get(raw.enclosingFunction)?.has(raw.receiver) === true
      ? raw.enclosingFunction
      : undefined;

    const declaredKind = extraction.receivers.get(raw.receiver);
    const conventional: ReceiverKind | undefined = declaredKind !== undefined
      ? undefined
      : CONVENTIONAL_APP_NAMES.has(raw.receiver) ? "app" : CONVENTIONAL_ROUTER_NAMES.test(raw.receiver) ? "router" : undefined;
    const kind: ReceiverKind | undefined = pluginOf !== undefined ? "router" : declaredKind ?? conventional;
    if (!kind) continue; // Unknown receiver: prefer a missing route over an invented one.

    const mountTarget = pluginOf ?? raw.receiver;
    const proven = pluginOf !== undefined || declaredKind !== undefined;
    const mounts = kind === "router"
      ? [...(extraction.mounts.filter((mount) => mount.target === mountTarget).map((mount) => ({ prefix: mount.prefix, confident: true }))),
         ...(externalMounts.get(mountTarget) ?? [])]
      : [];

    if (kind === "app" || mounts.length === 0) {
      // An unmounted router's declared path is very likely incomplete, so say so rather than imply a full URL.
      const confidence: Route["confidence"] = kind === "router" ? "low" : proven ? "high" : "medium";
      const note = kind === "router"
        ? "Router is never mounted in the analysed sources; the real path is probably prefixed."
        : proven ? undefined : `Receiver "${raw.receiver}" was matched by naming convention, not by a visible framework factory call.`;
      routes.push(makeRoute(raw.declaredPath, raw, extraction.file, confidence, note));
      continue;
    }

    for (const mount of mounts) {
      const path = joinPath(mount.prefix, raw.declaredPath);
      const confidence: Route["confidence"] = proven && mount.confident && mounts.length === 1 ? "high" : "medium";
      const note = mounts.length > 1 ? `Router is mounted at ${mounts.length} prefixes; this is one of them.` : mount.confident ? undefined : "Mount prefix resolved across files.";
      routes.push(makeRoute(path, raw, extraction.file, confidence, note));
    }
  }
  return routes;
}

function makeRoute(path: string, raw: RawRoute, file: string, confidence: Route["confidence"], note?: string): Route {
  return {
    id: routeId(raw.method, path),
    method: raw.method,
    pathTemplate: path,
    parameters: pathParameters(path),
    sourceRefs: [{ kind: "ast" as const, path: file, line: raw.line, ...(note ? { note } : {}) }],
    confidence,
  };
}
