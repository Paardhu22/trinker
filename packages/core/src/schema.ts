import { z } from "zod";

export const HttpMethodSchema = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
export type HttpMethod = z.infer<typeof HttpMethodSchema>;

export const SourceReferenceSchema = z.object({
  kind: z.enum(["ast", "openapi", "manual", "crawler", "compiler"]),
  path: z.string().optional(),
  line: z.number().int().positive().optional(),
  note: z.string().max(500).optional(),
}).strict();

export const ParameterSchema = z.object({
  name: z.string().min(1),
  location: z.enum(["path", "query", "header", "body"]),
  required: z.boolean(),
}).strict();

export const RouteSchema = z.object({
  id: z.string().regex(/^route_[a-z0-9_]+$/),
  method: HttpMethodSchema,
  pathTemplate: z.string().startsWith("/"),
  operationId: z.string().optional(),
  parameters: z.array(ParameterSchema).default([]),
  sourceRefs: z.array(SourceReferenceSchema).default([]),
  confidence: z.enum(["high", "medium", "low"]),
}).strict();
export type Route = z.infer<typeof RouteSchema>;

export const ResourceSchema = z.object({
  id: z.string().regex(/^resource_[a-z0-9_]+$/),
  name: z.string().min(1),
  routeParameter: z.string().optional(),
  routeIds: z.array(z.string()).default([]),
  sourceRefs: z.array(SourceReferenceSchema).default([]),
}).strict();
export type Resource = z.infer<typeof ResourceSchema>;

export const ValueBindingSchema = z.union([
  z.object({ fixtureRef: z.string(), field: z.string().min(1) }).strict(),
  z.object({ runtimeRef: z.string() }).strict(),
  z.object({ literal: z.union([z.string(), z.number(), z.boolean()]) }).strict(),
]);
export type ValueBinding = z.infer<typeof ValueBindingSchema>;

export const RequestTemplateSchema = z.object({
  routeId: z.string(),
  pathBindings: z.record(ValueBindingSchema).default({}),
  queryBindings: z.record(ValueBindingSchema).default({}),
  headerBindings: z.record(ValueBindingSchema).default({}),
  body: z.unknown().optional(),
}).strict();
export type RequestTemplate = z.infer<typeof RequestTemplateSchema>;

export const InvariantSchema = z.object({
  id: z.string().regex(/^inv_[a-z0-9_]+$/),
  kind: z.enum(["authorization", "state-mutation", "metamorphic-response", "browser-execution", "out-of-band"]),
  statement: z.string().min(1).max(1000),
  routeIds: z.array(z.string()).min(1),
  resourceId: z.string().optional(),
  provenance: z.enum(["manual", "deterministic", "llm-assisted"]),
}).strict();

const CheckBaseSchema = z.object({
  id: z.string().regex(/^chk_[a-z0-9_]+$/),
  invariantId: z.string(),
  enabled: z.boolean().default(true),
  request: RequestTemplateSchema,
}).strict();

export const DifferentialAuthorizationCheckSchema = CheckBaseSchema.extend({
  oracle: z.literal("differential-authorization"),
  allowedIdentityIds: z.array(z.string()).min(1),
  deniedIdentityIds: z.array(z.string()).min(1),
  calibration: z.object({ trials: z.number().int().min(1).max(5).default(3) }).strict().default({ trials: 3 }),
}).strict();

export const StateMutationCheckSchema = CheckBaseSchema.extend({
  oracle: z.literal("state-mutation"),
  /** Identity used to observe the protected state. Normally the legitimate owner. */
  readIdentityId: z.string(),
  /** Identities that must NOT be able to change the protected state. */
  unauthorizedIdentityIds: z.array(z.string()).min(1),
  /** How to read the state back. Must be a safe method; it runs before and after the mutation. */
  readRequest: RequestTemplateSchema,
  /** Dotted paths into the read response whose values must not change, e.g. "owner.id", "items.0.price". */
  protectedPaths: z.array(z.string().min(1)).min(1),
  /** Control reads used to prove the protected state is stable before attributing any change. */
  calibration: z.object({ stabilityReads: z.number().int().min(1).max(5).default(1) }).strict().default({ stabilityReads: 1 }),
}).strict();

export const MetamorphicResponseCheckSchema = CheckBaseSchema.extend({
  oracle: z.literal("metamorphic-response"),
  /** Identity used for every variant. The relation is about the parameters, not about who asks. */
  identityId: z.string(),
  /**
   * The declared relation between variant responses.
   * `identical` - status and body must match exactly; use when a parameter must not influence the
   *   response at all, which is how client-controlled data scoping is detected.
   * `status-identical` - only the status must match; use when the body legitimately varies.
   */
  relation: z.enum(["identical", "status-identical"]).default("identical"),
  variants: z.array(z.object({ name: z.string().min(1), queryBindings: z.record(ValueBindingSchema) }).strict()).min(2),
  /** Repeats of the first variant used to prove the endpoint is deterministic before comparing. */
  calibration: z.object({ stabilityReads: z.number().int().min(1).max(5).default(1) }).strict().default({ stabilityReads: 1 }),
}).strict();

