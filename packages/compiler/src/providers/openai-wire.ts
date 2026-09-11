/**
 * OpenAI's strict Structured Outputs wire format.
 *
 * Strict mode is a narrow JSON Schema subset: no `anyOf`/`oneOf`, no `minItems`/`pattern`, every
 * property must appear in `required`, and `additionalProperties` must be `false` everywhere. Two
 * consequences shape everything below.
 *
 * Optional fields become nullable (`["string", "null"]`) and are stripped on the way back, because
 * `PlanProposalSchema` is `.strict()` and would reject an explicit `null` where it expects an
 * absent key.
 *
 * Arbitrary-key maps cannot be expressed at all, so binding maps and the rationale map travel as
 * arrays of entries and are rebuilt here.
 *
 * This is a *wire encoding*, not a second contract. Nothing below validates anything: the output is
 * handed to `PlanProposalSchema` and then `applyProposal`, exactly as the Anthropic provider's is.
 * Normalisation only removes nulls and reshapes containers — it can never add or alter content.
 */

/** Bumped independently of the shared prompt, since only the encoding lives here. */
export const OPENAI_WIRE_VERSION = "openai-wire.1";

const nullableString = { type: ["string", "null"] } as const;
const stringArray = { type: "array", items: { type: "string" } } as const;
const nullableStringArray = { type: ["array", "null"], items: { type: "string" } } as const;

/** One binding, flattened: exactly one of the three forms survives once nulls are stripped. */
const bindingEntry = {
  type: "object",
  additionalProperties: false,
  required: ["name", "literal", "fixtureRef", "field", "runtimeRef"],
  properties: {
    name: { type: "string", description: "Parameter name this binding fills." },
    literal: { ...nullableString, description: "A constant value. Use for a fixed parameter." },
    fixtureRef: { ...nullableString, description: "Id of a fixture you also propose." },
    field: { ...nullableString, description: "Field within that fixture, e.g. id." },
    runtimeRef: { ...nullableString, description: "Key the operator supplies at runtime. Never a secret value." },
  },
} as const;

const bindingArray = { type: "array", items: bindingEntry } as const;

const requestTemplate = {
  type: "object",
  additionalProperties: false,
  required: ["routeId", "pathBindings", "queryBindings", "headerBindings", "bodyJson"],
  properties: {
    routeId: { type: "string", description: "Must be one of the discovered route ids, verbatim." },
    pathBindings: bindingArray,
    queryBindings: bindingArray,
    headerBindings: bindingArray,
    bodyJson: { ...nullableString, description: "Request body as a JSON string, for a mutating check. Null otherwise." },
  },
} as const;

const nullableRequestTemplate = { ...requestTemplate, type: ["object", "null"] } as const;

