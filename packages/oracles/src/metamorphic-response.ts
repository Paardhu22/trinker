import { createHash } from "node:crypto";
import {
  buildRequest, maskSecrets, redactHeaders,
  type BuiltRequest, type FindingDraft, type HttpResponse, type Oracle, type OracleContext,
} from "@trinker/core";

const hash = (value: string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;

type Relation = "identical" | "status-identical";

interface Sample { name: string; request: BuiltRequest; response: HttpResponse; bodyDigest: string }

/** Compare two samples under the declared relation. Returns the reason they differ, or undefined. */
function difference(relation: Relation, reference: Sample, candidate: Sample): string | undefined {
  if (reference.response.status !== candidate.response.status) {
    return `status ${reference.response.status} -> ${candidate.response.status}`;
  }
  if (relation === "identical" && reference.bodyDigest !== candidate.bodyDigest) {
    return `body digest ${reference.bodyDigest} -> ${candidate.bodyDigest}`;
  }
  return undefined;
}

/**
 * Confirms that a request parameter influences a response it should have no control over.
 *
 * The canonical case is client-controlled data scoping: if `?userId=someone-else` changes what
 * comes back, the server is trusting a caller-supplied parameter to decide which records to
 * return. The plan declares the relation that must hold between variants; the oracle only checks
 * it. It never guesses which parameters are security relevant.
 *
 * A difference is only meaningful if the endpoint is deterministic to begin with, so the first
 * variant is repeated as a control. An endpoint whose body carries a timestamp or nonce is
 * reported inconclusive rather than confirmed.
 */
export const metamorphicResponseOracle: Oracle = {
  name: "metamorphic-response",
  async execute(context: OracleContext) {
    if (context.check.oracle !== "metamorphic-response") {
      throw new Error(`metamorphic-response oracle received a "${context.check.oracle}" check`);
    }
    const check = context.check;
    context.emit("phase.started", { phase: "metamorphic-response", checkId: check.id });

    const relation: Relation = check.relation;
    const secrets = new Set<string>();
    const send = async (variant: { name: string; queryBindings: Record<string, unknown> }): Promise<Sample> => {
      const request = buildRequest({
        plan: context.plan,
        runtime: context.runtime,
        identityId: check.identityId,
        // Variant query bindings replace the template's, which is what makes the variants differ.
        template: { ...check.request, queryBindings: variant.queryBindings as never },
      });
      for (const secret of request.sensitiveValues) secrets.add(secret);
      const response = await context.http.request(request);
      return { name: variant.name, request, response, bodyDigest: hash(response.body) };
    };

    const [first, ...rest] = check.variants;
    if (!first || rest.length === 0) {
      return { status: "inconclusive", reason: "A metamorphic check needs at least two variants to compare." };
    }

    // 1. Reference.
    const reference = await send(first);
    context.emit("check.progress", { checkId: check.id, variant: first.name, role: "reference", status: reference.response.status });

    // 2. Prove the endpoint is deterministic before treating any difference as meaningful.
    for (let read = 0; read < check.calibration.stabilityReads; read++) {
      const control = await send(first);
      const drift = difference(relation, reference, control);
      if (drift) {
        return {
          status: "inconclusive",
          reason: `The endpoint is not deterministic: repeating variant "${first.name}" changed the response (${drift}). The "${relation}" relation cannot be evaluated; use "status-identical" or make the check narrower.`,
        };
      }
    }
    context.emit("oracle.calibrated", {
      checkId: check.id, oracle: "metamorphic-response",
      relation, referenceVariant: first.name, referenceStatus: reference.response.status,
      stabilityReads: check.calibration.stabilityReads, deterministic: true,
    });

    // 3. Compare every other variant against the reference.
    for (const variant of rest) {
      const sample = await send(variant);
      context.emit("check.progress", { checkId: check.id, variant: variant.name, role: "variant", status: sample.response.status });
      const differs = difference(relation, reference, sample);
      if (!differs) continue;

      const secretList = [...secrets];
      const witnessRequest = (item: Sample) => ({
        method: item.request.method,
        url: maskSecrets(item.request.url, secretList),
        headers: redactHeaders(item.request.headers, secretList),
      });
      const witnessResponse = (item: Sample) => ({
        status: item.response.status,
        headers: redactHeaders(item.response.headers, secretList),
        bodyDigest: item.bodyDigest,
        bodyPreview: maskSecrets(item.response.body.slice(0, 1000), secretList),
      });

      const finding: FindingDraft = {
        status: "confirmed",
        title: "Response Varies With a Parameter It Should Not Depend On",
        severity: "high",
        invariant: context.plan.invariants.find((candidate) => candidate.id === check.invariantId)?.statement ?? check.invariantId,
        routeId: check.request.routeId,
        oracle: "Metamorphic Response",
        verdict: `Variant "${variant.name}" produced a different response from "${first.name}" (${differs}) for the same identity, so the response depends on a caller-supplied parameter.`,
        evidence: {
          requests: [witnessRequest(reference), witnessRequest(sample)],
          responses: [witnessResponse(reference), witnessResponse(sample)],
          notes: [
            `Declared relation: ${relation}.`,
            `The endpoint was stable across ${check.calibration.stabilityReads + 1} identical request(s) before the variants were compared, so the difference is attributable to the parameter change.`,
            `Both requests were made as ${check.identityId}; only the query parameters differed.`,
          ],
        },
        replay: { checkId: check.id },
        remediation: "Derive the scope of the response from the authenticated session rather than from a caller-supplied parameter, and ignore or reject parameters that attempt to widen it.",
      };
      return { status: "failed", finding, reason: `Variant "${variant.name}" differed from "${first.name}" (${differs})` };
    }

    return { status: "passed", reason: `All ${check.variants.length} variants satisfied the "${relation}" relation` };
  },
};
