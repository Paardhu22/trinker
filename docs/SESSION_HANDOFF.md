# Trinker — Session Handoff

**Written:** 2026-09-11
**Author:** Claude Code session, reconstructing state from the repository itself.
**Basis:** This document was produced by reading every source file, every test, and every doc in
the repository, and by executing the build, typecheck, test suite, and a full live end-to-end
scan against a purpose-built vulnerable local server. **No previous-session transcript was
available.** Every "implemented" claim below was verified by running the code, not by trusting a
summary. Where a claim in the existing `README.md` / `docs/ARCHITECTURE.md` does not match the
code, this document says so explicitly.

> **Repository is not under version control.** `git status` fails with
> `fatal: not a git repository`. There is no `.git` directory, no commit history, and no
> previous-session diff to inspect. See [P0-1](#p0--must-do-next).

---

## 1. Project objective

### What Trinker is

Trinker is a **deterministic application security testing framework** for HTTP APIs. It is
distributed as a pnpm monorepo of TypeScript ESM packages with a single CLI/TUI entry point
(`trinker`).

Its operating model is a two-phase split:

1. **Compile** — application-specific security knowledge is extracted from source and frozen into
   a reviewable, human-auditable, secret-free artifact: `.trinker/plan.json`.
2. **Run** — that plan is executed mechanically. The runner makes HTTP requests, compares
   responses, and emits findings. It performs no reasoning, no inference, and no model calls.

### The core architectural thesis

> **Security knowledge is expensive to derive and cheap to replay.**

Deriving "only the owner of order 42 may read order 42" is genuinely hard — it requires reading
code, understanding the domain, and judgement. *Checking* that claim is trivial: issue two
requests with two identities and compare the bytes.

Trinker therefore treats the expensive step as a **compilation** that happens rarely and produces
a durable artifact, and the cheap step as an **execution** that happens on every CI run. The plan
is the compiler's output; the runner is the interpreter.

### Why the deterministic/compiler architecture exists

- **Reproducibility.** The same plan against the same target yields the same result. A finding is
  not a probabilistic opinion; it is a replayable mechanical fact.
- **Reviewability.** `.trinker/plan.json` is committed and diffable. A human (or a PR reviewer)
  can see exactly what will be tested and what security claims are being asserted, *before*
  anything runs. Security assumptions become code review artifacts.
- **Cost.** A scan costs zero LLM tokens. Running Trinker on every PR is free after compilation.
- **Auditability.** Every finding carries the request/response witnesses that produced it plus a
  replay command. There is no "the model thought this looked exploitable."
- **Safety.** Because the runner only does what the plan says, the blast radius is statically
  bounded and reviewable. An agent that improvises cannot have its blast radius bounded.

### How it differs from repeatedly agentic pentesting

| | Agentic pentester | Trinker |
|---|---|---|
| Per-run cost | LLM tokens every run | Zero tokens per run |
| Reproducibility | Non-deterministic; re-runs differ | Byte-identical re-runs |
| Reviewability | Reasoning is ephemeral | Plan is a committed, diffable artifact |
| Evidence | Model narrative | Redacted request/response witnesses + digests |
| CI suitability | Flaky, slow, expensive | Fast, deterministic, exit-code driven |
| Blast radius | Emergent from model behaviour | Statically bounded by plan + safety gates |
| Knowledge reuse | Re-derived every run | Derived once, replayed forever |

An LLM may *author* the plan (that boundary is designed for and reserved — see §5). It never
participates in executing one.

---

## 2. Current architecture

### Monorepo / package structure

pnpm workspace (`pnpm-workspace.yaml` → `packages/*`), 8 packages, all ESM
(`"type": "module"`), all built with `tsup`, all typechecked with a shared
`tsconfig.base.json` under `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` +
`verbatimModuleSyntax`.

| Package | Name | LOC (src) | Responsibility | Status |
|---|---|---|---|---|
| `packages/core` | `@trinker/core` | 333 | Zod schemas, safety preflight, execution scheduler, typed event bus, findings contract, coverage math | **Active** |
| `packages/surface` | `@trinker/surface` | 147 | TypeScript-AST route extraction, OpenAPI ingestion, resource inference, surface digest | **Active** |
| `packages/oracles` | `@trinker/oracles` | 104 | Deterministic oracle implementations (currently one) | **Active** |
| `packages/report` | `@trinker/report` | 61 | JSON / Markdown / SARIF rendering and file emission | **Active** |
| `packages/trinker` | `trinker` | 97 | CLI arg parsing, TUI shell, project workflow orchestration | **Active** |
| `packages/compiler` | `@trinker/compiler` | 14 | Reserved LLM boundary: `TokenUsage` schema + `TokenBudget` guard. **No provider, no network client.** | **Reserved / orphan** |
| `packages/probes` | `@trinker/probes` | 2 | Placeholder for payload/OOB integrations | **Stub / orphan** |
| `packages/vitest` | `@trinker/vitest` | 2 | Placeholder for Vitest assertion API | **Stub / orphan** |

**Verified:** `compiler`, `probes`, and `vitest` are **not depended on by any other package**.
They build and typecheck but are dead weight in the dependency graph. `TokenBudget` has zero
call sites.

### Dependency direction

```text
                     trinker (CLI + TUI + workflow)
                       |        |        |        |
             +---------+        |        |        +----------+
             v                  v        v                   v
      @trinker/surface   @trinker/oracles  @trinker/report   |
             |                  |                |           |
             +--------+---------+----------------+-----------+
                      v
                 @trinker/core
                (schemas, safety, runner, events, findings, coverage)
                      |
                     zod

      @trinker/compiler --> @trinker/core   (built, never imported)
      @trinker/probes                        (built, never imported)
      @trinker/vitest                        (built, never imported)
```

Dependencies point **inward to `core`**. `core` depends only on `zod` and Node builtins. `core`
has no knowledge of the terminal, the filesystem layout, or the CLI.

### Execution flow: discovery → plan → runner → oracle → finding → report

```text
1. trinker init
   workflow.initialiseProject()
   └─> writes .trinker/runtime.json  (gitignored; URLs + credentials live here)

2. trinker compile
   workflow.compileProject()
   ├─> surface.discoverSurface({ rootDir })
   │     ├─ walk source files (skips node_modules, dist, .git, .trinker, *.test.*, *.spec.*)
   │     ├─ extractRoutesFromSource()  — TypeScript AST visitor
   │     ├─ detectFrameworksFromSource() — import/require analysis
   │     ├─ dedupeRoutes() + sort by id (determinism)
   │     ├─ inferResources() — group routes by path-parameter name
   │     └─ digest = sha256(JSON.stringify({frameworks, routes, resources}))
   ├─> assemble plan skeleton (identities/fixtures/invariants/checks are ALL EMPTY)
   ├─> planId = "trkp_" + sha256(plan-without-id).slice(0,16)   ← content-addressed
   ├─> PlanSchema.parse()  — strict validation + inline-secret rejection
   └─> writes .trinker/plan.json  (COMMITTED artifact)

   *** HUMAN STEP: author identities, fixtures, invariants, checks by hand. ***
   *** compile deliberately invents NO authorization claims. ***

3. trinker run [--ci] [--format json|sarif]
   workflow.runProject()
   ├─> loadPlan()     — PlanSchema.parse (re-validates on every load)
   ├─> loadRuntime()  — RuntimeConfigSchema.parse
   └─> core.runPlan({ plan, runtime, oracles: [differentialAuthorizationOracle] })
         ├─ emit scan.started
         ├─ assertSafePlan(plan, runtime)     ── THROWS and aborts on violation
         ├─ assertSafeTarget(plan, runtime)   ── host allowlist
         ├─ emit phase.started, usage.updated
         ├─ for each enabled check, sorted by check.id (determinism):
         │     ├─ emit check.started
         │     ├─ look up oracle by check.oracle
         │     │    └─ missing -> counts.skipped++, emit check.skipped, continue
         │     ├─ await oracle.execute({ plan, runtime, check, http, emit })
         │     │     └─ differential-authorization:
         │     │          ├─ request once per allowed identity      -> witness
         │     │          ├─ request N times per denied identity    -> calibration
         │     │          ├─ emit oracle.calibrated (denial fingerprints)
         │     │          └─ compare: status equal AND body sha256 equal?
         │     │                yes -> FAILED + Finding
         │     │                denied got 2xx but different bytes -> SKIPPED (inconclusive)
         │     │                otherwise -> PASSED
         │     ├─ failed -> assign id TRK-000N, push finding, emit finding.confirmed
         │     └─ thrown error -> counts.skipped++, emit check.skipped (SWALLOWED)
         ├─ emit scan.completed
         └─ return ScanResult { checks counts, findings, tokens: all zeros }
   ├─> report.createReport(plan, result)
   └─> writes .trinker/latest-report.json  (gitignored)

4. trinker verify <TRK-id>
   workflow.verifyFinding()
   ├─> load latest-report.json, locate the finding
   ├─> load plan, locate finding.replay.checkId
   ├─> runPlan with plan narrowed to that ONE check
   └─> render Markdown; exit 1 if still confirmed, 0 if not reproduced

5. trinker report [--json|--sarif]  (default markdown)
   └─> .trinker/reports/YYYY-MM-DD-security-report.{json,md,sarif}

6. trinker coverage [--ci]
   └─> calculatePlanCoverage(plan) — enabled checks' routeIds / inScopeRouteIds
```

### Separation between core engine and TUI/CI

This separation is real and holds in the code:

- `@trinker/core` imports **zero** terminal, filesystem-layout, or CLI code. Its only imports are
  `zod`, `node:crypto`, and `node:events`.
- All security decisions (safety gating, check scheduling, finding construction, ID assignment,
  event ordering/sequencing) live in `core` or in an oracle. **The CLI and TUI make no security
  decision.**
- `packages/trinker/src/workflow.ts` is the only filesystem adapter — it owns `.trinker/` paths,
  reads/writes JSON, and wires the oracle registry. Both `cli.ts` and `tui.ts` call it.
- `cli.ts` and `tui.ts` both consume the *same* `ScanEventBus` via `handle.subscribe(...)`. The
  TUI is not privileged.
- CI mode (`--ci`) simply passes `undefined` as the event callback, renders a report to stdout,
  and sets `process.exitCode`. It never enters raw mode, never requires a TTY.

### Typed event model

`packages/core/src/events.ts`. Envelope:

```ts
interface ScanEvent<T = Record<string, unknown>> {
  version: 1;          // envelope version, for forward compatibility
  scanId: string;      // stable per scan
  sequence: number;    // monotonic, CORE-OWNED — consumers cannot forge ordering
  timestamp: string;   // ISO 8601; clock is injectable (`now`) for deterministic tests
  type: ScanEventType;
  data: T;
}
```

12 event types, all emitted somewhere in the codebase:

`scan.started` · `surface.discovered` · `phase.started` · `oracle.calibrated` ·
`check.started` · `check.progress` · `check.passed` · `check.failed` · `check.skipped` ·
`finding.confirmed` · `usage.updated` · `scan.completed`

`ScanEventBus` wraps a Node `EventEmitter`, offers `subscribe(fn) => unsubscribe` **and**
implements `AsyncIterable<ScanEvent>`.

> ⚠️ **`surface.discovered` is declared in the union but never emitted.** `discoverSurface` runs
> inside `compile`, which does not have a bus. See [Known issues](#9-known-issues--technical-debt).
>
> ⚠️ **The async iterator never terminates** and **early events are lost to a subscription race.**
> Both are verified defects — see [Known issues](#9-known-issues--technical-debt).

---

## 3. `.trinker/plan.json`

Defined by `PlanSchema` in `packages/core/src/schema.ts`. `.strict()` throughout — unknown keys
are rejected at every level.

### Current schema (schemaVersion 1)

```jsonc
{
  "schemaVersion": 1,                                  // z.literal(1)
  "planId": "trkp_<16 hex>",                           // /^trkp_[a-z0-9_]+$/, content-addressed
  "surfaceDigest": "sha256:<64 hex>",                  // /^sha256:[a-f0-9]{64}$/
  "target": {
    "applicationId": "my-app",                         // NOT a URL — a logical name
    "allowedTargetRefs": ["local"]                     // KEYS into runtime.json.targets, min 1
  },
  "surface": {
    "frameworks": ["express"],                         // express|fastify|openapi|unknown, min 1
    "routes": [{
      "id": "route_get_api_orders_id_d57bfb5a",        // /^route_[a-z0-9_]+$/
      "method": "GET",                                 // GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS
      "pathTemplate": "/api/orders/:id",               // must start with "/"
      "operationId": "getOrder",                       // optional (OpenAPI only)
      "parameters": [{ "name": "id", "location": "path", "required": true }],
      "sourceRefs": [{ "kind": "ast", "path": "app.ts", "line": 3 }],
      "confidence": "high"                             // high|medium|low
    }],
    "resources": [{
      "id": "resource_order", "name": "order",
      "routeParameter": "id", "routeIds": [...], "sourceRefs": []
    }]
  },
  "identities": [{
    "id": "identity_owner",                            // /^identity_[a-z0-9_]+$/
    "credentialRef": "owner",                          // optional KEY into runtime.identities
    "roles": ["user"], "capabilities": []              // documentation only; unused by oracles
  }],
  "fixtures": [{
    "id": "fixture_order",                             // /^fixture_[a-z0-9_]+$/
    "runtimeRef": "orderOwnedByOwner",                 // KEY into runtime.fixtures, required
    "resourceId": "resource_order",                    // optional
    "ownerIdentityId": "identity_owner"                // optional; documentation only
  }],
  "invariants": [{
    "id": "inv_order_owner_only",                      // /^inv_[a-z0-9_]+$/
    "kind": "authorization",                           // authorization | state-mutation |
                                                       // metamorphic-response |
                                                       // browser-execution | out-of-band
    "statement": "Only the owner may retrieve this order.",   // 1..1000 chars, human prose
    "routeIds": ["route_..."],                         // min 1
    "resourceId": "resource_order",                    // optional
    "provenance": "manual"                             // manual | deterministic | llm-assisted
  }],
  "checks": [ /* discriminated union on "oracle" — see below */ ],
  "coverage": {
    "inScopeRouteIds": ["route_..."],
    "exclusions": [{ "routeId": "route_...", "reason": "REQUIRED, min 1 char" }]
  },
  "safety": {
    "mutationPolicy": "forbid",                        // forbid | explicit-authorization-required
    "allowedMethods": ["GET", "HEAD", "OPTIONS"]       // min 1
  },
  "provenance": {
    "sources": [{ "kind": "ast", "path": "." }],
    "compiler": { "mode": "deterministic", "compilerVersion": "0.1.0" }
                 // mode: manual | deterministic | llm-assisted
  }
}
```

### Check variants (discriminated union on `oracle`)

All extend a base of `{ id: /^chk_[a-z0-9_]+$/, invariantId, enabled (default true), request }`.

| `oracle` | Extra fields | Runtime oracle registered? |
|---|---|---|
| `differential-authorization` | `allowedIdentityIds` (min 1), `deniedIdentityIds` (min 1), `calibration.trials` (1–5, default 3) | ✅ **Yes** |
| `state-mutation` | `readRequest`, `protectedPaths` (min 1) | ❌ No — parses, then skips at runtime |
| `metamorphic-response` | `variants[]` (min 2) | ❌ No |
| `browser-execution` | — | ❌ No |
| `out-of-band` | — | ❌ No |

> **Verified:** the four unregistered variants validate successfully against `PlanSchema` and are
> then silently downgraded to `check.skipped` with reason `"Oracle unavailable: <name>"` at run
> time. The schema is ahead of the runtime by four oracles.

### `RequestTemplate` and value bindings

```jsonc
"request": {
  "routeId": "route_...",
  "pathBindings":   { "id": <ValueBinding> },
  "queryBindings":  { "q":  <ValueBinding> },
  "headerBindings": { "x-tenant": <ValueBinding> },
  "body": <unknown>            // optional, arbitrary
}
```

`ValueBinding` is a 3-way union:

| Form | Meaning | Implemented in oracle? |
|---|---|---|
| `{ "fixtureRef": "fixture_order", "field": "id" }` | resolve `runtime.fixtures[fixture.runtimeRef][field]`, must be primitive | ✅ **Yes** |
| `{ "literal": "abc" \| 42 \| true }` | inline constant | ✅ **Yes** |
| `{ "runtimeRef": "someKey" }` | resolve from runtime config | ❌ **THROWS** `"runtimeRef bindings are not implemented"` |

> **Verified defect:** a `runtimeRef` binding passes schema validation, then throws at execution.
> The runner catches the throw and turns the check into a **skip**, so the user sees
> `check.skipped {"reason":"runtimeRef bindings are not implemented: owner"}` — a silently
> non-executed security check.

### Cross-reference validation (`superRefine`)

On every `PlanSchema.parse()`:

- every `check.request.routeId` must exist in `surface.routes`
- every `check.invariantId` must exist in `invariants`
- for `differential-authorization`, every id in `allowedIdentityIds` ∪ `deniedIdentityIds` must
  exist in `identities`
- the whole plan is walked by `containsInlineSecret()` (below)

### Safety constraints

Enforced in `packages/core/src/safety.ts`, called by `runPlan` **before any HTTP request**:

1. **Target allowlist** (`assertSafeTarget`) — `localhost`, `127.0.0.1`, `::1`, `[::1]` are
   allowed implicitly. **Any other hostname must be listed in
   `runtime.targets[ref].allowHosts`** or the scan aborts.
   *Verified:* pointing the target at `https://example.com` aborts with
   `Target example.com is blocked. Use an explicit allowHosts entry for an authorized target.`
   and exit code 2.
2. **Method allowlist** — every checked route's method must appear in `plan.safety.allowedMethods`.
3. **Mutation gate, part 1** — if any checked route uses a non-`GET`/`HEAD`/`OPTIONS` method and
   `plan.safety.mutationPolicy === "forbid"`, the scan aborts.
   *Verified:* aborts with `Plan contains a write check while mutationPolicy is forbid`, exit 2.
4. **Mutation gate, part 2** — write checks *additionally* require `mutationAuthorized: true` in
   `runtime.json`. Both gates must be passed; the plan alone cannot authorize a write.
5. **Unknown route reference** — a check naming a nonexistent route aborts the scan.

All five are hard aborts (thrown), not warnings. `compile` emits the maximally conservative
policy: `mutationPolicy: "forbid"`, `allowedMethods: ["GET","HEAD","OPTIONS"]`.

### Secret / credential handling

The plan is designed to be **committed**; the runtime config is designed to be **gitignored**.
`.gitignore` encodes exactly this: it ignores `.trinker/runtime.json`, `.trinker/reports/`,
`.trinker/events/`, `.trinker/cache/` — and **not** `.trinker/plan.json`.

`containsInlineSecret()` (schema.ts:152) recursively walks the entire plan. Any key matching
`/(?:authorization|cookie|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)/i`
with a non-empty value is rejected — **unless** the value is an object containing `runtimeRef` or
`fixtureRef`, which are the sanctioned indirection forms.

*Verified:* a plan containing
`headerBindings: { "authorization": { "literal": "Bearer leaked-token" } }` is rejected with
`"Plans may not contain inline credential-like values; use runtime configuration references
instead"`. The same key bound as `{ "runtimeRef": "owner" }` passes the schema (though it then
fails at execution — see above).

Note the `.strict()` schemas are the first line of defence: an arbitrary `apiKey` field anywhere
is rejected as an unrecognized key before the secret scanner even runs.

Evidence redaction: `redactedHeaders()` in the oracle replaces any header whose **name** matches
`/authorization|cookie|token|secret/i` with `[REDACTED]` in both requests and responses recorded
in a finding. *Verified in the emitted report.*

### How plans are generated / validated

- **Generated:** `trinker compile` → `workflow.compileProject()`. Fully deterministic, zero LLM.
  It extracts the surface and emits a structurally valid plan with **empty**
  `identities`/`fixtures`/`invariants`/`checks`. It deliberately invents no authorization claims.
- **Validated:** `PlanSchema.parse()` runs on write (in `compile`) and again on **every** read
  (`loadPlan`). A hand-edited plan cannot be run without passing full validation.
- **Authored:** identities, fixtures, invariants, and checks are **written by hand today**.
  `docs/PLAN_AUTHORING.md` is the reference, and its example route id
  (`route_get_api_orders_id_d57bfb5a`) was verified to be byte-identical to what the compiler
  actually produces for `app.get('/api/orders/:id', …)`.

### What is deterministic

- `planId` is `sha256` of the plan body → identical input source yields an identical plan id.
- `surfaceDigest` is `sha256` of `{frameworks, routes, resources}`.
- Route ids embed `sha256(method + " " + path).slice(0,8)` → stable across runs and machines.
- Routes are deduped and sorted by id before digesting.
- Checks execute in `check.id.localeCompare` order, not declaration order.
- Response comparison is `status` equality **AND** `sha256(body)` equality. No fuzzy matching.
- Event `sequence` is a core-owned monotonic counter; the clock is injectable for tests.
- Token counters are hard-coded to zero in `runPlan` and `ScanResult`.

---

## 4. Implemented functionality

Legend: ✅ fully implemented · 🟡 partially implemented · ⬜ stubbed · ❌ not implemented

### Surface discovery — 🟡 partially implemented

✅ Recursive source walk with sensible exclusions (`node_modules`, `dist`, `.git`, `.trinker`,
`*.test.*`, `*.spec.*`), default include `/\.[cm]?[jt]sx?$/`, sorted output.
✅ Resource inference: groups routes by path-parameter name, strips a trailing `Id`, emits
`resource_<name>` with `routeIds` and a representative `routeParameter`.
✅ Deterministic dedupe + digest.
🟡 Extraction quality — **verified limitations, each reproduced**:

| Input | Extracted | Correct? |
|---|---|---|
| `app.get('/health', h)` | `GET /health` | ✅ |
| `router.post('/orders/:orderId', h)` | `POST /orders/:orderId` + path param | ✅ |
| `fastify.route({ method:'DELETE', url:'/orders/:id' })` | `DELETE /orders/:id` | ✅ |
| `fastify.get('/ping', h)` | `GET /ping` | ✅ |
| `r.get('/:id'); app.use('/api/orders', r)` | `GET /:id` | ❌ **mount prefix ignored → wrong path, still labelled `confidence: "high"`** |
| `` app.get(`/api/${v}/x`, h) `` | *(nothing)* | ❌ template literals with substitutions dropped |
| `cache.get('/api/secret')` | `GET /api/secret` | ❌ **false positive — any `.get('/…')` call** |
| `app.route('/books').get(h).post(h)` | `GET /books` only | ❌ `.post` in the chain missed |
| `@Get('/users/:id')` (Nest) | *(nothing)* | ❌ decorator frameworks unsupported |

### Express/Fastify AST extraction — 🟡 partially implemented

Uses the real `typescript` compiler API (`ts.createSourceFile` + visitor), not regex. Recognises
three shapes: `<expr>.<method>('/path', …)`, `<expr>.route({ method, url|path })`, and
`<expr>.route('/path').<method>(…)` (first link only). Framework detection is separate and
honest: `detectFrameworksFromSource` reads `import`/`require` specifiers only, so
`app.get("/health")` on a plain object yields `["unknown"]` rather than a guess — this is
explicitly asserted by a test.

### OpenAPI ingestion — ✅ fully implemented (for the object form)

`ingestOpenApi(document)` walks `paths`, normalises `{id}` → `:id`, preserves `operationId`,
derives path parameters, returns a full `Surface` with digest. **Not wired into the CLI** — there
is no `trinker compile --openapi <file>`; it is a library function only.

### Deterministic runner — ✅ fully implemented

Safety preflight, oracle registry lookup, deterministic check ordering, per-check try/catch,
counter maintenance, sequential `TRK-000N` id assignment, `ScanResult` assembly, all token
counters pinned to zero. `FetchHttpClient` uses global `fetch` and is injectable (`options.http`)
— the entire test suite runs against a fake client with no network.

### Differential authorization oracle — ✅ fully implemented

**Verified end-to-end against a live vulnerable HTTP server**, producing a real CONFIRMED
finding. Algorithm:

1. One request per allowed identity → keep only 2xx responses as **witnesses**. If none, the
   check is `skipped` (`"No allowed identity produced a successful reference response"`), never a
   finding.
2. `calibration.trials` requests per denied identity (default 3, max 5) — this measures the
   application's actual denial behaviour rather than assuming 401/403.
3. Emit `oracle.calibrated` with the observed denial status set and fingerprint set.
4. **Confirm only on exact match**: `status` equal **AND** `sha256(body)` equal between a denied
   sample and a witness.
5. A denied identity receiving an *unexpected 2xx with different bytes* → `skipped`
   (**inconclusive, not a finding**).
6. Otherwise → `passed`.

Fingerprints also capture `contentType` and a `bodyShape` (`array:N`, `object:sortedKeys`,
`text:len`) for calibration reporting, but **only status + body digest gate confirmation**.

### Findings — ✅ fully implemented (one defect)

Zod-enforced: id `/^TRK-\d{4}$/`, `status` is `z.literal("confirmed")` — **the type system makes
an unconfirmed finding unrepresentable**. Carries invariant statement, routeId, oracle name,
verdict, redacted request/response witnesses with body digests + ≤1000-char previews,
human-readable notes, remediation, and a replay handle.
❌ **Defect:** `replay.command` is hard-coded to `"trinker verify TRK-0000"` in the oracle
(differential-authorization.ts:95). The runner renumbers `finding.id` to `TRK-0001` but never
rewrites `replay.command`. *Verified:* the report instructs the user to run
`trinker verify TRK-0000`, which fails with `Finding TRK-0000 is not present in the latest
report` (exit 2).

### Coverage — 🟡 partially implemented

✅ Plan coverage: `enabled checks' routeIds ∩ inScopeRouteIds`, returns
`{inScopeRoutes, coveredRoutes, uncoveredRouteIds, percent}`. *Verified:* 0% → 50% after adding
one check to a 2-route surface.
❌ **Execution coverage is not persisted.** `docs/ARCHITECTURE.md` states this honestly. Only
passed/failed/skipped counts exist in `ScanResult`. A check that *skipped* still counts as
"covered" by plan coverage — a meaningful blind spot.
🟡 `percent` is `0` when `inScopeRoutes === 0` (arguably should be 100 or `null`).

### Verification / replay — 🟡 partially implemented

✅ `trinker verify <id>` loads the latest report, finds the finding, narrows the plan to the
single `replay.checkId`, re-runs it, renders Markdown, and exits 1 if still confirmed / 0 if not
reproduced. *Verified working when given the correct id.*
❌ Unreachable via the command the report prints (see the `TRK-0000` defect above).
🟡 The replay always renumbers its finding to `TRK-0001` because numbering restarts from an empty
array — verifying `TRK-0003` prints a report about `TRK-0001`.
🟡 Verify does **not** persist its result; `latest-report.json` is untouched.

### JSON / Markdown / SARIF reports — ✅ fully implemented

All three renderers work. *Verified:* Markdown contains the replay command and severity summary;
SARIF parses with `version === "2.1.0"` and a well-formed `runs[0].tool.driver` + `results`.
`writeReport` emits `.trinker/reports/YYYY-MM-DD-security-report.{json,md,sarif}`.
🟡 SARIF has **no `locations` array** — findings have no file/line anchor, so GitHub code scanning
will not annotate a line. Rule metadata is minimal (no `helpUri`, no `fullDescription`).
🟡 One report file per day per format — a second scan on the same day silently overwrites.

### CI mode — 🟡 partially implemented

✅ `--ci` suppresses the event stream, prints a report to stdout, and sets
`process.exitCode = findings.length > 0 ? 1 : 0`. *Verified: exit 1 with a finding, 0 without,
2 on error.* Requires no TTY.
❌ **`--format markdown` is silently ignored in CI.** `cli.ts:19` maps only `"sarif"` → sarif and
*everything else* → json. *Verified:* `run --ci --format markdown` prints JSON with no warning.
❌ No `.github/` workflow, no example CI configuration anywhere in the repo.

### Interactive TUI — 🟡 partially implemented

See §6 for detail. The menu, navigation, and all seven actions work, but rendering is raw
`stdout.write` with full-screen clears, and the live scan feed is missing its first events.

### Configuration — 🟡 partially implemented

✅ `RuntimeConfigSchema` (strict): `targets` (url + allowHosts), `identities` (header maps),
`fixtures` (arbitrary records), `mutationAuthorized` (default false). `trinker init` writes a safe
default pointing at `http://localhost:3000` with `mutationAuthorized: false`.
❌ No env-var overrides, no config precedence chain, no `--config` flag, no credential-manager
integration. Credentials sit in plaintext in `.trinker/runtime.json` (gitignored, but plaintext).
❌ The TUI's "Configuration" menu item only prints an explanatory sentence — it cannot edit
anything.

### Juice Shop setup — 🟡 partially implemented

✅ `examples/juice-shop/docker-compose.yml` is valid (*verified with `docker compose config`*)
and pins `bkimminich/juice-shop:latest` on port 3000. Docker 29.7.2 is installed on this machine.
✅ `examples/juice-shop/README.md` documents the workflow and is **honest about the gap**: the
Phase-1 compiler only reads source routes, so Juice Shop's dynamic API needs a hand-written plan
or a future OpenAPI/crawler input.
❌ **No Juice Shop plan exists.** There is no `examples/juice-shop/plan.json`, no runtime
template, no identities, no fixtures, no documented login flow to obtain tokens. The image was
not pulled and the end-to-end Juice Shop scan has **never been run**.

---

## 5. Deferred functionality

Everything below is **absent from the codebase**, verified by reading every source file.

### LLM compiler / provider integration — ⬜ stubbed boundary only

`@trinker/compiler` contains exactly two things: a `TokenUsageSchema` and a `TokenBudget` class
that throws when a reservation would exceed its limit. Its own doc comment states: *"The optional
LLM boundary. No provider or network client is included in the MVP."*

Absent: any provider SDK (`grep` for `anthropic|openai|@ai-sdk` across all sources returns **zero
dependency hits** — only the word "LLM" in comments and user-facing strings), prompt templates,
invariant-inference logic, plan-diff review flow, `--llm` flag, `compile --mode llm-assisted`.
`TokenBudget` has **zero call sites**. The schema already reserves `provenance.compiler.mode:
"llm-assisted"` and `invariant.provenance: "llm-assisted"` for this future.

### Out-of-band (OOB) callbacks — ❌ not implemented

`out-of-band` is a valid `invariant.kind` and a valid `check.oracle`, so a plan can declare one.
There is **no oracle, no collector, no DNS/HTTP callback server, no correlation-token generator**.
Such a check parses and then skips with `"Oracle unavailable: out-of-band"`.
`@trinker/probes` — the package nominated for this — is a two-line file exporting
`probePackageStatus = "not-enabled"`.

### Browser-based checks — ❌ not implemented

`browser-execution` is a valid oracle name in the schema. No Playwright/Puppeteer dependency, no
browser driver, no XSS/DOM oracle. Skips at runtime.

### State-mutation oracles — ❌ not implemented

`StateMutationCheckSchema` is fully specified (`readRequest` + `protectedPaths`) — this is the
**most complete unimplemented schema**, and the shortest path to a second oracle. No
implementation exists. Skips at runtime.

### Metamorphic-response oracle — ❌ not implemented

`MetamorphicResponseCheckSchema` with `variants[]` (min 2) is specified. No implementation.

### Crawler — ❌ not implemented

`SourceReferenceSchema.kind` includes `"crawler"`, and the Juice Shop README names a crawler as
the way to reach dynamic APIs. There is no crawler, no HAR ingestion, no traffic replay, no
proxy-recording input.

### Vitest integration — ⬜ stubbed

`@trinker/vitest` is two lines: `vitestIntegrationStatus = "not-enabled"`. No custom matchers, no
`expect(plan).toHaveNoFindings()`, no test-runner harness. (Note: Vitest **is** used as the
repo's own test runner — the *integration package* for consumers is what is stubbed.)

### Other gaps found during inspection

- **`runtimeRef` value bindings** — schema-valid, throws at execution (§3).
- **`surface.discovered` event** — declared in the type union, never emitted anywhere.
- **Multi-target scanning** — `allowedTargetRefs` is an array, but only `[0]` is ever read
  (safety.ts:6, oracle line 33). Extra entries are silently ignored.
- **`identity.roles` / `identity.capabilities`** — accepted and stored, consumed by nothing. RBAC
  matrix testing does not exist.
- **`fixture.ownerIdentityId` / `fixture.resourceId`** — documentation-only; no oracle reads them.
- **`invariant.resourceId`** — never read.
- **Request body support** — `RequestTemplateSchema.body` exists and `FetchHttpClient` will
  `JSON.stringify` it, but the differential-authorization oracle **never sends a body** (its
  `requestFor()` returns only `{method, url, headers}`). Body-bearing checks are untestable today.
- **HTTP client hardening** — no timeout, no retry, no concurrency cap, no rate limiting, no
  `content-type` header set when a body is sent, no redirect policy, no TLS options, no proxy
  support.
- **Report signing / attestation** — none.
- **Baseline / triage / suppression** — no way to mark a finding accepted; every run reports the
  full set.
- **Plan migration** — `schemaVersion` is `z.literal(1)` with no migration path for v2.
- **Linting** — every package's `lint` script is literally `tsc --noEmit` (identical to
  `typecheck`). There is no ESLint config, no Prettier, no formatter.
- **CI pipeline** — no `.github/`, no pipeline definition of any kind.

---

## 6. TUI

`packages/trinker/src/tui.ts`, 68 lines. Launched by running `trinker` with **no arguments**.

### Current commands / menu

A fixed 8-item array (`tui.ts:5`):

```
❯ Run Security Scan
  View Latest Report
  View Findings
  Verify Finding
  Security Coverage
  Export Report
  Configuration
  Exit
```

Header shows `TRINKER`, the tagline, the project directory, and
`Runtime LLM tokens: 0 by default`.

### Keyboard navigation

| Key | Action |
|---|---|
| `↑` / `↓` | move selection (wraps both directions, modulo arithmetic) |
| `Enter` | activate the selected item |
| `q` or `Esc` | quit |
| any key | dismiss the "Press any key to return" pause after an action |
| `1`–`9` | select a finding by number in the **Verify Finding** flow |
| `m` / `j` / `s` | choose Markdown / JSON / SARIF in the **Export Report** flow |

Implementation: `readline.emitKeypressEvents(stdin)` + `stdin.setRawMode(true)`, with each
keystroke awaited as a one-shot `input.once("keypress", …)` promise. Raw mode is always restored
in a `finally` block, and the screen is cleared on exit.

### What is actually implemented

| Menu item | Status | Behaviour |
|---|---|---|
| Run Security Scan | ✅ works | streams live events as raw JSON lines, then a summary |
| View Latest Report | ✅ works | reads `.trinker/latest-report.json`, lists findings |
| View Findings | ✅ works | **identical code path to "View Latest Report"** — the two menu items differ only in the printed heading |
| Verify Finding | ✅ works | numbered list → single keypress → replays → "still confirmed" / "not reproduced" |
| Security Coverage | ✅ works | covered/in-scope, percentage, uncovered route ids |
| Export Report | ✅ works | writes to `.trinker/reports/` and prints the path |
| Configuration | 🟡 informational only | prints one sentence about `.trinker/runtime.json`; **cannot edit anything** |
| Exit | ✅ works | breaks the loop, restores the terminal |

Errors inside an action are caught and shown as `Error: <message>` followed by a pause — the TUI
does not crash out of the menu loop.

### Live scan events

The TUI subscribes to the real `ScanEventBus` and writes each event as
`<type>: <JSON.stringify(data)>`. There is no formatting, no progress bar, no spinner, no colour,
no severity styling — it is a raw event log.

> ⚠️ **Verified defect — the first events never arrive.** `runPlan()` starts `execute()`
> *synchronously*, and `execute()` emits `scan.started`, `phase.started`, `usage.updated`, and the
> first `check.started` before it reaches its first `await`. `workflow.runProject()` calls
> `handle.subscribe(onEvent)` only *after* `runPlan()` returns — by which time those events have
> already fired into an empty emitter.
>
> Observed output of a real scan (note what is missing at the top):
> ```
> check.progress {"checkId":"chk_order_owner_only","identityId":"identity_owner","status":200}
> check.progress {"checkId":"chk_order_owner_only","identityId":"identity_peer","trial":1,...}
> check.progress {"checkId":"chk_order_owner_only","identityId":"identity_peer","trial":2,...}
> oracle.calibrated {...}
> finding.confirmed {"findingId":"TRK-0001","severity":"high",...}
> check.failed {...}
> scan.completed {...}
> ```
> `scan.started`, `phase.started`, `usage.updated`, `check.started`, and the oracle's own
> `phase.started {"phase":"authorization"}` are **all lost**. This affects the CLI's non-CI
> streaming mode identically.

### Current limitations

- Requires a TTY; throws `Interactive mode requires a TTY. Use 'trinker run --ci' for automation.`
  otherwise (*verified, exit 2*) — correct behaviour, but it means the TUI is untestable in CI.
- Full-screen clear (`\x1Bc`) on every render; no diffing, no scrollback preservation.
- No scrolling, no pagination — a long finding list or a long event stream overflows the terminal.
- No search, no filtering, no sorting by severity.
- Finding selection is a single keypress → only findings 1–9 are reachable.
- `Number(keypress.sequence)` on a non-digit yields `NaN` → "Invalid finding selection."
- No resize handling (`SIGWINCH` ignored).
- No colour or severity highlighting anywhere.
- No `init` or `compile` entry point in the menu — a fresh project must be set up from the CLI.
- No live in-progress indicator; a slow scan looks frozen between events.
- No zero-dependency framework (no Ink/blessed) — all rendering is manual `stdout.write`.

### What still needs to be built

1. Fix the event-subscription race so the scan feed is complete (**prerequisite for everything
   else in the TUI**).
2. Human-readable event rendering — a per-check progress line rather than raw JSON.
3. A scrollable, filterable findings pane with severity colour.
4. Finding **detail** view showing evidence (requests, responses, digests, notes) — currently the
   richest part of a finding is invisible in the TUI.
5. Make "Configuration" an actual editor for `.trinker/runtime.json`, or delete the menu item.
6. Differentiate or merge "View Latest Report" and "View Findings".
7. Multi-digit / arrow-key finding selection.
8. `init` and `compile` menu entries.
9. Resize + scrollback handling.

---

## 7. Security coverage

### Currently supported checks / oracles

**Exactly one oracle is registered** (`workflow.ts:49`: `oracles: [differentialAuthorizationOracle]`).

#### 1. Differential Authorization → Broken Object Level Authorization (BOLA/IDOR)

- **Oracle name:** `differential-authorization`
- **Invariant kind:** `authorization`
- **Finding title:** `Broken Object Level Authorization`
- **Severity:** hard-coded `high`
- **Remediation text:** *"Enforce ownership authorization on the server before retrieving the
  requested resource."*

**Evidence required for CONFIRMED** — all of the following must hold:

1. At least one **allowed** identity returned a 2xx response (the *witness*). Without a witness
   the check is `skipped`, never confirmed.
2. A **denied** identity's response matched the witness on **both**:
   - identical HTTP status code, **and**
   - identical `sha256` digest of the **full response body** (byte-equivalence).
3. Calibration ran first: `calibration.trials` (1–5, default 3) requests per denied identity, with
   the observed denial status set and fingerprint set emitted as `oracle.calibrated`.
4. The finding records, with credential headers redacted: both requests (method, URL, headers),
   both responses (status, headers, body digest, ≤1000-char preview), the invariant statement, the
   route id, a natural-language verdict, and the replay check id.

**Explicitly NOT sufficient for CONFIRMED** (deliberate conservatism, verified in code):

- A denied identity receiving *any* 2xx with a **different** body → `skipped`, reason *"Denied
  identity returned an unexpected success but not an equivalent witness response."*
- Similar status, similar shape, similar length, similar content-type → not a finding.
  `bodyShape` and `contentType` inform calibration reporting only; they never gate confirmation.
- Heuristics, scoring, and thresholds do not exist. The test
  `"confirms only identical successful witness responses"` locks this in.

This is a **high-precision / low-recall** design: it will miss BOLA where responses differ per
user (e.g. a response echoing the caller's own id), and it will essentially never produce a false
positive.

### Planned but unavailable

| Check | Schema | Oracle | Behaviour today |
|---|---|---|---|
| State mutation (unauthorized write / mass assignment) | ✅ `readRequest` + `protectedPaths` | ❌ | `check.skipped {"reason":"Oracle unavailable: state-mutation"}` |
| Metamorphic response (invariant across request variants) | ✅ `variants[]` min 2 | ❌ | `check.skipped {"reason":"Oracle unavailable: metamorphic-response"}` |
| Browser execution (XSS / DOM) | ✅ (no extra fields) | ❌ | `check.skipped {"reason":"Oracle unavailable: browser-execution"}` |
| Out-of-band (SSRF, blind injection, XXE) | ✅ (no extra fields) | ❌ | `check.skipped {"reason":"Oracle unavailable: out-of-band"}` |

> ⚠️ **A skipped check is easy to miss.** An unavailable oracle produces a `skipped` counter
> increment and a `check.skipped` event — it does **not** fail the run, does not affect the CI exit
> code, and still counts as "covered" by plan coverage. A plan full of `state-mutation` checks
> exits `0` and reports no findings, which reads identically to "we tested and found nothing."

**Entirely out of scope today** (no schema, no oracle): SQL/NoSQL injection, command injection,
path traversal, CSRF, SSRF, XXE, deserialization, rate-limit bypass, authentication bypass,
session fixation, JWT algorithm confusion, privilege escalation across roles, mass assignment,
GraphQL-specific attacks, race conditions / TOCTOU, and business-logic abuse.

---

## 8. Testing and verification

Everything in this section was executed on 2026-09-11 in this environment.

### ⚠️ `pnpm` is NOT installed

`package.json` declares `"packageManager": "pnpm@10.19.0"` and every documented command is a
`pnpm` command, but **`pnpm` is not on `PATH`** (`pnpm: command not found`) and **`corepack` is
not installed either**. `npm` and `npx` are available.

`node_modules/` *is* correctly populated by a previous pnpm install (`node_modules/.pnpm/` exists,
workspace symlinks are in place, `pnpm-lock.yaml` is present), so the repo is usable — but **none
of the documented `pnpm` commands run as written**. All commands below use the workspace binaries
in `node_modules/.bin/` directly.

### Commands that currently work

```bash
# ---- Test suite: 9 tests / 5 files, ALL PASSING (771 ms) ----
./node_modules/.bin/vitest run

# ---- Typecheck: CLEAN across all 8 packages (exit 0 each) ----
for p in core compiler oracles probes report surface trinker vitest; do
  (cd packages/$p && ../../node_modules/.bin/tsc --noEmit)
done

# ---- Build: works (tsup, ESM + .d.ts) ----
(cd packages/core && ../../node_modules/.bin/tsup src/index.ts --format esm --dts)
# verified: ESM build 18 ms, DTS build 1226 ms, success

# ---- CLI (the `trinker` bin is NOT linked onto PATH) ----
node packages/trinker/dist/cli.js <command>
```

Documented-but-currently-broken equivalents: `pnpm install`, `pnpm test`, `pnpm typecheck`,
`pnpm build`, `pnpm -r build` — all fail with `pnpm: command not found`.

### Test status — ✅ 9/9 passing

```
✓ packages/report/test/report.test.ts      (1 test)   5ms
✓ packages/core/test/schema.test.ts        (3 tests)  7ms
✓ packages/oracles/test/differential-authorization.test.ts (1 test) 6ms
✓ packages/surface/test/extract.test.ts    (3 tests) 16ms
✓ packages/trinker/test/workflow.test.ts   (1 test)  14ms

Test Files  5 passed (5)
     Tests  9 passed (9)
  Duration  771ms
```

What they cover: plan coverage math; event sequence ownership; inline-credential rejection;
end-to-end BOLA confirmation through `runPlan` with a fake HTTP client (asserting
`tokens.runtimeInput === 0`); Express/Fastify/OpenAPI extraction; framework detection honesty;
Markdown replay text + SARIF version; deterministic compilation producing an empty-check plan.

What they **do not** cover: safety gates (`assertSafePlan`/`assertSafeTarget` have **zero tests** —
the security-critical module is untested); the CLI; the TUI; `verifyFinding`; report *file*
writing; the event-subscription race; `runtimeRef` bindings; oracle-unavailable behaviour;
`FetchHttpClient`. There is no coverage reporting configured.

### Typecheck status — ✅ clean

All 8 packages exit 0. `tsconfig` `include` covers both `src` and `test` in every package that has
tests, so test files are typechecked too. `strict`, `noUncheckedIndexedAccess`, and
`exactOptionalPropertyTypes` are all on.

### Build status — ✅ working, and `dist/` is fresh

All 8 packages have a `dist/` newer than their `src/index.ts` — the committed build output matches
current source. `packages/trinker/dist/cli.js` has the `#!/usr/bin/env node` shebang and mode
`-rwxr-xr-x`.

### CLI smoke tests — all verified (run in a scratch directory, never in the repo)

| Command | Result |
|---|---|
| `init` | ✅ created `.trinker/runtime.json`, exit 0; idempotent on re-run |
| `compile` | ✅ `Compiled 2 routes to .trinker/plan.json (trkp_3ad0ac8767600c78). Runtime LLM tokens: 0` |
| `coverage` | ✅ `Coverage: 0.0% (0/2)` → `50.0% (1/2)` after authoring one check |
| `run` (interactive) | ✅ streams events, confirms a finding — **but drops the first 4–5 events** |
| `run --ci --format json` | ✅ JSON report to stdout; exit 0 clean / **exit 1 with a finding** |
| `run --ci --format sarif` | ✅ valid SARIF 2.1.0 |
| `run --ci --format markdown` | ❌ **silently emits JSON** |
| `verify TRK-0001` | ✅ replays, prints Markdown, exit 1 (still confirmed) |
| `verify TRK-0000` (what the report tells you to run) | ❌ `Finding TRK-0000 is not present in the latest report`, exit 2 |
| `report --sarif` | ✅ wrote `.trinker/reports/2026-09-11-security-report.sarif` |
| `bogus` | ✅ `trinker: Unknown command: bogus`, exit 2 |
| no args, no TTY | ✅ `Interactive mode requires a TTY…`, exit 2 |

### End-to-end live scan — ✅ verified, real finding confirmed

A deliberately vulnerable `node:http` server (no ownership check on `GET /api/orders/:id`) was
started on port 3999, a plan was hand-authored per `docs/PLAN_AUTHORING.md`, and the scan produced:

```
oracle.calibrated {"denialStatuses":[200],"denialFingerprints":["200:application/json:object:id,owner"],"deniedSamples":2,"trials":2}
finding.confirmed {"findingId":"TRK-0001","severity":"high","checkId":"chk_order_owner_only"}
check.failed {"reason":"Denied identity matched an allowed witness response"}
scan.completed {"checks":{"planned":1,"passed":0,"failed":1,"skipped":0},"findings":1,"durationMs":34,"runtimeTokens":0}
```

The emitted finding had `authorization: "[REDACTED]"` in both recorded requests. **The core thesis
works.**

### Safety gates — ✅ verified by deliberate violation

| Violation | Result |
|---|---|
| target `https://example.com`, not in `allowHosts` | aborted: `Target example.com is blocked. Use an explicit allowHosts entry for an authorized target.` exit 2 |
| `POST` check with `mutationPolicy: "forbid"` | aborted: `Plan contains a write check while mutationPolicy is forbid` exit 2 |
| `{"literal": "Bearer leaked-token"}` under an `authorization` header binding | rejected: `Plans may not contain inline credential-like values; use runtime configuration references instead` exit 2 |
| arbitrary `apiKey` field in `provenance` | rejected by `.strict()` as `unrecognized_keys`, exit 2 |

### Juice Shop setup / test procedure

**Never executed.** What exists and what is needed:

```bash
# Exists and validates (docker compose config → OK; Docker 29.7.2 present):
cd examples/juice-shop && docker compose up -d     # image NOT pulled in this environment

# What does NOT exist and must be built before this is a real test:
#  1. an OpenAPI spec or a hand-authored plan for Juice Shop's dynamic API
#  2. two user accounts + a documented login flow to obtain bearer tokens
#  3. a runtime.json template with those identities and a known order/basket fixture
#  4. invariants + differential-authorization checks over Juice Shop's BOLA-prone routes
```

`trinker compile` against the Juice Shop source tree would find little of value — the README
already says so.

### Known failures

1. `pnpm` unavailable — **every documented command fails as written**.
2. `trinker` not on `PATH` — must be invoked as `node packages/trinker/dist/cli.js`.
3. `trinker verify TRK-0000` (the command printed in every report) fails.
4. `run --ci --format markdown` silently yields JSON.
5. The live event stream drops `scan.started`, `phase.started`, `usage.updated`, and the first
   `check.started`.
6. `runtimeRef` bindings turn a check into a silent skip.
7. Router-mount prefixes produce **wrong** `pathTemplate` values labelled `confidence: "high"`.

---

## 9. Known issues / technical debt

Every item below was reproduced against the actual code. Ordered by severity.

### Critical

**I-1 · The repository is not under version control.**
No `.git`, no history, no branches, no remote. The entire architectural thesis rests on
`.trinker/plan.json` being a *committed, reviewed, diffable* artifact — and the tool's own source
is not committed. `.gitignore` is carefully written for a repo that does not exist. Any mistake is
unrecoverable.

**I-2 · Reported replay command is always wrong.**
`differential-authorization.ts:95` hard-codes `replay: { command: "trinker verify TRK-0000" }`.
`runner.ts:61` rewrites `finding.id` but not `finding.replay.command`. Every JSON, Markdown, and
SARIF report therefore instructs the user to run a command that fails. This breaks the
"every finding is mechanically replayable" guarantee at the point of delivery.

**I-3 · Event-subscription race drops the start of every scan.**
`runPlan()` (runner.ts:31) invokes `execute()` synchronously; `execute()` emits four events before
its first `await`. `workflow.runProject()` (workflow.ts:49–50) subscribes only after `runPlan()`
returns. Lost every time: `scan.started`, `phase.started`, `usage.updated`, the first
`check.started`, and the oracle's `phase.started`. Fix: defer the first emit past a microtask, or
have `runPlan` accept the listener up front, or buffer pre-subscription events in the bus.

### High

**I-4 · Unavailable oracles fail open and are indistinguishable from success.**
Four of five schema-supported oracles have no implementation. A plan of `state-mutation` checks
runs, skips everything, exits `0`, and reports zero findings. Plan coverage still counts those
routes as covered. A user could believe they have mutation coverage when nothing executed.

**I-5 · `runtimeRef` bindings are schema-valid but throw at execution.**
`differential-authorization.ts:20` throws; `runner.ts:67` catches every oracle exception and
converts it into a skip. A typo'd or unimplemented binding silently disables a security check.
More broadly: **the runner swallows all oracle exceptions as skips**, so a genuine oracle bug is
indistinguishable from a deliberate skip.

**I-6 · Surface extraction emits wrong paths at `confidence: "high"`.**
`router.get('/:id')` mounted at `app.use('/api/orders', router)` extracts as `/:id`. The extractor
has no cross-file or mount-point analysis, yet labels every route `"high"`. `confidence` is
currently a constant, not a measurement. Downstream, an invariant authored against a wrong
`pathTemplate` tests the wrong URL.

**I-7 · `.get('/…')` false positives.**
Any `.get()` call with a string argument starting with `/` becomes a route —
`cache.get('/api/secret')` was verified to produce `GET /api/secret`. The extractor never checks
whether the receiver is actually an Express/Fastify app or router.

**I-8 · Safety module has zero test coverage.**
`packages/core/src/safety.ts` implements every guarantee that keeps Trinker from hitting
unauthorized hosts or mutating state, and there is no `packages/core/test/safety.test.ts`. It was
verified manually for this handoff; it is not verified by CI (of which there is none).

### Medium

**I-9 · `ScanEventBus`'s async iterator never terminates.** The `for await` loop in
`events.ts:33-43` has no exit condition — nothing closes it on `scan.completed`. A consumer using
`handle.events` directly hangs forever. Only `subscribe()` is usable today; `AsyncIterable` is
advertised but a trap.

**I-10 · `--format markdown` is silently dropped in CI.** `cli.ts:19` reduces the format to
`sarif | json` with no validation and no warning. An unknown `--format xml` also yields JSON.

**I-11 · `verify` renumbers findings.** `verifyFinding` re-runs a one-check plan, so numbering
restarts — verifying `TRK-0003` produces a report about `TRK-0001`. It also never persists its
result, so `latest-report.json` goes stale after a verify.

**I-12 · Only `allowedTargetRefs[0]` is ever used.** Both `safety.ts:6` and the oracle read index
0. Additional entries are silently ignored, making the array misleading.

**I-13 · Three orphan packages.** `@trinker/compiler`, `@trinker/probes`, `@trinker/vitest` are
built, published in `exports`, and imported by nothing. `TokenBudget` has zero call sites.

**I-14 · `surface.discovered` is a phantom event type.** Declared in `ScanEventType`, never
emitted — `discoverSurface` runs during `compile`, which has no bus.

**I-15 · `lint` is a lie.** Every package's `lint` script is `tsc --noEmit`, byte-identical to
`typecheck`. No ESLint, no Prettier, no formatting enforcement.

**I-16 · No CI pipeline.** No `.github/`, no workflow of any kind. Nothing enforces that tests
pass.

**I-17 · Findings can carry up to 1000 bytes of raw response body.** `bodyPreview` is stored in
`latest-report.json` and every exported report. Header *names* are redacted, but the body
(potentially containing PII from the witness account) and the full **URL including query string**
(potentially containing tokens) are stored verbatim.

**I-18 · Report files collide.** `writeReport` names files `YYYY-MM-DD-security-report.<ext>` —
the second scan on a given day overwrites the first with no warning.

**I-19 · SARIF has no `locations`.** Findings cannot be anchored to a file/line, so GitHub code
scanning cannot annotate a PR. `sourceRefs` exist on routes and would supply exactly this.

### Low

- **I-20** · `FetchHttpClient` has no timeout, retry, concurrency cap, or rate limit — a scan can
  hammer a target, and a hung request hangs the scan forever.
- **I-21** · `FetchHttpClient` `JSON.stringify`s a body but never sets `content-type`.
- **I-22** · The oracle never sends `request.body`; `requestFor()` returns only method/url/headers,
  so `RequestTemplateSchema.body` is inert.
- **I-23** · `coverage.percent` is `0` for an empty in-scope set (should arguably be 100).
- **I-24** · Dead parameter: `extractRoutesFromSource`'s inner `add()` takes `framework` and
  discards it with `void framework` (surface.ts:37).
- **I-25** · TUI "View Latest Report" and "View Findings" are the same code path with a different
  heading.
- **I-26** · Finding severity is hard-coded `high`; there is no severity policy or mapping.
- **I-27** · `identity.roles`, `identity.capabilities`, `fixture.ownerIdentityId`,
  `fixture.resourceId`, and `invariant.resourceId` are accepted and stored but read by nothing.
- **I-28** · `handle.result` is created eagerly; if a caller subscribes to events without awaiting
  `result`, a safety-gate rejection becomes an unhandled promise rejection.
- **I-29** · `schemaVersion` is `z.literal(1)` with no migration path.
- **I-30** · The root `.trinker/` directory exists but is empty — Trinker has never been run
  against its own repository.

---

## 10. Environment

| | |
|---|---|
| **OS** | Linux 7.1.8-arch1-3 (Arch), x86_64 |
| **Node** | **v26.7.0** installed · `engines` requires `>=20` ✅ |
| **Package manager** | `packageManager: "pnpm@10.19.0"` · ⚠️ **`pnpm` NOT on PATH**; `corepack` NOT installed; `npm` + `npx` available at `/usr/bin` |
| **Install state** | ✅ populated — `node_modules/.pnpm/` present, workspace symlinks intact, `pnpm-lock.yaml` committed (49 KB) |
| **Module system** | ESM everywhere (`"type": "module"`), TS `module`/`moduleResolution`: `NodeNext` |
| **Build tooling** | `tsup` 8.5.1 (esbuild) → ESM + `.d.ts`; TypeScript 5.9.3 (declared `^5.8.3`) |
| **Test tooling** | Vitest 3.2.7 (declared `^3.1.2`); root `vitest.config.ts` maps `@trinker/*` → `src`; four packages re-export it |
| **Type config** | `strict`, `declaration`, `declarationMap`, `sourceMap`, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, target ES2022 |
| **Runtime deps** | `zod` 3.25.76 (declared `^3.24.3`) and `typescript` (used as a *runtime* library by `@trinker/surface` for AST parsing). Nothing else. **No HTTP library** — global `fetch`. **No LLM SDK.** |
| **Docker** | ✅ `/usr/bin/docker` 29.7.2 + `/usr/bin/docker-compose`; `examples/juice-shop/docker-compose.yml` validates. Juice Shop image **not pulled**. |
| **Linter / formatter** | None. |
| **CI** | None. |

### Setup problems encountered

1. **`pnpm` missing** — the single biggest friction point. Install with
   `npm i -g pnpm@10.19.0`, or enable `corepack`, or use `npx pnpm@10.19.0 <cmd>`. Until then use
   `./node_modules/.bin/{vitest,tsc,tsup}` directly.
2. **`trinker` not linked** — invoke as `node packages/trinker/dist/cli.js`. A future
   `pnpm link --global` (or `npm link` in `packages/trinker`) would fix this.
3. **Not a git repository** — see I-1.
4. Vitest must be run **from the repo root** (or from one of the four packages that re-export the
   root config). `packages/core`, `compiler`, `probes`, and `vitest` have no `vitest.config.ts`, so
   running Vitest from inside `packages/core` would lose the `@trinker/*` aliases.

---

## 11. Important files

| File | Why it matters |
|---|---|
| **`packages/core/src/schema.ts`** (167 L) | **The single most important file.** Every contract: `PlanSchema`, `CheckSchema` union, `RuntimeConfigSchema`, cross-reference `superRefine`, and `containsInlineSecret()`. Change this and you change the product. |
| **`packages/core/src/safety.ts`** (28 L) | Every safety guarantee: host allowlist, method allowlist, double mutation gate. Small, critical, **untested**. |
| **`packages/core/src/runner.ts`** (73 L) | The deterministic scheduler. Oracle registry lookup, check ordering, finding-id assignment, token counters pinned to zero. Contains the event race (I-3) and the exception-swallowing skip (I-5). |
| **`packages/core/src/events.ts`** (44 L) | The typed event model and `ScanEventBus`. Core-owned `sequence`, injectable clock, non-terminating async iterator (I-9). |
| **`packages/core/src/findings.ts`** (36 L) | `FindingSchema` with `status: z.literal("confirmed")` — makes an unconfirmed finding unrepresentable. `ScanResult` shape. |
| **`packages/oracles/src/differential-authorization.ts`** (103 L) | The only working oracle, and the reference implementation for every future one: witness acquisition → calibration → exact-match confirmation → redacted evidence. Also holds the `TRK-0000` replay bug (I-2). |
| **`packages/surface/src/index.ts`** (147 L) | AST extraction, OpenAPI ingestion, resource inference, deterministic digest. Source of the extraction limitations (I-6, I-7). |
| **`packages/trinker/src/workflow.ts`** (75 L) | The **only** filesystem adapter. Owns `.trinker/` paths and the oracle registry (line 49 — where new oracles get wired in). |
| **`packages/trinker/src/cli.ts`** (27 L) | Command dispatch and exit-code policy (0 clean / 1 findings / 2 error). Holds the format bug (I-10). |
| **`packages/trinker/src/tui.ts`** (68 L) | The whole interactive shell. |
| **`packages/report/src/index.ts`** (61 L) | JSON / Markdown / SARIF renderers and file emission. |
| **`packages/core/src/coverage.ts`** (9 L) | Plan coverage math. |
| **`packages/compiler/src/index.ts`** (14 L) | The **reserved LLM boundary**. `TokenBudget` is the enforcement point a future provider must call. Currently orphaned. |
| **`docs/ARCHITECTURE.md`** | Accurate and honest — including about execution coverage not being persisted. |
| **`docs/PLAN_AUTHORING.md`** | The hand-authoring reference. Its example route id was verified byte-identical to compiler output. |
| **`examples/juice-shop/README.md`** | Honest about the compiler's inability to reach Juice Shop's dynamic API. |
| **`.gitignore`** | Encodes the central secret boundary: `plan.json` committed, `runtime.json` / reports / events / cache ignored. |
| **`tsconfig.base.json`** | Strictness settings + the `@trinker/*` → `src` path aliases. |
| **`vitest.config.ts`** (root) | The alias map that makes cross-package tests work. Four packages re-export it. |

---

## 12. Exact next steps

### P0 — must do next

**P0-1 · Put the repository under version control.** *(blocks everything; ~5 min)*
```bash
cd /home/paardhu/Projects/trinker
git init && git add -A && git commit -m "Initial commit: Trinker deterministic AST framework MVP"
```
The whole architecture depends on committed, reviewable artifacts. Do this **before** any code
change so the next agent has a diff to reason about. Verify `.trinker/plan.json` is *not* ignored
while `.trinker/runtime.json` *is*.

**P0-2 · Fix the replay command (I-2).** *(~15 min, high user-visible impact)*
Move `replay.command` construction into `runner.ts` where the id is assigned:
```ts
const id = `TRK-${String(findings.length + 1).padStart(4, "0")}`;
const finding = { ...outcome.finding, id, replay: { ...outcome.finding.replay, command: `trinker verify ${id}` } };
```
Add a regression test asserting `finding.replay.command` contains `finding.id`. This restores the
"every finding is replayable" guarantee.

**P0-3 · Fix the event-subscription race (I-3).** *(~30 min)*
Add a `listener` option to `RunOptions` (subscribed before `execute()` is called), **or** buffer
events in `ScanEventBus` until the first subscriber attaches, **or** `await Promise.resolve()` at
the top of `execute()`. Add a test asserting a subscriber added via `runPlan` receives
`scan.started` as `sequence: 1`. The typed event model is a core thesis; it currently lies to
every consumer.

**P0-4 · Make the documented commands work.** *(~10 min)*
Install `pnpm@10.19.0` (or corepack), then verify `pnpm install && pnpm build && pnpm test &&
pnpm typecheck` all succeed. If pnpm is intentionally unavailable, update `README.md` and this
document with the real commands instead. Also link the CLI so `trinker` resolves on `PATH`.

**P0-5 · Test the safety module (I-8).** *(~45 min)*
Create `packages/core/test/safety.test.ts` covering all five gates: non-local host blocked,
allowlisted host permitted, unknown target ref, method not in `allowedMethods`, write under
`forbid`, write without `mutationAuthorized`, unknown route reference. These are the guarantees
that keep Trinker legal; they must not regress silently.

### P1 — important

**P1-1 · Make unavailable oracles loud, not silent (I-4).** An enabled check whose oracle is not
registered should either fail the run (non-zero exit) or be surfaced as a prominent warning in
every report format. Separate "deliberately skipped" from "could not run" in `ScanResult`.

**P1-2 · Implement the state-mutation oracle.** Its schema (`readRequest` + `protectedPaths`) is
already complete, and it is the highest-value second oracle: read → attempt unauthorized write →
read again → confirm only if a protected path actually changed. Requires wiring
`request.body` through `requestFor()` (I-22) and respecting both mutation gates.

**P1-3 · Implement `runtimeRef` bindings (I-5), or remove them from the schema.** A schema-valid
construct that throws at execution is worse than no construct. While there, stop swallowing oracle
exceptions as skips — surface them as a distinct `check.errored` outcome.

**P1-4 · Fix surface extraction correctness (I-6, I-7).** Track `app.use(prefix, router)` mount
points; require the receiver to be a plausible app/router (or downgrade `confidence` to `"low"`
when it cannot be established); support template literals without substitutions; walk the full
`.route().get().post()` chain. **Never emit `confidence: "high"` for a path that was not fully
resolved** — a wrong path silently tests the wrong URL.

**P1-5 · Fix `--format markdown` in CI (I-10).** Accept `json|markdown|sarif`, validate the value,
and error clearly on an unknown format.

**P1-6 · Add a CI workflow (I-16).** `.github/workflows/ci.yml` running install → typecheck →
test → build on push and PR. Then add a real linter and make `lint` mean something (I-15).

**P1-7 · Build the Juice Shop end-to-end evaluation.** A committed `examples/juice-shop/plan.json`
plus a `runtime.template.json` and documented login flow. This is the first real proof the tool
works outside a synthetic fixture, and it will surface a great deal of the debt above.

**P1-8 · Add SARIF `locations` (I-19)** from `route.sourceRefs`, so findings annotate PRs.

**P1-9 · TUI event rendering (see §6).** Human-readable lines instead of raw JSON, plus a finding
detail view that actually shows the evidence.

### P2 — later

- **P2-1** Metamorphic-response oracle (schema already exists).
- **P2-2** LLM compiler integration behind `compile --mode llm-assisted`, wired through
  `TokenBudget`, emitting `provenance.compiler.mode: "llm-assisted"` and
  `invariant.provenance: "llm-assisted"`. **Must never touch the run path.**
- **P2-3** Crawler / HAR / proxy ingestion (`SourceReferenceSchema.kind` already reserves
  `"crawler"`) to reach dynamic APIs.
- **P2-4** OOB collector + `out-of-band` oracle (`@trinker/probes`).
- **P2-5** Browser-execution oracle (`browser-execution`) for XSS/DOM.
- **P2-6** `@trinker/vitest` assertion API for consumers.
- **P2-7** Execution coverage persisted separately from plan coverage (I-4 adjacent).
- **P2-8** HTTP client hardening: timeout, concurrency cap, rate limit, redirect policy (I-20).
- **P2-9** Evidence redaction for URLs and bodies, with a configurable preview policy (I-17).
- **P2-10** Baseline / triage / suppression so known-accepted findings don't fail CI.
- **P2-11** Multi-target support (I-12); severity policy (I-26); RBAC matrix from
  `identity.roles` (I-27); timestamped report filenames (I-18); plan migration for
  `schemaVersion: 2` (I-29).
- **P2-12** Decide the fate of the three orphan packages (I-13) — wire them in or delete them.

---

## 13. Design decisions that MUST NOT be accidentally reversed

These are the load-bearing invariants of the product. Each is currently upheld in code. **Breaking
any of them silently destroys the product's reason to exist.**

**13.1 · `trinker run` is zero-LLM by default.**
Enforced today by *absence*: no provider SDK is a dependency of any package, and `ScanResult.tokens`
is hard-coded to all zeros in `runner.ts`. `@trinker/compiler` is the *only* sanctioned LLM
boundary, and even it contains no client. **Never add an LLM dependency to `@trinker/core`,
`@trinker/oracles`, or `@trinker/report`.** The zero-token property is asserted by the oracle test
(`expect(result.tokens.runtimeInput).toBe(0)`) — keep that assertion.

**13.2 · Runtime LLM use must be explicit opt-in.**
If a runtime LLM path is ever added, it must require an explicit flag, be off by default, be
visible in every report, and be reflected in real (non-zero) token counters. A default-on runtime
model call would make scans non-deterministic, non-reproducible, and expensive — the three things
Trinker exists to avoid.

**13.3 · Confirmed findings require mechanical evidence.**
`FindingSchema.status` is `z.literal("confirmed")` — an unconfirmed finding is **unrepresentable**.
Confirmation currently requires status equality **and** `sha256` body equality. **Do not relax this
to similarity scoring, thresholds, or heuristics.** "Denied identity got an unexpected 2xx with
different bytes" must stay `skipped`/inconclusive. High precision over high recall is the
deliberate trade.

**13.4 · Credentials must never enter the committed plan.**
`.gitignore` commits `plan.json` and ignores `runtime.json`. `containsInlineSecret()` rejects
credential-like keys in the plan, and `.strict()` rejects unknown fields everywhere. Identities
and fixtures reference runtime values by **key only** (`credentialRef`, `runtimeRef`).
**Never add a field to `PlanSchema` that could hold a URL, token, cookie, or password.** Note that
`target.applicationId` is a logical name, *not* a URL — keep it that way.

**13.5 · Core must remain decoupled from terminal rendering.**
`@trinker/core` imports only `zod`, `node:crypto`, and `node:events`. It knows nothing of the
terminal, `.trinker/` paths, or the CLI. All security decisions live in core or an oracle; the CLI
and TUI make none. **Never import a rendering or filesystem-layout concern into core**, and never
move a security decision out of it. `workflow.ts` is the single filesystem adapter — keep it that
way.

**13.6 · CI must remain non-interactive.**
`--ci` must never require a TTY, never enter raw mode, never prompt. Exit-code policy is the
contract: **0** = clean, **1** = findings confirmed, **2** = error. The TUI's TTY guard exists
precisely so interactive code can never leak into automation.

**13.7 · Deterministic reruns consume zero runtime LLM tokens.**
Content-addressed `planId` and `surfaceDigest`, sorted-and-deduped routes, `check.id`-ordered
execution, an injectable clock, and byte-exact response comparison exist to make the same plan
against the same target produce the same result. **Do not introduce randomness, wall-clock
dependence, unordered iteration, or map-iteration-order dependence** into plan generation or check
execution.

**13.8 · `compile` invents no security claims.**
`compileProject` emits empty `identities`/`fixtures`/`invariants`/`checks` and the most
conservative safety policy (`mutationPolicy: "forbid"`, GET/HEAD/OPTIONS only). Asserted by
`workflow.test.ts` (`expect(plan.checks).toEqual([])`). Authorization rules are a human (or, later,
an explicitly-invoked LLM) decision — **the deterministic compiler must never guess one.**

**13.9 · Safety gates are hard aborts, never warnings.**
Host allowlist, method allowlist, and the **double** mutation gate (plan policy **AND**
`runtime.mutationAuthorized`) all throw and abort the scan before any HTTP request. Localhost is
the only implicit allowance. **Never downgrade a gate to a warning, and never let the plan alone
authorize a write** — requiring local, uncommitted opt-in for mutations is what keeps a committed
plan safe to merge.

---

## STOPPING POINT

### What the previous session (Codex) actually completed — verified

A **working, coherent, genuinely deterministic MVP skeleton**. This is not scaffolding; the
central thesis was verified working end-to-end in this session against a live vulnerable server,
producing a real CONFIRMED BOLA finding with redacted evidence and zero LLM tokens.

Concretely completed and verified:
- 8-package pnpm ESM monorepo; **typecheck clean** across all 8; **build working**; **9/9 tests
  passing**.
- `@trinker/core`: complete strict Zod contracts (plan + runtime + findings), five safety gates,
  a deterministic scheduler, a typed 12-event bus with core-owned sequencing, coverage math.
- `@trinker/surface`: real TypeScript-AST route extraction (Express + Fastify shapes), OpenAPI
  object ingestion, resource inference, deterministic digest.
- `@trinker/oracles`: the differential-authorization oracle — calibration-based, exact-match,
  deliberately conservative, with redacted witness evidence. **Verified against a live target.**
- `@trinker/report`: JSON, Markdown, and SARIF 2.1.0 renderers + file emission.
- `trinker` CLI: `init`, `compile`, `coverage`, `run`, `run --ci`, `verify`, `report` — **all
  verified working** — plus a keyboard-driven 8-item TUI with a live event feed.
- Secret boundary enforced in code and in `.gitignore`; verified by deliberate violation.
- `docs/ARCHITECTURE.md`, `docs/PLAN_AUTHORING.md`, `README.md`, and the Juice Shop example — all
  **accurate and honest about their own gaps** (the PLAN_AUTHORING example route id was verified
  byte-identical to real compiler output).

### What Codex left deliberately unimplemented

LLM provider integration (boundary reserved in `@trinker/compiler`, no client), four of five
oracles (`state-mutation`, `metamorphic-response`, `browser-execution`, `out-of-band` — all
schema-complete, none registered), OOB collector, browser driver, crawler/HAR ingestion, the
`@trinker/vitest` consumer API, and a Juice Shop plan. These are all *coherent* deferrals: the
schema reserves space for each without pretending they work.

### What it appears to have been about to do next

The evidence points at the Juice Shop evaluation. `examples/juice-shop/` was created with a valid
compose file and a README that ends by naming exactly what is missing — *"Juice Shop's dynamic API
requires a reviewed hand-written plan or a future OpenAPI/crawler input"* — and no plan was
authored. The root `.trinker/` directory is **empty**, so Trinker has never been run against its
own repository either.

Two clues suggest the session ended mid-polish rather than at a clean boundary: the `TRK-0000`
replay placeholder was never reconciled with the runner's id assignment, and the event stream was
never observed end-to-end (the subscription race would have been obvious on first watch).

### What the next agent should do first

**Start with P0-1: `git init` and commit.** The repository has no version control, and every
subsequent change should be a reviewable diff. This takes five minutes and de-risks everything
after it.

**Then P0-2 and P0-3, in that order** — the `TRK-0000` replay bug and the event-subscription race.
Both are small, both are localized to `runner.ts` (plus one line in the oracle), both have obvious
regression tests, and both currently break a *stated* product guarantee: findings are replayable,
and the event model is complete. Fixing them restores the MVP's integrity before any new surface
area is added.

**Do not start a new oracle, and do not start LLM integration, until P0 is closed.** The schema
already reserves space for both; the working parts are what currently have defects.