export const BrowserExecutionCheckSchema = CheckBaseSchema.extend({ oracle: z.literal("browser-execution") }).strict();
export const OutOfBandCheckSchema = CheckBaseSchema.extend({ oracle: z.literal("out-of-band") }).strict();

export const CheckSchema = z.discriminatedUnion("oracle", [
  DifferentialAuthorizationCheckSchema,
  StateMutationCheckSchema,
  MetamorphicResponseCheckSchema,
  BrowserExecutionCheckSchema,
  OutOfBandCheckSchema,
]);
export type Check = z.infer<typeof CheckSchema>;

export const PlanSchema = z.object({
  schemaVersion: z.literal(1),
  planId: z.string().regex(/^trkp_[a-z0-9_]+$/),
  surfaceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  target: z.object({ applicationId: z.string().min(1), allowedTargetRefs: z.array(z.string()).min(1) }).strict(),
  surface: z.object({
    frameworks: z.array(z.enum(["express", "fastify", "openapi", "unknown"])).min(1),
    routes: z.array(RouteSchema),
    resources: z.array(ResourceSchema),
  }).strict(),
  identities: z.array(z.object({
    id: z.string().regex(/^identity_[a-z0-9_]+$/),
    credentialRef: z.string().optional(),
    roles: z.array(z.string()).default([]),
    capabilities: z.array(z.string()).default([]),
  }).strict()),
  fixtures: z.array(z.object({
    id: z.string().regex(/^fixture_[a-z0-9_]+$/),
    runtimeRef: z.string().min(1),
    resourceId: z.string().optional(),
    ownerIdentityId: z.string().optional(),
  }).strict()),
  invariants: z.array(InvariantSchema),
  checks: z.array(CheckSchema),
  coverage: z.object({
    inScopeRouteIds: z.array(z.string()),
    exclusions: z.array(z.object({ routeId: z.string(), reason: z.string().min(1) }).strict()),
  }).strict(),
  safety: z.object({
    mutationPolicy: z.enum(["forbid", "explicit-authorization-required"]),
    allowedMethods: z.array(HttpMethodSchema).min(1),
  }).strict(),
  provenance: z.object({
    sources: z.array(SourceReferenceSchema),
    compiler: z.object({ mode: z.enum(["manual", "deterministic", "llm-assisted"]), compilerVersion: z.string() }).strict(),
  }).strict(),
}).strict().superRefine((plan, ctx) => {
  const routeIds = new Set(plan.surface.routes.map((route) => route.id));
  const invariantIds = new Set(plan.invariants.map((invariant) => invariant.id));
  const identityIds = new Set(plan.identities.map((identity) => identity.id));
  for (const check of plan.checks) {
    if (!routeIds.has(check.request.routeId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["checks", check.id, "request", "routeId"], message: "Unknown route" });
    if (!invariantIds.has(check.invariantId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["checks", check.id, "invariantId"], message: "Unknown invariant" });
    const referencedIdentities = check.oracle === "differential-authorization"
      ? [...check.allowedIdentityIds, ...check.deniedIdentityIds]
      : check.oracle === "state-mutation"
        ? [check.readIdentityId, ...check.unauthorizedIdentityIds]
        : check.oracle === "metamorphic-response"
          ? [check.identityId]
          : [];
    for (const identityId of referencedIdentities) {
      if (!identityIds.has(identityId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["checks", check.id], message: `Unknown identity: ${identityId}` });
    }
    if (check.oracle === "state-mutation" && !routeIds.has(check.readRequest.routeId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["checks", check.id, "readRequest", "routeId"], message: "Unknown route" });
    }
  }
  if (containsInlineSecret(plan)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [], message: "Plans may not contain inline credential-like values; use runtime configuration references instead" });
});
export type Plan = z.infer<typeof PlanSchema>;

function containsInlineSecret(value: unknown, key = ""): boolean {
  const sensitiveKey = /(?:authorization|cookie|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)/i;
  if (value && typeof value === "object" && ("runtimeRef" in value || "fixtureRef" in value)) return false;
  if (sensitiveKey.test(key) && value !== undefined && value !== null && value !== "") return true;
  if (Array.isArray(value)) return value.some((item) => containsInlineSecret(item));
  if (value && typeof value === "object") return Object.entries(value as Record<string, unknown>).some(([childKey, childValue]) => containsInlineSecret(childValue, childKey));
  return false;
}

export const RuntimeConfigSchema = z.object({
  targets: z.record(z.object({ url: z.string().url(), allowHosts: z.array(z.string()).default([]) }).strict()),
  identities: z.record(z.object({ headers: z.record(z.string()).default({}) }).strict()).default({}),
  /** Test data referenced by `fixtureRef`. Appears in finding evidence, because a finding about
   *  object 42 is unreadable if 42 is masked. Do not put secrets here. */
  fixtures: z.record(z.record(z.unknown())).default({}),
  /** Scalars referenced by `runtimeRef`. Treated as secret: masked wherever evidence is recorded.
   *  This is the sanctioned way to keep a credential or deployment-specific value out of the
   *  committed plan. */
  values: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  mutationAuthorized: z.boolean().default(false),
}).strict();
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;
