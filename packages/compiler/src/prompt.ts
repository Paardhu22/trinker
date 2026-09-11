import type { CompilerContext } from "./context.js";

/**
 * Versioned compiler prompt.
 *
 * Bump this whenever the instructions or the requested schema change, so a plan's provenance can
 * be traced to the exact prompt that produced it. It is recorded on every compilation.
 */
export const COMPILER_PROMPT_VERSION = "2026-09-11.1";

/**
 * The JSON Schema we ask the model to fill in.
 *
 * Hand-written rather than generated from `PlanProposalSchema`, for two reasons. The SDK's Zod
 * helper requires Zod v4 and this project's security schemas are v3 — migrating them to satisfy a
 * prompt detail would be the tail wagging the dog. And this schema is a *request*, not a contract:
 * `PlanProposalSchema` re-validates whatever comes back, so the authority stays in one place. Keep
 * the two aligned, but never treat this one as the gate.
 */
export const PLAN_PROPOSAL_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    identities: {
      type: "array",
      description: "Identities the checks need. Credentials live in runtime config, never here.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "roles", "capabilities"],
        properties: {
          id: { type: "string", description: "identity_<lower_snake_case>" },
          credentialRef: { type: "string", description: "Key the operator will define in runtime config. Never a token." },
          roles: { type: "array", items: { type: "string" } },
          capabilities: { type: "array", items: { type: "string" } },
        },
      },
    },
    fixtures: {
      type: "array",
      description: "Test data references. Values are supplied by the operator at runtime.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "runtimeRef"],
        properties: {
          id: { type: "string", description: "fixture_<lower_snake_case>" },
          runtimeRef: { type: "string", description: "Key the operator will define under runtime fixtures." },
          resourceId: { type: "string" },
          ownerIdentityId: { type: "string" },
        },
      },
    },
    invariants: {
      type: "array",
      description: "The security property each check asserts, in plain language.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "statement", "routeIds"],
        properties: {
          id: { type: "string", description: "inv_<lower_snake_case>" },
          kind: { type: "string", enum: ["authorization", "state-mutation", "metamorphic-response"] },
          statement: { type: "string", description: "One sentence a reviewer can agree or disagree with." },
          routeIds: { type: "array", items: { type: "string" }, minItems: 1 },
          resourceId: { type: "string" },
        },
      },
    },
    checks: {
      type: "array",
      description: "Mechanically verifiable checks. Each must name an oracle listed as available.",
      items: {
        type: "object",
        required: ["id", "invariantId", "oracle", "request"],
        properties: {
          id: { type: "string", description: "chk_<lower_snake_case>" },
          invariantId: { type: "string" },
          enabled: { type: "boolean" },
          oracle: { type: "string", enum: ["differential-authorization", "state-mutation", "metamorphic-response"] },
          request: { $ref: "#/$defs/requestTemplate" },

          allowedIdentityIds: { type: "array", items: { type: "string" }, description: "differential-authorization: identities that MAY succeed." },
          deniedIdentityIds: { type: "array", items: { type: "string" }, description: "differential-authorization: identities that MUST NOT succeed." },

          readRequest: { $ref: "#/$defs/requestTemplate", description: "state-mutation: a safe request that reads the protected state back." },
          readIdentityId: { type: "string", description: "state-mutation: identity used to observe the state." },
          unauthorizedIdentityIds: { type: "array", items: { type: "string" }, description: "state-mutation: identities that MUST NOT be able to change it." },
          protectedPaths: { type: "array", items: { type: "string" }, description: "state-mutation: dotted paths into the read response, e.g. data.ownerId" },

          identityId: { type: "string", description: "metamorphic-response: the single identity every variant uses." },
          relation: { type: "string", enum: ["identical", "status-identical"], description: "metamorphic-response: what must hold between variants." },
          variants: {
            type: "array",
            minItems: 2,
            description: "metamorphic-response: same request, differing only in query parameters.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "queryBindings"],
              properties: {
                name: { type: "string" },
                queryBindings: { $ref: "#/$defs/bindingMap" },
              },
            },
          },
        },
      },
    },
    rationales: {
      type: "object",
      description: "check id -> why you proposed it, citing the route and what made it look risky.",
      additionalProperties: { type: "string" },
    },
    notes: {
      type: "array",
      description: "Anything a human reviewer should know, including what you deliberately did NOT propose.",
      items: { type: "string" },
    },
  },
  $defs: {
    binding: {
      type: "object",
      description: "Exactly one of: literal (a constant), fixtureRef+field (test data), runtimeRef (operator-supplied secret).",
      properties: {
        literal: { type: ["string", "number", "boolean"] },
        fixtureRef: { type: "string" },
        field: { type: "string" },
        runtimeRef: { type: "string" },
      },
    },
    bindingMap: { type: "object", additionalProperties: { $ref: "#/$defs/binding" } },
    requestTemplate: {
      type: "object",
      additionalProperties: false,
      required: ["routeId"],
      properties: {
        routeId: { type: "string", description: "Must be one of the discovered route ids." },
        pathBindings: { $ref: "#/$defs/bindingMap" },
        queryBindings: { $ref: "#/$defs/bindingMap" },
        headerBindings: { $ref: "#/$defs/bindingMap" },
        body: { type: "object", description: "Request body for a mutating check." },
      },
    },
  },
} as const;

