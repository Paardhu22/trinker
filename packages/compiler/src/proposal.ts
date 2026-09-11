import { z } from "zod";
import { CheckSchema, PlanSchema, type Check, type Plan } from "@trinker/core";

/**
 * What a compiler may propose.
 *
 * A proposal is structured plan content, never prose. It reuses the real `CheckSchema`, so a
 * proposed check that would not be a legal check is rejected before any further reasoning about it.
 */
export const ProposedIdentitySchema = z.object({
  id: z.string().regex(/^identity_[a-z0-9_]+$/),
  credentialRef: z.string().optional(),
  roles: z.array(z.string()).default([]),
  capabilities: z.array(z.string()).default([]),
}).strict();

export const ProposedFixtureSchema = z.object({
  id: z.string().regex(/^fixture_[a-z0-9_]+$/),
  runtimeRef: z.string().min(1),
  resourceId: z.string().optional(),
  ownerIdentityId: z.string().optional(),
}).strict();

export const ProposedInvariantSchema = z.object({
  id: z.string().regex(/^inv_[a-z0-9_]+$/),
  kind: z.enum(["authorization", "state-mutation", "metamorphic-response", "browser-execution", "out-of-band"]),
  statement: z.string().min(1).max(1000),
  routeIds: z.array(z.string()).min(1),
  resourceId: z.string().optional(),
  /** Forced at merge time; a proposal cannot claim its output was hand-written. */
  provenance: z.literal("llm-assisted").default("llm-assisted"),
}).strict();

export const PlanProposalSchema = z.object({
  identities: z.array(ProposedIdentitySchema).default([]),
  fixtures: z.array(ProposedFixtureSchema).default([]),
  invariants: z.array(ProposedInvariantSchema).default([]),
  checks: z.array(CheckSchema).default([]),
  /** Free text for the human reviewer only. Never interpreted. */
  notes: z.array(z.string().max(1000)).default([]),
}).strict();
export type PlanProposal = z.infer<typeof PlanProposalSchema>;

export interface RejectedItem {
  kind: "identity" | "fixture" | "invariant" | "check";
  id: string;
  reason: string;
}

export interface ApplyProposalResult {
  plan: Plan;
  added: { identities: string[]; fixtures: string[]; invariants: string[]; checks: string[] };
  rejected: RejectedItem[];
  notes: string[];
}

