import { createHash } from "node:crypto";
import {
  buildRequest, maskSecrets, redactHeaders,
  type BuiltRequest, type FindingDraft, type HttpResponse, type Oracle, type OracleContext,
} from "@trinker/core";

const hash = (value: string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;

/** Resolve a dotted path (`owner.id`, `items.0.price`) against a parsed JSON body. */
export function readPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      return Number.isInteger(index) ? current[index] : undefined;
    }
    if (typeof current === "object") return (current as Record<string, unknown>)[segment];
    return undefined;
  }, value);
}

/**
 * Stable, comparable representation of a protected value.
 *
 * `JSON.stringify` never yields a bare `absent` token, so an absent path stays distinguishable
 * from a present one holding null or the string "absent".
 */
const ABSENT = "absent";
const snapshotValue = (value: unknown): string => (value === undefined ? ABSENT : JSON.stringify(value) ?? ABSENT);

interface Snapshot { response: HttpResponse; values: Map<string, string> }

function snapshot(response: HttpResponse, protectedPaths: readonly string[]): Snapshot {
  let parsed: unknown;
  try { parsed = JSON.parse(response.body); } catch { parsed = undefined; }
  return { response, values: new Map(protectedPaths.map((path) => [path, snapshotValue(readPath(parsed, path))])) };
}

const changedPaths = (before: Snapshot, after: Snapshot): string[] =>
  [...before.values.entries()].filter(([path, value]) => after.values.get(path) !== value).map(([path]) => path);

const isSuccess = (response: HttpResponse): boolean => response.status >= 200 && response.status < 300;

/**
 * Confirms that an unauthorized identity was able to change protected application state.
 *
 * Evidence is the state itself, not the mutation's status code: a server that answers 200 and
 * ignores the request has not been exploited. Before attributing any change, the oracle proves the
 * protected values are stable across control reads, so background churn (a timestamp, a counter)
 * cannot be mistaken for an unauthorized write.
 */
export const stateMutationOracle: Oracle = {
  name: "state-mutation",
  async execute(context: OracleContext) {
    if (context.check.oracle !== "state-mutation") {
      throw new Error(`state-mutation oracle received a "${context.check.oracle}" check`);
    }
    const check = context.check;
    context.emit("phase.started", { phase: "state-mutation", checkId: check.id });

    const secrets = new Set<string>();
    const track = (request: BuiltRequest): BuiltRequest => {
      for (const secret of request.sensitiveValues) secrets.add(secret);
      return request;
    };
    const readOnce = async (): Promise<Snapshot> => {
      const request = track(buildRequest({ plan: context.plan, runtime: context.runtime, template: check.readRequest, identityId: check.readIdentityId }));
      const response = await context.http.request(request);
      return snapshot(response, check.protectedPaths);
    };

    // 1. Baseline.
    const baseline = await readOnce();
    if (!isSuccess(baseline.response)) {
      return { status: "inconclusive", reason: `The protected state could not be read as ${check.readIdentityId} (status ${baseline.response.status}), so no change could be attributed.` };
    }
    if ([...baseline.values.values()].every((value) => value === ABSENT)) {
      return { status: "inconclusive", reason: `None of the protected paths (${check.protectedPaths.join(", ")}) exist in the read response, so a change could not be detected.` };
    }

    // 2. Prove the state is stable before blaming anything on the mutation.
    let control = baseline;
    for (let read = 0; read < check.calibration.stabilityReads; read++) {
      control = await readOnce();
      const drifted = changedPaths(baseline, control);
      if (drifted.length > 0) {
        return { status: "inconclusive", reason: `Protected state changed between control reads without any mutation (${drifted.join(", ")}). It is not stable enough to attribute a change to an unauthorized write.` };
      }
    }
    context.emit("oracle.calibrated", {
      checkId: check.id, oracle: "state-mutation",
      protectedPaths: check.protectedPaths, stabilityReads: check.calibration.stabilityReads, stable: true,
      observedPaths: [...baseline.values.keys()].filter((path) => baseline.values.get(path) !== ABSENT),
    });

    // 3. Attempt the mutation as each identity that must not be able to perform it.
    for (const identityId of check.unauthorizedIdentityIds) {
      const mutation = track(buildRequest({ plan: context.plan, runtime: context.runtime, template: check.request, identityId }));
      const mutationResponse = await context.http.request(mutation);
      context.emit("check.progress", { checkId: check.id, identityId, role: "unauthorized", status: mutationResponse.status });

      const after = await readOnce();
      if (!isSuccess(after.response)) {
        return { status: "inconclusive", reason: `The protected state could not be re-read after the mutation attempt (status ${after.response.status}).` };
      }
      const changed = changedPaths(control, after);
      if (changed.length === 0) continue;

      const secretList = [...secrets];
      const witness = (response: HttpResponse) => ({
        status: response.status,
        headers: redactHeaders(response.headers, secretList),
        bodyDigest: hash(response.body),
        bodyPreview: maskSecrets(response.body.slice(0, 1000), secretList),
      });

      const finding: FindingDraft = {
        status: "confirmed",
        title: "Unauthorized State Mutation",
        severity: "high",
        invariant: context.plan.invariants.find((candidate) => candidate.id === check.invariantId)?.statement ?? check.invariantId,
        routeId: check.request.routeId,
        oracle: "State Mutation",
        verdict: `${identityId} changed protected state at ${changed.join(", ")} despite not being authorized to do so.`,
        evidence: {
          requests: [{
            method: mutation.method,
            url: maskSecrets(mutation.url, secretList),
            headers: redactHeaders(mutation.headers, secretList),
            ...(mutation.body !== undefined ? { body: mutation.body } : {}),
          }],
          responses: [witness(mutationResponse), witness(control.response), witness(after.response)],
          notes: [
            `Protected state was stable across ${check.calibration.stabilityReads + 1} read(s) before the mutation.`,
            ...changed.map((path) => `${path}: ${control.values.get(path)} -> ${after.values.get(path)}`),
            `The mutation request answered ${mutationResponse.status}; the finding rests on the observed state change, not on that status.`,
            "This check wrote to live state and did not restore it. Replaying it may report 'did not reproduce' simply because the state is already changed; the evidence above is the authoritative record.",
          ],
        },
        replay: { checkId: check.id },
        remediation: "Authorize the caller against the target resource before applying the write, and reject the request when the caller does not own it.",
      };
      return { status: "failed", finding, reason: `${identityId} changed protected state (${changed.join(", ")})` };
    }

    return { status: "passed", reason: `No unauthorized identity changed the protected state (${check.protectedPaths.join(", ")})` };
  },
};