/**
 * The system prompt.
 *
 * Its central instruction is that the model is writing a *test plan*, not a vulnerability report.
 * Trinker confirms findings mechanically; a model that asserts a vulnerability here is doing the
 * one job it is explicitly not allowed to do.
 */
export const COMPILER_SYSTEM_PROMPT = `You are Trinker's security-plan compiler.

Trinker is a DETERMINISTIC application security scanner. It confirms a vulnerability only when a
mechanical oracle observes specific evidence — byte-identical responses, an actual state change, a
declared relation broken. Your job is to decide WHAT SHOULD BE TESTED. It is not to decide what is
vulnerable.

## What you produce

A structured security test plan: identities, fixtures, invariants, and checks. Nothing else.

## Hard rules

1. NEVER claim a vulnerability exists. You have not sent a single request. You are proposing
   hypotheses for the deterministic runner to test. Write invariants as properties that SHOULD
   hold ("only the owner may read this order"), never as findings ("this endpoint is vulnerable").
2. NEVER invent an endpoint. Every routeId you reference must appear verbatim in the discovered
   surface you were given. A plan that tests a route that does not exist is worse than a small plan.
3. NEVER include a secret. No tokens, passwords, cookies, API keys, or session values — not even
   examples or placeholders that look real. Credentials are supplied by the operator at runtime and
   referenced by key: use "credentialRef" on an identity and "runtimeRef" in a binding. A proposal
   containing a credential-like value is rejected outright.
4. ONLY use an oracle listed as available. A check naming any other oracle is discarded, because
   nothing could execute it.
5. RESPECT the safety policy. Only propose a check whose route method is in the allowed methods
   list. Only propose a mutating check (POST/PUT/PATCH/DELETE) if the mutation policy permits it.
6. BE CONSERVATIVE. Propose a check only where the surface gives you real reason to. A route with
   no object identifier and no per-user data does not need an authorization check. Fewer, well
   justified checks beat broad coverage — every false check costs a human a review and may waste a
   scan. If you are unsure, say so in notes rather than guessing in a check.

## What makes a high-value check

Prefer, in roughly this order:

- Object-level authorization on a route that takes a resource identifier (/orders/:id, /users/:id).
  Two identities, one allowed and one denied, against a fixture the allowed identity owns.
- Unauthorized state mutation on a write route, paired with a safe read route that exposes the
  field that must not change.
- Client-controlled data scoping: a list route taking a filter parameter (userId, accountId,
  tenantId) where the response should depend on the session, not the parameter. Two variants
  differing only in that parameter, relation "identical".

Skip health checks, static asset routes, login endpoints, and anything with no per-user state.

## The oracles

**differential-authorization** — issues the same request as an allowed identity and a denied
identity. Confirms ONLY if the denied identity gets a byte-identical successful response. Use for
broken object level authorization.

**state-mutation** — reads protected state, proves it is stable, attempts the write as an
unauthorized identity, reads again. Confirms ONLY if a protectedPath value actually changed. Needs
a "readRequest" on a safe route and "protectedPaths" as dotted paths into that response.

**metamorphic-response** — sends two or more variants as the SAME identity, differing only in query
parameters, and requires the declared relation to hold. Use "identical" when the parameter should
have no effect at all. Confirms ONLY if a variant breaks the relation.

## Identifiers and wiring

- ids are lower_snake_case with the required prefix: identity_, fixture_, inv_, chk_.
- Every check must reference an invariant you also propose, and identities and fixtures you also
  propose (or that already exist in the plan).
- Do not redefine anything that already exists in the plan — it has already been reviewed by a
  human. Propose only additions.
- Bindings: {"literal": "..."} for a constant, {"fixtureRef": "fixture_x", "field": "id"} for test
  data, {"runtimeRef": "key"} for an operator-supplied value. Fixture ids you invent must also
  appear in your fixtures list, and the operator will fill in their values.

## Rationale

For every check, add an entry to "rationales" keyed by the check id, explaining in one or two
sentences why this route looked worth testing and what evidence in the surface led you there. A
reviewer who disagrees with your reasoning must be able to see it and reject the check.`;

