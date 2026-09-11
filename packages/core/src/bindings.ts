import type { Plan, RequestTemplate, RuntimeConfig, ValueBinding } from "./schema.js";

/**
 * Raised when a plan references runtime data that the local configuration does not supply.
 * Distinct from a generic Error so the runner can classify it as a configuration fault rather
 * than letting it masquerade as an inconclusive security result.
 */
export class BindingResolutionError extends Error {
  public constructor(message: string) { super(message); this.name = "BindingResolutionError"; }
}

export interface ResolvedValue {
  value: string;
  /** True when the value came from `runtime.values`, which is treated as secret. */
  sensitive: boolean;
}

const primitive = (value: unknown): value is string | number | boolean =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

export function resolveBinding(plan: Plan, runtime: RuntimeConfig, binding: ValueBinding): ResolvedValue {
  if ("literal" in binding) return { value: String(binding.literal), sensitive: false };

  if ("runtimeRef" in binding) {
    const value = runtime.values[binding.runtimeRef];
    if (value === undefined) {
      throw new BindingResolutionError(
        `Runtime value "${binding.runtimeRef}" is not defined. Add it to "values" in .trinker/runtime.json.`,
      );
    }
    return { value: String(value), sensitive: true };
  }

  const fixture = plan.fixtures.find((candidate) => candidate.id === binding.fixtureRef);
  if (!fixture) throw new BindingResolutionError(`Plan has no fixture "${binding.fixtureRef}"`);
  const bag = runtime.fixtures[fixture.runtimeRef];
  if (!bag) {
    throw new BindingResolutionError(
      `Fixture "${fixture.runtimeRef}" is not defined. Add it to "fixtures" in .trinker/runtime.json.`,
    );
  }
  const value = bag[binding.field];
  if (!primitive(value)) {
    throw new BindingResolutionError(`Fixture "${fixture.runtimeRef}.${binding.field}" must resolve to a string, number, or boolean`);
  }
  return { value: String(value), sensitive: false };
}

const isBinding = (value: unknown): value is ValueBinding =>
  typeof value === "object" && value !== null && !Array.isArray(value) &&
  ("literal" in value || "runtimeRef" in value || "fixtureRef" in value);

export interface BuiltRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  /** Resolved secret values, for masking anywhere this request or its response is recorded. */
  sensitiveValues: string[];
}

export interface BuildRequestOptions {
  plan: Plan;
  runtime: RuntimeConfig;
  template: RequestTemplate;
  /** Identity whose credential headers seed the request. Omit for an unauthenticated request. */
  identityId?: string | undefined;
  /** Overrides the route's own method (used by oracles that read back state). */
  method?: string | undefined;
}

/**
 * Turn a plan's declarative request template into a concrete HTTP request.
 *
 * Shared by every oracle so that binding semantics, credential lookup, and secret tracking cannot
 * drift between them.
 */
export function buildRequest(options: BuildRequestOptions): BuiltRequest {
  const { plan, runtime, template } = options;
  const sensitive = new Set<string>();
  const resolve = (binding: ValueBinding): string => {
    const resolved = resolveBinding(plan, runtime, binding);
    if (resolved.sensitive && resolved.value !== "") sensitive.add(resolved.value);
    return resolved.value;
  };

  const route = plan.surface.routes.find((candidate) => candidate.id === template.routeId);
  if (!route) throw new BindingResolutionError(`Plan has no route "${template.routeId}"`);

  let path = route.pathTemplate;
  for (const [name, binding] of Object.entries(template.pathBindings)) {
    const value = encodeURIComponent(resolve(binding));
    path = path.replace(`:${name}`, value).replace(`{${name}}`, value);
  }

  const targetRef = plan.target.allowedTargetRefs[0];
  if (!targetRef) throw new BindingResolutionError("Plan contains no allowed target reference");
  const target = runtime.targets[targetRef];
  if (!target) throw new BindingResolutionError(`Runtime configuration has no target named "${targetRef}"`);

  const url = new URL(path, target.url);
  for (const [name, binding] of Object.entries(template.queryBindings)) url.searchParams.set(name, resolve(binding));

  const headers: Record<string, string> = {};
  if (options.identityId !== undefined) {
    const identity = plan.identities.find((candidate) => candidate.id === options.identityId);
    if (!identity) throw new BindingResolutionError(`Plan has no identity "${options.identityId}"`);
    const credentialKey = identity.credentialRef ?? identity.id;
    const credentials = runtime.identities[credentialKey];
    if (credentials) {
      for (const [name, value] of Object.entries(credentials.headers)) {
        headers[name] = value;
        if (value !== "") sensitive.add(value);
      }
    }
  }
  for (const [name, binding] of Object.entries(template.headerBindings)) headers[name] = resolve(binding);

  const built: BuiltRequest = {
    method: options.method ?? route.method,
    url: url.toString(),
    headers,
    sensitiveValues: [...sensitive],
  };
  if (template.body !== undefined) built.body = resolveBody(plan, runtime, template.body, resolve);
  return built;
}

/** Recursively replace embedded value bindings inside a request body. */
function resolveBody(plan: Plan, runtime: RuntimeConfig, body: unknown, resolve: (binding: ValueBinding) => string): unknown {
  if (isBinding(body)) return resolve(body);
  if (Array.isArray(body)) return body.map((item) => resolveBody(plan, runtime, item, resolve));
  if (body && typeof body === "object") {
    return Object.fromEntries(Object.entries(body as Record<string, unknown>).map(([key, value]) => [key, resolveBody(plan, runtime, value, resolve)]));
  }
  return body;
}

const SENSITIVE_HEADER = /authorization|cookie|token|secret|api[_-]?key|password/i;

/** Redact credential-bearing headers by name, and mask any known secret value by content. */
export function redactHeaders(headers: Record<string, string>, sensitiveValues: readonly string[] = []): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) =>
    SENSITIVE_HEADER.test(name) ? [name, "[REDACTED]"] : [name, maskSecrets(value, sensitiveValues)]));
}

/** Replace every occurrence of a known secret with a redaction marker. */
export function maskSecrets(text: string, sensitiveValues: readonly string[] = []): string {
  let masked = text;
  // Longest first, so a secret that contains another secret is not partially replaced.
  for (const secret of [...sensitiveValues].filter((value) => value.length > 0).sort((a, b) => b.length - a.length)) {
    masked = masked.split(secret).join("[REDACTED]");
    masked = masked.split(encodeURIComponent(secret)).join("[REDACTED]");
  }
  return masked;
}