/** The schema sent as `text.format.schema` with `strict: true`. */
export const OPENAI_PLAN_PROPOSAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["identities", "fixtures", "invariants", "checks", "rationales", "notes"],
  properties: {
    identities: {
      type: "array",
      description: "Identities the checks need. Credentials live in runtime config, never here.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "credentialRef", "roles", "capabilities"],
        properties: {
          id: { type: "string", description: "identity_<lower_snake_case>" },
          credentialRef: { ...nullableString, description: "Key the operator will define in runtime config. Never a token." },
          roles: stringArray,
          capabilities: stringArray,
        },
      },
    },
    fixtures: {
      type: "array",
      description: "Test data references. Values are supplied by the operator at runtime.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "runtimeRef", "resourceId", "ownerIdentityId"],
        properties: {
          id: { type: "string", description: "fixture_<lower_snake_case>" },
          runtimeRef: { type: "string", description: "Key the operator will define under runtime fixtures." },
          resourceId: nullableString,
          ownerIdentityId: nullableString,
        },
      },
    },
    invariants: {
      type: "array",
      description: "The security property each check asserts, in plain language.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "statement", "routeIds", "resourceId"],
        properties: {
          id: { type: "string", description: "inv_<lower_snake_case>" },
          kind: { type: "string", enum: ["authorization", "state-mutation", "metamorphic-response"] },
          statement: { type: "string", description: "One sentence a reviewer can agree or disagree with." },
          routeIds: stringArray,
          resourceId: nullableString,
        },
      },
    },
    checks: {
      type: "array",
      description: "Mechanically verifiable checks. Fill only the fields their oracle needs; null the rest.",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id", "invariantId", "oracle", "request",
          "allowedIdentityIds", "deniedIdentityIds", "calibrationTrials",
          "readRequest", "readIdentityId", "unauthorizedIdentityIds", "protectedPaths", "stabilityReads",
          "identityId", "relation", "variants",
        ],
        properties: {
          id: { type: "string", description: "chk_<lower_snake_case>" },
          invariantId: { type: "string", description: "Id of an invariant you also propose." },
          oracle: { type: "string", enum: ["differential-authorization", "state-mutation", "metamorphic-response"] },
          request: requestTemplate,

          allowedIdentityIds: { ...nullableStringArray, description: "differential-authorization: identities that MAY succeed." },
          deniedIdentityIds: { ...nullableStringArray, description: "differential-authorization: identities that MUST NOT succeed." },
          calibrationTrials: { type: ["integer", "null"], description: "differential-authorization: denial samples per identity, 1-5. Default 3." },

          readRequest: { ...nullableRequestTemplate, description: "state-mutation: a SAFE request that reads the protected state back." },
          readIdentityId: { ...nullableString, description: "state-mutation: identity used to observe the state." },
          unauthorizedIdentityIds: { ...nullableStringArray, description: "state-mutation: identities that MUST NOT be able to change it." },
          protectedPaths: { ...nullableStringArray, description: "state-mutation: dotted paths into the read response, e.g. data.ownerId" },
          stabilityReads: { type: ["integer", "null"], description: "state-mutation / metamorphic: control reads, 1-5. Default 1." },

          identityId: { ...nullableString, description: "metamorphic-response: the single identity every variant uses." },
          relation: { ...nullableString, description: "metamorphic-response: 'identical' or 'status-identical'." },
          variants: {
            type: ["array", "null"],
            description: "metamorphic-response: two or more variants differing ONLY in query parameters.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "queryBindings"],
              properties: { name: { type: "string" }, queryBindings: bindingArray },
            },
          },
        },
      },
    },
    rationales: {
      type: "array",
      description: "Why each check was proposed. One entry per check.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["checkId", "rationale"],
        properties: {
          checkId: { type: "string" },
          rationale: { type: "string", description: "Cite the route and what made it look worth testing." },
        },
      },
    },
    notes: { ...stringArray, description: "Anything a reviewer should know, including what you deliberately did NOT propose." },
  },
} as const;

/** Tells the model how this encoding differs from the plain shape described in the system prompt. */
export const OPENAI_WIRE_INSTRUCTIONS = `
# Response encoding

Your response must match the provided JSON schema exactly. Because that schema cannot express
optional fields or free-form maps, note these encoding rules:

- Every field must be present. Set fields that do not apply to null (or [] for a list you are not
  using). Fill only the fields the chosen oracle needs.
- Binding maps are ARRAYS of entries: instead of {"id": {"fixtureRef": "fixture_order", "field": "id"}},
  write [{"name": "id", "fixtureRef": "fixture_order", "field": "id", "literal": null, "runtimeRef": null}].
  Exactly one of literal / fixtureRef+field / runtimeRef must be non-null in each entry.
- A request body is a JSON STRING in "bodyJson", or null.
- "rationales" is an ARRAY of {checkId, rationale}, one per check you propose.

Per oracle, the fields that must be non-null:
- differential-authorization: allowedIdentityIds, deniedIdentityIds (calibrationTrials optional)
- state-mutation: readRequest, readIdentityId, unauthorizedIdentityIds, protectedPaths
- metamorphic-response: identityId, relation, variants
`.trim();

/* ------------------------------------------------------------------ normalisation */

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Drop keys whose value is null or undefined. Removal only — it can never introduce content. */
function dropNulls(value: Json): Json {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined));
}