const MAX_EXCERPT_CHARS = 1200;

/** The user message: the application's surface, and nothing the model does not need. */
export function buildUserPrompt(context: CompilerContext): string {
  const sections: string[] = [];

  sections.push(
    "# Application surface",
    "",
    `Application: ${context.applicationId}`,
    `Frameworks: ${context.frameworks.join(", ")}`,
    "",
    "## Routes",
    "",
    "| routeId | method | path | parameters | confidence |",
    "| --- | --- | --- | --- | --- |",
    ...context.routes.map((route) =>
      `| \`${route.id}\` | ${route.method} | \`${route.pathTemplate}\` | ${route.parameters.map((p) => p.name).join(", ") || "-"} | ${route.confidence} |`),
    "",
  );

  if (context.resources.length > 0) {
    sections.push(
      "## Resources inferred from shared path parameters",
      "",
      ...context.resources.map((resource) => `- \`${resource.id}\` (${resource.name}) on ${resource.routeIds.length} route(s)`),
      "",
    );
  }

  if (context.sourceExcerpts.length > 0) {
    sections.push("## Source excerpts", "", "Only the lines where each route is declared.", "");
    for (const excerpt of context.sourceExcerpts) {
      sections.push(`\`\`\`ts title=${excerpt.file}:${excerpt.line}`, excerpt.text.slice(0, MAX_EXCERPT_CHARS), "```", "");
    }
  }

  sections.push(
    "# Constraints",
    "",
    `Available oracles: ${context.availableOracles.join(", ")}`,
    `Allowed HTTP methods: ${context.allowedMethods.join(", ")}`,
    `Mutation policy: ${context.mutationPolicy}${context.mutationPolicy === "forbid" ? " (do NOT propose any mutating check)" : ""}`,
    "",
  );

  sections.push("# Already in the plan", "", describeExisting(context), "");

  sections.push(
    "# Your task",
    "",
    "Propose additional identities, fixtures, invariants, and checks for this application, following",
    "every rule in your instructions. Return only the structured proposal.",
  );

  return sections.join("\n");
}

function describeExisting(context: CompilerContext): string {
  const { existing } = context;
  const total = existing.identities.length + existing.fixtures.length + existing.invariants.length + existing.checks.length;
  if (total === 0) return "Nothing — this is the first pass. Every identity and fixture a check needs must be proposed too.";
  return [
    `Identities: ${existing.identities.map((item) => item.id).join(", ") || "none"}`,
    `Fixtures: ${existing.fixtures.map((item) => item.id).join(", ") || "none"}`,
    `Invariants: ${existing.invariants.map((item) => `${item.id} (${item.statement})`).join("; ") || "none"}`,
    `Checks: ${existing.checks.map((item) => `${item.id} [${item.oracle}] on ${item.request.routeId}`).join("; ") || "none"}`,
    "",
    "Do not redefine any of these. Propose only what is missing.",
  ].join("\n");
}
