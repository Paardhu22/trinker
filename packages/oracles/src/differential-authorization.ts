import { createHash } from "node:crypto";
import type { Finding, HttpResponse, Oracle, OracleContext } from "@trinker/core";

interface ResponseFingerprint { status: number; bodyDigest: string; bodyShape: string; contentType: string; }
const hash = (value: string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const bodyShape = (body: string): string => {
  try {
    const parsed: unknown = JSON.parse(body);
    if (Array.isArray(parsed)) return `array:${parsed.length}`;
    if (parsed && typeof parsed === "object") return `object:${Object.keys(parsed as Record<string, unknown>).sort().join(",")}`;
  } catch { /* A plain response still has a deterministic shape. */ }
  return `text:${Math.min(body.length, 2048)}`;
};
const fingerprint = (response: HttpResponse): ResponseFingerprint => ({ status: response.status, bodyDigest: hash(response.body), bodyShape: bodyShape(response.body), contentType: response.headers["content-type"] ?? "" });
const sameResponse = (left: ResponseFingerprint, right: ResponseFingerprint): boolean => left.status === right.status && left.bodyDigest === right.bodyDigest;
const redactedHeaders = (headers: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(headers).map(([name, value]) => /authorization|cookie|token|secret/i.test(name) ? [name, "[REDACTED]"] : [name, value]));

function resolveBinding(context: OracleContext, binding: { fixtureRef: string; field: string } | { runtimeRef: string } | { literal: string | number | boolean }): string {
  if ("literal" in binding) return String(binding.literal);
  if ("runtimeRef" in binding) throw new Error(`runtimeRef bindings are not implemented: ${binding.runtimeRef}`);
  const fixture = context.plan.fixtures.find((candidate) => candidate.id === binding.fixtureRef);
  if (!fixture) throw new Error(`Unknown fixture ${binding.fixtureRef}`);
  const value = context.runtime.fixtures[fixture.runtimeRef]?.[binding.field];
  if (value === undefined || value === null || typeof value === "object") throw new Error(`Fixture ${fixture.runtimeRef}.${binding.field} must resolve to a primitive`);
  return String(value);
}

function requestFor(context: OracleContext, identityId: string): { method: string; url: string; headers: Record<string, string> } {
  const route = context.plan.surface.routes.find((candidate) => candidate.id === context.check.request.routeId);
  if (!route) throw new Error(`Unknown route ${context.check.request.routeId}`);
  let path = route.pathTemplate;
  for (const [name, binding] of Object.entries(context.check.request.pathBindings)) path = path.replace(`:${name}`, encodeURIComponent(resolveBinding(context, binding)));
  const targetRef = context.plan.target.allowedTargetRefs[0]!;
  const url = new URL(path, context.runtime.targets[targetRef]!.url);
  for (const [name, binding] of Object.entries(context.check.request.queryBindings)) url.searchParams.set(name, resolveBinding(context, binding));
  const identity = context.plan.identities.find((candidate) => candidate.id === identityId);
  if (!identity) throw new Error(`Unknown identity ${identityId}`);
  const credentialKey = identity.credentialRef ?? identity.id;
  const headers = { ...(context.runtime.identities[credentialKey]?.headers ?? {}) };
  for (const [name, binding] of Object.entries(context.check.request.headerBindings)) headers[name] = resolveBinding(context, binding);
  return { method: route.method, url: url.toString(), headers };
}

export const differentialAuthorizationOracle: Oracle = {
  name: "differential-authorization",
  async execute(context) {
    if (context.check.oracle !== "differential-authorization") return { status: "skipped", reason: "Check does not use differential authorization" };
    const check = context.check;
    context.emit("phase.started", { phase: "authorization", checkId: check.id });
    const allowedSamples = new Map<string, { request: ReturnType<typeof requestFor>; response: HttpResponse; fingerprint: ResponseFingerprint }>();
    for (const identityId of check.allowedIdentityIds) {
      const request = requestFor(context, identityId);
      const response = await context.http.request(request);
      allowedSamples.set(identityId, { request, response, fingerprint: fingerprint(response) });
      context.emit("check.progress", { checkId: check.id, identityId, status: response.status });
    }
    const allowed = check.allowedIdentityIds.map((id) => allowedSamples.get(id)!).filter((sample) => sample.response.status >= 200 && sample.response.status < 300);
    if (allowed.length === 0) return { status: "skipped", reason: "No allowed identity produced a successful reference response" };
    const denialSamples: Array<{ identityId: string; request: ReturnType<typeof requestFor>; response: HttpResponse; fingerprint: ResponseFingerprint }> = [];
    for (const identityId of check.deniedIdentityIds) {
      for (let trial = 1; trial <= check.calibration.trials; trial++) {
        const request = requestFor(context, identityId);
        const response = await context.http.request(request);
        denialSamples.push({ identityId, request, response, fingerprint: fingerprint(response) });
        context.emit("check.progress", { checkId: check.id, identityId, trial, status: response.status });
      }
    }
    const denialStatuses = [...new Set(denialSamples.map((sample) => sample.response.status))].sort((a, b) => a - b);
    const denialFingerprints = [...new Set(denialSamples.map((sample) => `${sample.fingerprint.status}:${sample.fingerprint.contentType}:${sample.fingerprint.bodyShape}`))].sort();
    context.emit("oracle.calibrated", { checkId: check.id, oracle: "differential-authorization", denialStatuses, denialFingerprints, deniedSamples: denialSamples.length, trials: check.calibration.trials });
    for (const denied of denialSamples) {
      const reference = allowed.find((candidate) => sameResponse(candidate.fingerprint, denied.fingerprint));
      if (!reference) continue;
      const invariant = context.plan.invariants.find((candidate) => candidate.id === check.invariantId)!;
      const finding: Finding = {
        id: "TRK-0000",
        status: "confirmed",
        title: "Broken Object Level Authorization",
        severity: "high",
        invariant: invariant.statement,
        routeId: check.request.routeId,
        oracle: "Differential Authorization",
        verdict: `${denied.identityId} received the exact successful response returned to ${check.allowedIdentityIds.find((id) => allowedSamples.get(id) === reference)!}.`,
        evidence: {
          requests: [
            { method: reference.request.method, url: reference.request.url, headers: redactedHeaders(reference.request.headers) },
            { method: denied.request.method, url: denied.request.url, headers: redactedHeaders(denied.request.headers) },
          ],
          responses: [
            { status: reference.response.status, headers: redactedHeaders(reference.response.headers), bodyDigest: reference.fingerprint.bodyDigest, bodyPreview: reference.response.body.slice(0, 1000) },
            { status: denied.response.status, headers: redactedHeaders(denied.response.headers), bodyDigest: denied.fingerprint.bodyDigest, bodyPreview: denied.response.body.slice(0, 1000) },
          ],
          notes: ["The denied identity produced a byte-equivalent successful witness response.", `Observed denial status set: ${denialStatuses.join(", ") || "none"}.`],
        },
        replay: { command: `trinker verify TRK-0000`, checkId: check.id },
        remediation: "Enforce ownership authorization on the server before retrieving the requested resource.",
      };
      return { status: "failed", finding, reason: "Denied identity matched an allowed witness response" };
    }
    if (denialSamples.some((sample) => sample.response.status >= 200 && sample.response.status < 300)) return { status: "skipped", reason: "Denied identity returned an unexpected success but not an equivalent witness response" };
    return { status: "passed", reason: "Denied identities did not match an allowed witness response" };
  },
};
