import { createHash } from "node:crypto";
import {
  buildRequest, maskSecrets, redactHeaders,
  type BuiltRequest, type FindingDraft, type HttpResponse, type Oracle, type OracleContext,
} from "@trinker/core";

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

const fingerprint = (response: HttpResponse): ResponseFingerprint => ({
  status: response.status,
  bodyDigest: hash(response.body),
  bodyShape: bodyShape(response.body),
  contentType: response.headers["content-type"] ?? "",
});

/** Confirmation requires byte equality, not similarity. Shape and content type inform calibration only. */
const sameResponse = (left: ResponseFingerprint, right: ResponseFingerprint): boolean =>
  left.status === right.status && left.bodyDigest === right.bodyDigest;

interface Sample { identityId: string; request: BuiltRequest; response: HttpResponse; fingerprint: ResponseFingerprint; }

export const differentialAuthorizationOracle: Oracle = {
  name: "differential-authorization",
  async execute(context: OracleContext) {
    if (context.check.oracle !== "differential-authorization") {
      throw new Error(`differential-authorization oracle received a "${context.check.oracle}" check`);
    }
    const check = context.check;
    context.emit("phase.started", { phase: "authorization", checkId: check.id });

    const secrets = new Set<string>();
    const send = async (identityId: string): Promise<Sample> => {
      const request = buildRequest({ plan: context.plan, runtime: context.runtime, template: check.request, identityId });
      for (const secret of request.sensitiveValues) secrets.add(secret);
      const response = await context.http.request(request);
      return { identityId, request, response, fingerprint: fingerprint(response) };
    };

    // 1. Establish what a legitimate success looks like.
    const witnesses: Sample[] = [];
    for (const identityId of check.allowedIdentityIds) {
      const sample = await send(identityId);
      context.emit("check.progress", { checkId: check.id, identityId, role: "allowed", status: sample.response.status });
      if (sample.response.status >= 200 && sample.response.status < 300) witnesses.push(sample);
    }
    if (witnesses.length === 0) {
      return {
        status: "inconclusive",
        reason: "No allowed identity produced a successful reference response, so there is nothing to compare a denial against. Check the identity credentials and fixture in .trinker/runtime.json.",
      };
    }

    // 2. Measure how this application actually denies access, rather than assuming 401/403.
    const denials: Sample[] = [];
    for (const identityId of check.deniedIdentityIds) {
      for (let trial = 1; trial <= check.calibration.trials; trial++) {
        const sample = await send(identityId);
        denials.push(sample);
        context.emit("check.progress", { checkId: check.id, identityId, role: "denied", trial, status: sample.response.status });
      }
    }
    const denialStatuses = [...new Set(denials.map((sample) => sample.response.status))].sort((a, b) => a - b);
    const denialFingerprints = [...new Set(denials.map((sample) => `${sample.fingerprint.status}:${sample.fingerprint.contentType}:${sample.fingerprint.bodyShape}`))].sort();
    context.emit("oracle.calibrated", {
      checkId: check.id, oracle: "differential-authorization",
      denialStatuses, denialFingerprints, deniedSamples: denials.length, trials: check.calibration.trials,
    });

    // 3. Confirm only on an exact witness match.
    const sensitiveValues = [...secrets];
    for (const denied of denials) {
      const witness = witnesses.find((candidate) => sameResponse(candidate.fingerprint, denied.fingerprint));
      if (!witness) continue;
      const invariant = context.plan.invariants.find((candidate) => candidate.id === check.invariantId);
      const finding: FindingDraft = {
        status: "confirmed",
        title: "Broken Object Level Authorization",
        severity: "high",
        invariant: invariant?.statement ?? check.invariantId,
        routeId: check.request.routeId,
        oracle: "Differential Authorization",
        verdict: `${denied.identityId} received the exact successful response returned to ${witness.identityId}.`,
        evidence: {
          requests: [witnessRequest(witness, sensitiveValues), witnessRequest(denied, sensitiveValues)],
          responses: [witnessResponse(witness, sensitiveValues), witnessResponse(denied, sensitiveValues)],
          notes: [
            "The denied identity produced a byte-equivalent successful witness response.",
            `Observed denial status set: ${denialStatuses.join(", ") || "none"}.`,
            `Calibration: ${check.calibration.trials} trial(s) per denied identity, ${denials.length} denial sample(s) total.`,
          ],
        },
        replay: { checkId: check.id },
        remediation: "Enforce ownership authorization on the server before retrieving the requested resource.",
      };
      return { status: "failed", finding, reason: `Denied identity ${denied.identityId} matched an allowed witness response` };
    }

    // An unexpected success that is not byte-equivalent is not evidence of a broken check.
    const unexpected = denials.filter((sample) => sample.response.status >= 200 && sample.response.status < 300);
    if (unexpected.length > 0) {
      return {
        status: "inconclusive",
        reason: `A denied identity received a successful response that did not match any allowed witness (status ${[...new Set(unexpected.map((s) => s.response.status))].join(", ")}). This needs manual review; it is not mechanically confirmable.`,
      };
    }
    return { status: "passed", reason: `Denied identities did not match an allowed witness response (denial statuses: ${denialStatuses.join(", ")})` };
  },
};

const witnessRequest = (sample: Sample, secrets: readonly string[]) => ({
  method: sample.request.method,
  url: maskSecrets(sample.request.url, secrets),
  headers: redactHeaders(sample.request.headers, secrets),
});

const witnessResponse = (sample: Sample, secrets: readonly string[]) => ({
  status: sample.response.status,
  headers: redactHeaders(sample.response.headers, secrets),
  bodyDigest: sample.fingerprint.bodyDigest,
  bodyPreview: maskSecrets(sample.response.body.slice(0, 1000), secrets),
});