/** Rebuild a binding map from the array encoding. */
function bindingsFrom(entries: unknown): Json {
  const out: Json = {};
  for (const entry of asArray(entries)) {
    if (!isObject(entry)) continue;
    const name = entry["name"];
    if (typeof name !== "string" || name === "") continue;
    const binding = dropNulls({
      literal: entry["literal"],
      fixtureRef: entry["fixtureRef"],
      field: entry["field"],
      runtimeRef: entry["runtimeRef"],
    });
    // Leave a malformed binding as-is rather than repairing it: Zod should reject it loudly.
    out[name] = binding;
  }
  return out;
}

function requestFrom(value: unknown): Json | undefined {
  if (!isObject(value)) return undefined;
  const template: Json = {
    routeId: value["routeId"],
    pathBindings: bindingsFrom(value["pathBindings"]),
    queryBindings: bindingsFrom(value["queryBindings"]),
    headerBindings: bindingsFrom(value["headerBindings"]),
  };
  const bodyJson = value["bodyJson"];
  if (typeof bodyJson === "string" && bodyJson.trim() !== "") {
    // A body that is not valid JSON is passed through as the raw string; `body` is unknown in the
    // plan schema, so the decision about it belongs downstream, not here.
    try { template["body"] = JSON.parse(bodyJson); } catch { template["body"] = bodyJson; }
  }
  return template;
}

function checkFrom(value: unknown): Json | undefined {
  if (!isObject(value)) return undefined;
  const oracle = value["oracle"];
  const base: Json = {
    id: value["id"],
    invariantId: value["invariantId"],
    enabled: true,
    oracle,
    request: requestFrom(value["request"]),
  };

  if (oracle === "differential-authorization") {
    return dropNulls({
      ...base,
      allowedIdentityIds: value["allowedIdentityIds"],
      deniedIdentityIds: value["deniedIdentityIds"],
      calibration: typeof value["calibrationTrials"] === "number" ? { trials: value["calibrationTrials"] } : undefined,
    });
  }
  if (oracle === "state-mutation") {
    return dropNulls({
      ...base,
      readRequest: requestFrom(value["readRequest"]),
      readIdentityId: value["readIdentityId"],
      unauthorizedIdentityIds: value["unauthorizedIdentityIds"],
      protectedPaths: value["protectedPaths"],
      calibration: typeof value["stabilityReads"] === "number" ? { stabilityReads: value["stabilityReads"] } : undefined,
    });
  }
  if (oracle === "metamorphic-response") {
    return dropNulls({
      ...base,
      identityId: value["identityId"],
      relation: value["relation"],
      variants: asArray(value["variants"]).map((variant) =>
        isObject(variant) ? { name: variant["name"], queryBindings: bindingsFrom(variant["queryBindings"]) } : variant),
      calibration: typeof value["stabilityReads"] === "number" ? { stabilityReads: value["stabilityReads"] } : undefined,
    });
  }
  // An unknown oracle is left intact so the deterministic layer rejects it by name.
  return dropNulls(base);
}

/**
 * Turn an OpenAI wire proposal into the canonical `PlanProposal` shape.
 *
 * Deliberately forgiving about structure and completely uninterested in meaning: anything it cannot
 * recognise is passed through unchanged so `PlanProposalSchema` rejects it, rather than being
 * quietly repaired into something that validates.
 */
export function normaliseOpenAiProposal(raw: unknown): unknown {
  if (!isObject(raw)) return raw;
  return {
    identities: asArray(raw["identities"]).map((item) => (isObject(item) ? dropNulls(item) : item)),
    fixtures: asArray(raw["fixtures"]).map((item) => (isObject(item) ? dropNulls(item) : item)),
    invariants: asArray(raw["invariants"]).map((item) =>
      isObject(item) ? { ...dropNulls(item), provenance: "llm-assisted" } : item),
    checks: asArray(raw["checks"]).map(checkFrom),
    rationales: Object.fromEntries(
      asArray(raw["rationales"])
        .filter(isObject)
        .filter((entry) => typeof entry["checkId"] === "string" && typeof entry["rationale"] === "string")
        .map((entry) => [entry["checkId"] as string, entry["rationale"] as string]),
    ),
    notes: asArray(raw["notes"]).filter((note): note is string => typeof note === "string"),
  };
}