export interface ApplyProposalOptions {
  /** Oracles with a real implementation. A check naming anything else is rejected, not merged. */
  availableOracles: readonly string[];
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Merge a proposal into a plan, deterministically.
 *
 * Everything a model emits passes through here, and every rule below is enforced by code rather
 * than by prompt. A proposal can only ever *add* content: it cannot alter the safety policy, touch
 * an existing item, introduce a credential, or reference something that does not exist. The merged
 * plan is then re-validated by `PlanSchema`, so an LLM-assisted plan is held to exactly the same
 * contract as a hand-written one.
 *
 * Invalid items are reported with a reason rather than throwing, so one bad check does not discard
 * an otherwise useful proposal — but nothing invalid is ever merged.
 */
export function applyProposal(plan: Plan, rawProposal: unknown, options: ApplyProposalOptions): ApplyProposalResult {
  const parsed = PlanProposalSchema.safeParse(rawProposal);
  if (!parsed.success) {
    const detail = parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
    throw new Error(`Compiler proposal is not a valid plan proposal: ${detail}`);
  }
  const proposal = parsed.data;
  const rejected: RejectedItem[] = [];

  const routeIds = new Set(plan.surface.routes.map((route) => route.id));
  const methodByRoute = new Map(plan.surface.routes.map((route) => [route.id, route.method]));
  const resourceIds = new Set(plan.surface.resources.map((resource) => resource.id));
  const allowedMethods = new Set(plan.safety.allowedMethods);

  const existingIdentityIds = new Set(plan.identities.map((identity) => identity.id));
  const existingFixtureIds = new Set(plan.fixtures.map((fixture) => fixture.id));
  const existingInvariantIds = new Set(plan.invariants.map((invariant) => invariant.id));
  const existingCheckIds = new Set(plan.checks.map((check) => check.id));

  const reject = (kind: RejectedItem["kind"], id: string, reason: string): undefined => {
    rejected.push({ kind, id, reason });
    return undefined;
  };

  // Identities: additive only. A proposal may not redefine an identity a human already reviewed.
  const identities = proposal.identities.filter((identity) =>
    existingIdentityIds.has(identity.id)
      ? reject("identity", identity.id, "An identity with this id already exists; a proposal may not redefine it") !== undefined
      : true);
  for (const identity of identities) existingIdentityIds.add(identity.id);

  const fixtures = proposal.fixtures.filter((fixture) => {
    if (existingFixtureIds.has(fixture.id)) return reject("fixture", fixture.id, "A fixture with this id already exists") !== undefined;
    if (fixture.resourceId !== undefined && !resourceIds.has(fixture.resourceId)) {
      return reject("fixture", fixture.id, `Unknown resource ${fixture.resourceId}`) !== undefined;
    }
    if (fixture.ownerIdentityId !== undefined && !existingIdentityIds.has(fixture.ownerIdentityId)) {
      return reject("fixture", fixture.id, `Unknown identity ${fixture.ownerIdentityId}`) !== undefined;
    }
    return true;
  });
  for (const fixture of fixtures) existingFixtureIds.add(fixture.id);

  const invariants = proposal.invariants.filter((invariant) => {
    if (existingInvariantIds.has(invariant.id)) return reject("invariant", invariant.id, "An invariant with this id already exists") !== undefined;
    const unknown = invariant.routeIds.filter((routeId) => !routeIds.has(routeId));
    if (unknown.length > 0) return reject("invariant", invariant.id, `Unknown route(s): ${unknown.join(", ")}`) !== undefined;
    return true;
  // Provenance is stamped by us, never taken from the proposal.
  }).map((invariant) => ({ ...invariant, provenance: "llm-assisted" as const }));
  for (const invariant of invariants) existingInvariantIds.add(invariant.id);

  const checks = proposal.checks.filter((check) => {
    if (existingCheckIds.has(check.id)) return reject("check", check.id, "A check with this id already exists") !== undefined;
    if (!options.availableOracles.includes(check.oracle)) {
      return reject("check", check.id, `Oracle "${check.oracle}" has no implementation, so this check could not run`) !== undefined;
    }
    if (!existingInvariantIds.has(check.invariantId)) {
      return reject("check", check.id, `Unknown invariant ${check.invariantId}`) !== undefined;
    }
    for (const [label, routeId] of referencedRoutes(check)) {
      if (!routeIds.has(routeId)) return reject("check", check.id, `Unknown route ${routeId} in ${label}`) !== undefined;
      const method = methodByRoute.get(routeId)!;
      // A proposal cannot widen the safety policy. Writes stay a human decision.
      if (!allowedMethods.has(method)) {
        return reject("check", check.id, `Method ${method} is not permitted by this plan's safety policy`) !== undefined;
      }
      if (!SAFE_METHODS.has(method) && plan.safety.mutationPolicy === "forbid") {
        return reject("check", check.id, `Check would mutate state while mutationPolicy is "forbid"`) !== undefined;
      }
    }
    for (const identityId of referencedIdentities(check)) {
      if (!existingIdentityIds.has(identityId)) return reject("check", check.id, `Unknown identity ${identityId}`) !== undefined;
    }
    for (const fixtureId of referencedFixtures(check)) {
      if (!existingFixtureIds.has(fixtureId)) return reject("check", check.id, `Unknown fixture ${fixtureId}`) !== undefined;
    }
    return true;
  });
  for (const check of checks) existingCheckIds.add(check.id);

  const merged = {
    ...plan,
    identities: [...plan.identities, ...identities],
    fixtures: [...plan.fixtures, ...fixtures],
    invariants: [...plan.invariants, ...invariants],
    checks: [...plan.checks, ...checks],
    provenance: {
      ...plan.provenance,
      compiler: { ...plan.provenance.compiler, mode: "llm-assisted" as const },
    },
  };

  // The final gate. An llm-assisted plan must satisfy exactly the same contract as a hand-written
  // one, including the rejection of inline credentials.
  const validated = PlanSchema.safeParse(merged);
  if (!validated.success) {
    const detail = validated.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
    throw new Error(`Merged plan failed validation, so nothing was applied: ${detail}`);
  }

  return {
    plan: validated.data,
    added: {
      identities: identities.map((item) => item.id),
      fixtures: fixtures.map((item) => item.id),
      invariants: invariants.map((item) => item.id),
      checks: checks.map((item) => item.id),
    },
    rejected,
    notes: proposal.notes,
  };
}

function referencedRoutes(check: Check): Array<[string, string]> {
  const routes: Array<[string, string]> = [["request", check.request.routeId]];
  if (check.oracle === "state-mutation") routes.push(["readRequest", check.readRequest.routeId]);
  return routes;
}

function referencedIdentities(check: Check): string[] {
  if (check.oracle === "differential-authorization") return [...check.allowedIdentityIds, ...check.deniedIdentityIds];
  if (check.oracle === "state-mutation") return [check.readIdentityId, ...check.unauthorizedIdentityIds];
  if (check.oracle === "metamorphic-response") return [check.identityId];
  return [];
}

function referencedFixtures(check: Check): string[] {
  const templates = [check.request, ...(check.oracle === "state-mutation" ? [check.readRequest] : [])];
  const ids: string[] = [];
  for (const template of templates) {
    for (const bindings of [template.pathBindings, template.queryBindings, template.headerBindings]) {
      for (const binding of Object.values(bindings)) if ("fixtureRef" in binding) ids.push(binding.fixtureRef);
    }
  }
  if (check.oracle === "metamorphic-response") {
    for (const variant of check.variants) {
      for (const binding of Object.values(variant.queryBindings)) if ("fixtureRef" in binding) ids.push(binding.fixtureRef);
    }
  }
  return ids;
}
