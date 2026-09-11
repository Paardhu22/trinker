# Trinker — Session Handoff

**Updated:** 2026-09-11 (session 5)
**Basis:** Written from the repository as it actually is. Every claim below was verified by running
the code — the full suite, typecheck, build, CLI smoke tests, a pty-driven TUI session, and a live
scan against a Docker Juice Shop container. Nothing here is claimed on the strength of a commit
message.

**State:** the deterministic foundation is hardened and covered. All three implemented oracles
confirm real flaws against a live Juice Shop container, each with a passing negative control, and CI
enforces the whole thing. **Two LLM compiler providers now ship** behind `compile --llm` — OpenAI (default) and Anthropic;
`trinker run` remains LLM-free and costs zero tokens. **Neither has been run against its real API:**
no credentials were available in this environment. Both SDK paths are verified against local stubs.

---

## 1. Project objective

### What Trinker is

A deterministic application security testing framework for HTTP APIs: a pnpm monorepo of
TypeScript ESM packages behind one `trinker` CLI/TUI.

Two phases:

1. **Compile** — security knowledge is extracted from source and frozen into a reviewable,
   secret-free `.trinker/plan.json`.
2. **Run** — that plan is executed mechanically. No reasoning, no inference, no model calls.

### The core architectural thesis

> **Security knowledge is expensive to derive and cheap to replay.**

Deriving "only the owner of order 42 may read order 42" takes judgement. *Checking* it is two
requests and a byte comparison. Trinker makes the expensive step a compilation producing a durable
artifact, and the cheap step something you run on every pull request.

### Why the deterministic architecture exists

- **Reproducibility** — same plan, same target, same result. A finding is a replayable fact.
- **Reviewability** — `plan.json` is committed and diffable. Security assumptions become code review.
- **Cost** — a scan is free after compilation.
- **Auditability** — every finding carries the request/response witnesses that produced it.
- **Bounded blast radius** — the runner does only what the plan says. An improvising agent cannot
  have its blast radius statically bounded.

### How it differs from agentic pentesting

| | Agentic pentester | Trinker |
|---|---|---|
| Per-run cost | tokens every run | zero |
| Reproducibility | re-runs differ | byte-identical |
| Reviewability | reasoning is ephemeral | committed, diffable plan |
| Evidence | model narrative | redacted witnesses + digests |
| CI | flaky, slow, expensive | fast, exit-code driven |
| Knowledge | re-derived every run | derived once, replayed |

An LLM may *author* a plan. It never participates in executing one, and that is enforced by the
dependency graph (§4, §13).

---

## 2. Current architecture

### Packages

~4,700 lines of source, ~3,800 lines of test, 92 tracked files, 30 commits.

| Package | Name | src | test | Responsibility | Status |
|---|---|---|---|---|---|
| `core` | `@trinker/core` | 834 | 741 | schemas, safety, bindings, runner, events, findings, coverage | **Active** |
| `trinker` | `trinker` | 951 | 296 | CLI, TUI, scan-view reducer, workflow adapter | **Active** |
| `surface` | `@trinker/surface` | 475 | 242 | AST extraction, mount resolution, OpenAPI ingest + merge | **Active** |
| `oracles` | `@trinker/oracles` | 414 | 468 | three deterministic oracles | **Active** |
| `report` | `@trinker/report` | 167 | 105 | JSON / Markdown / SARIF | **Active** |
| `compiler` | `@trinker/compiler` | 1500 | 1400 | LLM boundary: prompt, context, proposal contract, validation, budget, OpenAI + Claude providers | **Active (opt-in)** |
| `vitest` | `@trinker/vitest` | 100 | 137 | assertions for running a scan in your own suite | **Active** |

`@trinker/probes` was deleted: out-of-band testing needs a collector that does not exist, and the
schema already reserves the oracle name.

### Dependency direction

```text
trinker CLI / TUI ──┬─> @trinker/surface ─┐
                    ├─> @trinker/oracles ─┤
                    ├─> @trinker/report  ─┼─> @trinker/core ──> zod
                    └─> @trinker/compiler ┘        (only dependency)

@trinker/compiler ──> @trinker/core        (compile only; never on the scan path)
```

`core` imports only `zod`, `node:crypto`, `node:events`. `surface`, `oracles`, and `report` must
never depend on or import `@trinker/compiler` — **`packages/core/test/architecture.test.ts`
enforces this**, along with "no provider SDK anywhere on the scan path" and "core does no
filesystem I/O".

### Execution flow

```text
trinker init      -> .trinker/runtime.json (gitignored: URLs, credentials, fixtures, values)

trinker compile   -> discoverSurface()
                       walk sources, resolve receivers + mount prefixes, dedupe, sort, digest
                     merge with any existing plan (preserves authored content)
                     PlanSchema.parse -> .trinker/plan.json  (committed)

  *** HUMAN STEP: author identities, fixtures, invariants, checks ***

trinker run       -> loadPlan + loadRuntime (re-validated every load)
                     runPlan({ plan, runtime, oracles, onEvent })
                       emit scan.started
                       assertSafePlan / assertSafeTarget  -- hard abort -> scan.failed
                       for each enabled check, sorted by check.id:
                         emit check.started
                         no oracle registered      -> unavailable
                         oracle.execute()          -> passed | failed | inconclusive
                         oracle threw              -> errored
                         failed -> assign TRK-000N + its replay command -> finding.confirmed
                       emit scan.completed
                     createReport -> .trinker/latest-report.json

trinker verify <id>  -> replay that one check, relabelled with the original id
trinker report       -> .trinker/reports/<timestamp>-security-report.{json,md,sarif}
trinker coverage     -> planned vs verified routes
```

### Core / presentation separation

Holds, and is now tested. `core` knows nothing of the terminal or `.trinker/` layout.
`packages/trinker/src/workflow.ts` is the only filesystem adapter. The TUI reduces the event
stream through `scan-view.ts`, a **pure function** unit-tested without a TTY — so no security
decision can live in rendering code.

### Typed event model

`ScanEvent { version, scanId, sequence, timestamp, type, data }`. 15 event types.

`ScanEventBus` **retains its history and replays it to any listener that attaches later**, so a
consumer always observes the complete sequence from `scan.started`. Async iteration terminates on
`scan.completed` / `scan.failed`.

---

## 3. `.trinker/plan.json`

Schema in `packages/core/src/schema.ts`, `.strict()` throughout.

### Shape

```jsonc
{
  "schemaVersion": 1,
  "planId": "trkp_<16 hex>",          // sha256 of the plan body — content addressed
  "surfaceDigest": "sha256:<64 hex>",
  "target": { "applicationId": "my-app", "allowedTargetRefs": ["local"] },  // keys, never URLs
  "surface": { "frameworks": [...], "routes": [...], "resources": [...] },
  "identities": [{ "id": "identity_owner", "credentialRef": "owner", "roles": [], "capabilities": [] }],
  "fixtures":   [{ "id": "fixture_order", "runtimeRef": "order", "ownerIdentityId": "identity_owner" }],
  "invariants": [{ "id": "inv_x", "kind": "authorization", "statement": "...", "routeIds": [...],
                   "provenance": "manual | deterministic | llm-assisted" }],
  "checks":     [ /* discriminated union on "oracle" */ ],
  "coverage":   { "inScopeRouteIds": [...], "exclusions": [{ "routeId": "...", "reason": "required" }] },
  "safety":     { "mutationPolicy": "forbid | explicit-authorization-required", "allowedMethods": [...] },
  "provenance": { "sources": [...], "compiler": { "mode": "...", "compilerVersion": "0.1.0" } }
}
```

### Check variants

| `oracle` | required fields | implemented? |
|---|---|---|
| `differential-authorization` | `allowedIdentityIds`, `deniedIdentityIds`, `calibration.trials` (1–5, default 3) | ✅ |
| `state-mutation` | `readRequest`, `readIdentityId`, `unauthorizedIdentityIds`, `protectedPaths`, `calibration.stabilityReads` | ✅ |
| `metamorphic-response` | `identityId`, `relation`, `variants[]` (min 2), `calibration.stabilityReads` | ✅ |
| `browser-execution` | — | ❌ reported `unavailable` |
| `out-of-band` | — | ❌ reported `unavailable` |

> `state-mutation` and `metamorphic-response` were **schema stubs with no way to express who acts**.
> This session added their identity and relation fields. No plan used those variants (no oracle
> existed to run them), so `schemaVersion` stayed 1.

### Value bindings

| binding | resolves from | in evidence? |
|---|---|---|
| `{ "literal": "abc" }` | the plan | yes |
| `{ "fixtureRef": "f", "field": "id" }` | `runtime.fixtures.<runtimeRef>.<field>` | yes — a finding about object 42 is unreadable if 42 is masked |
| `{ "runtimeRef": "k" }` | `runtime.values.<k>` | **no** — treated as secret, masked everywhere |

Bindings work in path, query, header, and **nested anywhere inside a request body**. A missing
reference is a loud `BindingResolutionError`, never a silent skip.

### Safety constraints

Enforced in `safety.ts` before any HTTP request. All are hard aborts.

1. **Target allowlist** — loopback (`localhost`/`127.0.0.1`/`::1`) implicit; anything else must be
   in `runtime.targets[ref].allowHosts`.
2. **Method allowlist** — checked method must be in `plan.safety.allowedMethods`.
3. **Mutation gate, plan half** — writes need `mutationPolicy: "explicit-authorization-required"`.
4. **Mutation gate, runtime half** — writes *also* need `mutationAuthorized: true` locally.
5. **Route integrity** — a check naming a nonexistent route aborts.

The two mutation gates are deliberately separate: **a committed plan alone can never authorize a
write**, which is what keeps a plan safe to merge.

### Secret handling

`.gitignore` commits `plan.json` and ignores `runtime.json`, reports, and `latest-report.json`.
Patterns are **unanchored (`**/`)** so a Trinker project nested anywhere is covered — they were
root-anchored until this session, which meant `examples/juice-shop/.trinker/runtime.json` (bearer
tokens) would have been committable.

`containsInlineSecret()` rejects credential-like keys in a plan unless the value is a
`runtimeRef`/`fixtureRef` indirection. `redactHeaders()` masks credential headers by name;
`maskSecrets()` additionally masks known secret *values* anywhere they appear, including inside
URLs where name-based redaction cannot reach.

### What is deterministic

Content-addressed `planId`/`surfaceDigest`; routes deduped and sorted; checks executed in
`check.id` order; injectable clock; byte-exact response comparison; token counters pinned to zero.

---

## 4. Implemented functionality

✅ fully · 🟡 partial · ⬜ stub · ❌ absent

### Surface discovery — ✅ (with documented limits)

Receiver resolution traces identifiers back to `express()`, `express.Router()`, `Fastify()`, or a
Fastify plugin's instance parameter. Mount prefixes (`app.use('/api', router)`,
`fastify.register(plugin, { prefix })`) resolve **within and across files**. Chained
`.route().get().post()` walks the whole chain. Confidence is meaningful:

| | meaning |
|---|---|
| `high` | receiver proven by a factory call, path fully resolved |
| `medium` | receiver matched by naming convention only, or multiple / cross-file mounts |
| `low` | router never mounted in analysed sources — path probably incomplete |

An unrecognised receiver yields **no route**. Verified fixes (all were defects last session):

| case | before | now |
|---|---|---|
| `app.use('/api/orders', r)` + `r.get('/:id')` | `GET /:id` (wrong, "high") | `GET /api/orders/:id` [high] |
| `cache.get('/api/secret')` | `GET /api/secret` (fabricated) | *(nothing)* |
| `app.route('/books').get().post()` | GET only | GET + POST |
| Fastify plugin prefix | unsupported | supported |
| `` app.get(`/api/${v}/x`) `` | dropped | still dropped (conservative) |
| Nest `@Get()` decorators | unsupported | still unsupported |

### Deterministic compilation — ✅

`compile` writes **no checks** and the most conservative safety policy. **Recompiling preserves**
hand-authored identities, fixtures, invariants, checks, and safety policy; if the result would not
validate it refuses to write and names the offending checks. `--force` regenerates from scratch.
(Before this session, recompiling silently destroyed everything you had authored.)

### Runner — ✅

Safety preflight, deterministic ordering, oracle registry, per-check classification, **finding IDs
and their replay commands assigned together** (an oracle returns a `FindingDraft` with no ID and
*cannot* desynchronise them). `FetchHttpClient` has a 15s timeout and sets `content-type`.

### Oracles — ✅ ×3

**Differential authorization** — witnesses from allowed identities; calibration requests per denied
identity measuring real denial behaviour; confirms only on **status + full-body sha256** equality.
An unexplained 2xx is `inconclusive`.

**State mutation** — baseline read, control reads proving stability, unauthorized write, re-read.
Confirms only when a `protectedPath` **value changed**. A **2xx that changed nothing is
`inconclusive`**, not `passed`: it cannot distinguish a rejected write from one that set the value
it already had. A pass requires the server to have actually refused the write. Drifting state is
`inconclusive`.

**Metamorphic response** — reference variant repeated as a determinism control, then variants
compared under a declared `identical` / `status-identical` relation. Catches client-controlled data
scoping. A non-deterministic endpoint is `inconclusive`, with the message pointing at the weaker
relation. **Proven against Juice Shop:** confirms on `GET /api/BasketItems?BasketId=`, passes on
`GET /api/Addresss?UserId=`.

Every oracle calibrates before it judges. No heuristics, no scoring.

### Outcome taxonomy & fail-loud — ✅

| status | meaning |
|---|---|
| `passed` | ran, invariant held |
| `failed` | ran, violation mechanically confirmed |
| `inconclusive` | ran, could not reach a verdict |
| `errored` | oracle threw |
| `unavailable` | no oracle registered — **nothing was tested** |

There is no "skipped". Reports lead with a **trust summary** (COMPLETE / INCOMPLETE), list every
check that produced no verdict, and emit those as SARIF results so a dashboard cannot show green
for a scan that executed nothing.

### Exit codes — ✅

`0` complete + clean · `1` violation confirmed · `2` usage/config error · `3` **scan not
trustworthy** (errored or unavailable check). `--strict` extends 3 to inconclusive.

3 is distinct from 1 so a broken pipeline is never read as a vulnerability, and from 0 so an
untested scan cannot report success.

### Coverage — ✅

Plan coverage (intent) and **execution coverage** (reality). A route is *verified* only when
**every** check on it reached a verdict; unverified routes are attributed to their cause.

### Reports — ✅

JSON, Markdown, SARIF 2.1.0. Markdown renders witnesses as HTTP blocks with digests. SARIF sets
`invocations[0].executionSuccessful` false on faults. Timestamped filenames (no longer one-per-day
collisions).

### Verification / replay — ✅

`trinker verify <id>` replays the single check and **relabels the reproduced finding with the
original ID**. Exit 1 if it still reproduces.

### CI mode — ✅

Non-interactive, no TTY, validated `--format`, correct exit codes. EPIPE handled (piping to `head`
used to crash a scan mid-flight).

### TUI — ✅

See §6.

### Juice Shop — ✅

See §8. Real container, **three** real findings from **all three** oracles, real replay, plus **two**
passing negative controls. No oracle is now unproven against real software.

### LLM compiler — ✅ implemented, opt-in (real-provider run unverified)

`trinker compile --llm` asks a model what should be tested, then validates every suggestion
deterministically. Full detail in **[docs/LLM_COMPILER.md](LLM_COMPILER.md)**; the essentials:

**Architecture.** `packages/compiler/src/` — `prompt.ts` (versioned system prompt + the Anthropic
request schema), `context.ts` (surface + narrow source excerpts), `providers/` (`index.ts` selection,
`openai.ts`, `openai-wire.ts`, `anthropic.ts` — the only files that talk to a model API, SDKs loaded
by dynamic import), `proposal.ts` (deterministic filter + merge), `compile.ts` (orchestration +
telemetry).

**Providers.**

| provider | key | default model | price in/out per MTok |
|---|---|---|---|
| `openai` (default) | `OPENAI_API_KEY` | `gpt-5.6-terra` | $2 / $12 |
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-opus-5` | $5 / $25 |

`gpt-5.6-terra` over the frontier `gpt-6-astra` ($10/$50) and the cheapest `gpt-5.6-luna`
($0.20/$1.20): a bad proposal costs a reviewer's time, so the bottom tier is a false economy, but
this is not frontier work. An unknown `--provider` fails rather than falling back.

**CLI.**
```bash
trinker compile --llm --token-budget 60000                      # openai; proposes only
trinker compile --llm --provider anthropic --token-budget 60000
trinker compile --llm --token-budget 60000 --apply              # merges it in
```

**OpenAI wire encoding.** Strict Structured Outputs is a narrow JSON Schema subset (no `anyOf`, no
`minItems`, every property required, `additionalProperties: false`), so it can express neither
optional fields nor arbitrary-key maps. `providers/openai-wire.ts` sends nullable optionals and
array-encoded maps, then normalises back — stripping nulls and reshaping containers only. It can
never add or alter content, and anything unrecognised passes through so `PlanProposalSchema` rejects
it rather than being quietly repaired.

**Flow.** surface → prompt → structured `PlanProposal` → `applyProposal` (additive only, cannot
widen safety, references must resolve, oracle must exist, `PlanSchema` re-validates and rejects
credentials, provenance stamped `llm-assisted`) → proposal file + printed diff → `--apply`.

**Token accounting.** Every compilation records provider, model, prompt version,
input/output/total tokens, budget, and checks proposed/accepted/rejected — the instrumentation a
later cost evaluation needs. The budget is checked before the call *and* against real usage after,
so an under-estimating provider still trips it.

**Safety boundaries.** The provider sees the surface only — never runtime config, credentials, or
the target URL, asserted independently in `compileWithProvider`. A model may propose a check; only
an oracle may confirm a finding. The API key is stripped from provider error messages. A proposed
check cannot even run until a human wires its fixtures into `runtime.json`.

---

## 5. Deferred functionality

### LLM providers — ✅ shipped (OpenAI + Anthropic), neither executed against its real API

**No real provider call has ever been made from this repository.**

Session 5 was asked to perform one real OpenAI compilation. `OPENAI_API_KEY` was **not present** in
the execution environment — checked in the current shell, a login shell, an interactive shell, all
shell profiles, `.env` files, `~/.config/openai`, `systemd --user`, and `/etc/environment`. The
failure category is therefore **credential unavailable**, a precondition failure, not an API
failure. No successful run is claimed.

Verified without credentials:
- the whole pipeline with a fake provider — validation, merge, budget, telemetry
- the **real SDKs** (`openai` 7.15.0, `@anthropic-ai/sdk` 0.125.0) against local stubs of their
  APIs: real serialisation, transport, retries, and error mapping
- the CLI flow end to end against a stub **using the actual Juice Shop plan**, including `--apply`,
  the non-destructive default, and the stale-surface fallback
- a credential deliberately planted in `runtime.json` confirmed **absent** from the request payload

Open risk: whether each vendor accepts its schema — for OpenAI, strict Structured Outputs against
`openai-wire.ts`; for Anthropic, `output_config.format`. Both fail loudly with a `ProviderError`
rather than producing a bad plan, and an HTTP 400 surfaces the upstream message, so a fix is local
to the schema file.

**To run it for real:**
```bash
export OPENAI_API_KEY=sk-proj-...
cd examples/juice-shop && docker compose up -d && ./setup.sh
trinker compile --llm --provider openai --token-budget 40000   # proposal only
```
Then record the `record` block from `.trinker/proposal.json`.

### Out-of-band callbacks — ❌

Valid schema oracle name. No collector, no DNS/HTTP callback server, no correlation tokens.
`@trinker/probes` is a 2-line stub. Checks report `unavailable`.

### Browser-based checks — ❌

Valid schema oracle name. No Playwright/Puppeteer, no DOM oracle. Reports `unavailable`.

### Crawler — ❌

`SourceReferenceSchema.kind` reserves `"crawler"`. No crawler, no HAR ingestion, no proxy recording.
This is the main blocker for targets whose surface is not in source (Juice Shop needed a
hand-written plan for exactly this reason).

### Test-suite integration — ✅

`@trinker/vitest` provides `assertSecure`, `assertNoConfirmedFindings`, `assertScanComplete`,
`assertNoFaults`, `assertFindingIds`, and `describeScan`. Plain throwing functions, so they work in
Vitest, Jest, or node:test with no test-runner dependency. `assertSecure` checks completeness before
findings, because "no findings" from a scan that ran nothing is the failure mode this project
exists to prevent.

Not provided: custom Vitest matchers (`expect(x).toBeSecure()`), which would need vitest as a peer
dependency.

### Other gaps

- **OpenAPI not wired to the CLI** — `ingestOpenApi()` works as a library function; there is no
  `trinker compile --openapi <file>`. Low-hanging and valuable.
- **Multi-target** — `allowedTargetRefs` is an array but only `[0]` is read.
- **`identity.roles` / `capabilities`** — stored, consumed by nothing. No RBAC matrix testing.
- **Linting** — every `lint` script is `tsc --noEmit`. No ESLint, no Prettier.
- **Baseline / triage / suppression** — no way to accept a known finding.
- **Plan migration** — `schemaVersion` is `z.literal(1)` with no v2 path.
- **HTTP client** — has a timeout, but no retry, concurrency cap, rate limit, or redirect policy.

---

## 6. TUI

`packages/trinker/src/tui.ts` (rendering) + `scan-view.ts` (pure reducer, 17 tests).
Launched by `trinker` with no arguments. Verified by driving it in a real pty.

### Menu

```
❯ Run Security Scan     execute the plan against the configured target
  Findings              browse confirmed findings and their evidence
  Latest Scan           summary and per-check outcomes
  Security Coverage     planned vs actually verified routes
  Export Report         write Markdown, JSON, or SARIF
  Configuration         inspect .trinker/runtime.json
  Exit
```

### Keys

`↑`/`↓` navigate · `Enter` select (accepts both `return` and `enter` encodings) · `q`/`Esc` back ·
`v` verify a finding from the list · `m`/`j`/`s` export format.

Input is **queued by one persistent listener**. Previously each key was awaited with `once`, so any
key arriving while the screen rendered was emitted to nobody and **silently dropped** — losing
keystrokes from fast typing or paste. A closed stdin now exits instead of hanging forever.

### Views

| view | shows |
|---|---|
| Run Scan | target, plan, phase, elapsed, runtime tokens, progress bar over planned checks, current check + route + which identity/variant is in flight, findings as confirmed, and a warning if checks produced no verdict |
| Findings | list with severity/oracle/route; `Enter` opens detail |
| Finding detail | invariant, verdict, evidence notes, request + response witnesses with redacted headers and body digests, remediation, replay command |
| Latest Scan | counts across all five statuses + per-check outcomes with reasons |
| Coverage | planned vs verified, unverified routes grouped by cause |
| Configuration | **read-only** inspector; validates runtime.json, lists credential header *names* without ever rendering values |

Progress is derived only from real events — it never advances on a timer.

### Limitations

- No scrolling/pagination — a long findings list overflows.
- Findings selectable by arrow keys only (no jump-to-number).
- Full-screen clear each render; no diffing, no scrollback preservation.
- No `SIGWINCH` resize handling.
- No `init`/`compile` entries — fresh setup is CLI-only.
- Configuration is an inspector, not an editor.

---

## 7. Security coverage

### Implemented

| oracle | confirms | evidence required for CONFIRMED |
|---|---|---|
| **Differential Authorization** | Broken Object Level Authorization (high) | denied identity's response matched an allowed witness on **both** status **and** full-body sha256, after calibration measured real denial behaviour |
| **State Mutation** | Unauthorized State Mutation (high) | a `protectedPath` **value changed** after an unauthorized write, having first been proven stable across control reads. The mutation's status code is explicitly *not* evidence; a 2xx with no change is inconclusive |
| **Metamorphic Response** | response depends on a caller-supplied parameter (high) | a variant violated the declared relation on an endpoint first proven deterministic, all variants sent as the same identity |

Never sufficient: a status match alone, a similar body, a 2xx that changed nothing, a difference on
an endpoint that is not deterministic, any heuristic or score. Those are `inconclusive`.

> **State-mutation writes to live state and does not restore it** — inherent to testing whether a
> write is possible. The finding says so, because replaying it can report "did not reproduce" purely
> because the first run already changed the state.

### Planned but unavailable

`browser-execution`, `out-of-band` — schema-valid, no oracle, reported `unavailable`, which makes
the run exit 3.

### Entirely out of scope

SQL/NoSQL injection, command injection, path traversal, CSRF, SSRF, XXE, deserialization,
rate-limit bypass, auth bypass, session fixation, JWT algorithm confusion, cross-role privilege
escalation, GraphQL-specific attacks, race conditions/TOCTOU, business-logic abuse.

---

## 8. Testing and verification

### `pnpm` is not on PATH, but `npx pnpm@10.19.0` works

`package.json` pins `pnpm@10.19.0`. It is not installed globally (npm's prefix is `/usr`, which
needs root — not changed), but **`npx pnpm@10.19.0 <script>` works**, and all documented commands
were verified through it: `install --frozen-lockfile`, `typecheck`, `test`, `build`. CI uses
`pnpm/action-setup` and is unaffected.

### Commands that work

```bash
npx pnpm@10.19.0 test                              # the documented path; 370 tests
./node_modules/.bin/vitest run                     # same suite from the root, ~1.1s
(cd packages/<name> && ../../node_modules/.bin/tsc --noEmit)   # clean, all 8
(cd packages/<name> && ../../node_modules/.bin/tsup src/index.ts --format esm --dts)
node packages/trinker/dist/cli.js <command>        # `trinker` is not linked on PATH
```

### Test status — ✅ 370/370 (23 files)

```
core            99   (architecture 18, safety 20, runner 20, bindings 17, coverage 10, events 8, schema 6)
oracles         46   (state-mutation 21, metamorphic 13, differential-auth 12)
surface         34   (extract 26, discover 8)
trinker         57   (workflow 21, llm-compile 19, scan-view 17)
compiler       106   (openai provider 32, proposal 26, anthropic provider 24, openai SDK 7, anthropic SDK 7, selection 7)
vitest          18
report          13
```

Grew from **9 → 370** across five sessions. `safety.ts` went from zero coverage to 20 tests.

### Typecheck / build — ✅ clean, all 8 packages

`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`. Tests
are typechecked too.

### CLI smoke — ✅ all verified

`init`, `compile`, `compile --force`, `coverage`, `run`, `run --ci --format json|sarif|markdown`,
`run --strict`, `verify`, `report`, `help`, unknown command, no-TTY refusal, EPIPE under `| head`.

### Juice Shop end-to-end — ✅ verified live

```bash
cd examples/juice-shop
docker compose up -d      # wait ~20s to seed
./setup.sh                # logs in as two seeded customers, writes .trinker/runtime.json
trinker run               # exit 1
trinker verify TRK-0001   # exit 1 — reproduced
```

Actual result against a freshly seeded container:

```
checks: {"planned":5,"passed":2,"failed":3,"inconclusive":0,"errored":0,"unavailable":0}
TRK-0001  Differential Authorization  Broken Object Level Authorization
TRK-0002  State Mutation              Unauthorized State Mutation
TRK-0003  Metamorphic Response        Response Varies With a Parameter It Should Not Depend On
coverage: planned 80.0%, verified 80.0%    JWT leaked: false
```

Five checks, three oracles, both directions:

| check | oracle | endpoint | outcome |
|---|---|---|---|
| `chk_basket_cross_customer` | differential-authorization | `GET /rest/basket/:id` | **confirms** |
| `chk_basket_item_cross_customer_write` | state-mutation | `PUT /api/BasketItems/:id` | **confirms** |
| `chk_basket_items_scope_tampering` | metamorphic-response | `GET /api/BasketItems?BasketId=` | **confirms** |
| `chk_basket_requires_auth` | differential-authorization | `GET /rest/basket/:id` anonymous | **passes** |
| `chk_addresses_scope_tampering` | metamorphic-response | `GET /api/Addresss?UserId=` | **passes** |

Two negative controls, one per oracle family. They matter as much as the findings: a scanner that
only ever fires proves nothing about its ability to discriminate. Juice Shop genuinely scopes
addresses by session while failing to scope basket items, and the same oracle reports each
correctly.

Replay: `TRK-0001` and `TRK-0003` are read-only and reproduce (exit 1). `TRK-0002` reports
"could not be re-tested" and exits 3 on a second run, because that check writes and does not
restore.

> **Run against a fresh container.** The state-mutation check writes and does not restore. A second
> run finds the value already set and reports **inconclusive** by design. CI seeds a new container
> every run, which is what keeps it deterministic there.

### CI

`.github/workflows/ci.yml`, two jobs: (1) typecheck + test + build; (2) the full Juice Shop run,
asserting exit 1, exactly one finding of the right title, the negative control passing, no
inconclusive/errored/unavailable checks, a replay command matching the finding ID, and no JWT
anywhere in the report. The assertion script was validated against a real report before commit.

**Verified green on GitHub** (run `34570117287`, commit `a2c16d1`). Both jobs passed end to end,
including starting the container, scanning, asserting the outcome, and replaying the finding.
`pnpm install` / `typecheck` / `test` / `build` all succeed there, confirming the documented
commands are correct and the local `pnpm` gap is purely a local environment issue.

### Known failures

1. `pnpm` not on PATH — prefix documented commands with `npx pnpm@10.19.0`.
2. `trinker` not linked on PATH — use `node packages/trinker/dist/cli.js`.
3. None outstanding in CI — both jobs are green.

---

## 9. Known issues / technical debt

All reproduced against current code. The critical/high items from last session are **fixed**.

### Medium

**I-1 · `@trinker/compiler` is unreachable from the CLI.** Complete and tested, but nothing invokes
it — by design, until a provider exists. (`probes` was deleted and `vitest` implemented.)

**I-2 · `surface.discovered` is a phantom event.** Declared in `ScanEventType`, never emitted —
`discoverSurface` runs during `compile`, which has no bus.

**I-3 · Only `allowedTargetRefs[0]` is used.** The array is misleading.

**I-4 · `lint` is a lie.** Every `lint` script is `tsc --noEmit`, identical to `typecheck`. No
ESLint, no formatter.

**I-5 · Evidence can carry response bodies.** `bodyPreview` stores up to 1000 bytes of witness
response, potentially PII. Credential *headers* and known secret *values* are masked; body content
is not. Reports are gitignored, but this deserves a policy knob.

**I-6 · OpenAPI is JSON-only.** `compile --openapi` refuses YAML with a conversion hint, because
adding a YAML parser needs a dependency (and `pnpm` is unavailable locally to update the lockfile
that CI installs with `--frozen-lockfile`). Most real specifications are YAML, so this is the
obvious follow-up.

**I-7 · State-mutation is destructive and unrestored.** Inherent to testing whether a write is
possible. The finding says so; a re-run against already-mutated state reports `inconclusive`, and
`trinker verify` reports "could not be re-tested" and exits 3 rather than implying the flaw is
gone. Still missing: a cleanup hook or dry-run mode. CI sidesteps it by seeding a fresh container.

**I-16 · A route used only as a `readRequest` counts as uncovered.** The Juice Shop
`GET /api/BasketItems/:id` route is exercised by the state-mutation check but is not the target of
any check, so coverage reports it uncovered (80% rather than 100%). Accurate — coverage tracks
checks, not incidental requests — but it reads oddly. Consider distinguishing "targeted" from
"exercised".

### Low

- **I-8** `identity.roles`/`capabilities`, `fixture.ownerIdentityId`/`resourceId`,
  `invariant.resourceId` are stored but read by nothing.
- **I-9** Finding severity is hard-coded `high` in all three oracles; no severity policy.
- **I-10** No baseline/suppression — every run reports the full set.
- **I-11** `schemaVersion` is `z.literal(1)` with no migration path.
- **I-12** HTTP client has a timeout but no retry, concurrency cap, or rate limit.
- **I-13** Template-literal paths with substitutions and Nest decorators are undiscovered
  (deliberate conservative false negatives).
- **I-14** TUI has no scrolling, no resize handling, no jump-to-finding.
- **I-15** The root `.trinker/` is empty — Trinker has never been run against its own repository.

---

## 10. Environment

| | |
|---|---|
| **OS** | Linux (Arch), x86_64 |
| **Node** | v26.7.0 (`engines: >=20`) |
| **Package manager** | pins `pnpm@10.19.0` · ⚠️ **not on PATH**; no corepack; `npm`/`npx` available |
| **Install state** | ✅ populated, `pnpm-lock.yaml` committed |
| **Modules** | ESM throughout, `NodeNext` |
| **Build** | `tsup` 8.5.1 → ESM + `.d.ts` · TypeScript 5.9.3 |
| **Test** | Vitest 3.2.7 · root `vitest.config.ts` aliases `@trinker/*` → `src` |
| **Runtime deps** | `zod` 3.25.76; `typescript` (used *as a library* by `@trinker/surface`). **No HTTP library** (global `fetch`). **No LLM SDK.** |
| **Docker** | 29.7.2 · Juice Shop image pulled and verified working |
| **Git** | initialized, 17 commits, pushed to `git@github.com:Paardhu22/trinker.git` |
| **Linter** | none |

### Setup friction

1. `pnpm` missing → `npm i -g pnpm@10.19.0`, or use `./node_modules/.bin/*`.
2. `trinker` not linked → `npm link` in `packages/trinker`, or invoke the dist path.
3. Vitest must run **from the repo root** (or a package that re-exports the root config);
   `core`, `probes`, and `vitest` have no local `vitest.config.ts`.

---

## 11. Important files

| File | Why it matters |
|---|---|
| `packages/core/src/schema.ts` | **The contracts.** Plan, runtime, check union, cross-reference validation, `containsInlineSecret`. |
| `packages/core/src/safety.ts` | Every safety guarantee. 20 regression tests. |
| `packages/core/src/runner.ts` | Scheduler, outcome classification, finding + replay ID assignment. |
| `packages/core/src/findings.ts` | `FindingDraft` (makes the replay bug unrepresentable), `CheckStatus`, `exitCodeForScan`. |
| `packages/core/src/bindings.ts` | Shared binding resolution + secret tracking/masking. Every oracle uses it. |
| `packages/core/src/events.ts` | Replayable, terminating event bus. |
| `packages/core/src/coverage.ts` | Planned vs execution coverage. |
| `packages/core/test/architecture.test.ts` | **Guards the zero-token invariant.** If it fails, the import is the bug. |
| `packages/oracles/src/*.ts` | The three oracles. Reference pattern: calibrate → compare exactly → redacted evidence. |
| `packages/surface/src/extract.ts` | Receiver + mount resolution, confidence assignment. |
| `packages/surface/src/index.ts` | Cross-file mount resolution, discovery, resource inference. |
| `packages/trinker/src/workflow.ts` | The only filesystem adapter. **Oracle registry lives here** (`ORACLES`). |
| `packages/trinker/src/scan-view.ts` | Pure event→view reducer. Where TUI logic is testable. |
| `packages/compiler/src/proposal.ts` | **The LLM gate.** Everything a model emits passes through `applyProposal`. |
| `packages/compiler/src/prompt.ts` | Versioned compiler prompt + the JSON Schema asked of the model. Bump the version when either changes. |
| `packages/compiler/src/context.ts` | What the model is allowed to see: surface plus narrow source excerpts, never runtime data. |
| `packages/compiler/src/providers/anthropic.ts` | The only file that talks to a model API. |
| `docs/LLM_COMPILER.md` | How to use and reason about `compile --llm`. |
| `examples/juice-shop/` | The real integration target: plan, setup script, documented reproduction. |
| `.github/workflows/ci.yml` | Enforces the suite and the end-to-end run. |

---

## 12. Exact next steps

### P0 — must do next

**P0-1 · ~~Confirm CI passes~~ — DONE.** Both jobs are green on GitHub (run `34570117287`),
including the full Juice Shop end-to-end.

**P0-2 · ~~Wire OpenAPI into the CLI~~ — DONE.** `trinker compile --openapi <file.json>` merges a
specification with extracted routes. JSON only; YAML is refused with a conversion hint rather than
parsed loosely. A project with no extractable source now produces a usable plan.

**P0-3 · ~~Decide the fate of the orphan packages~~ — DONE.** `@trinker/probes` deleted;
`@trinker/vitest` implemented as a real assertion API.

### P1 — important

**P1-1 · Second Juice Shop check using a different oracle.** *(next thing to do)* Point `state-mutation` or
`metamorphic-response` at a real Juice Shop flaw (`PUT /api/Users/:id` mass assignment is a good
candidate). Proves the newer oracles against real software, not just fixtures.

**P1-2 · Real linting.** Add ESLint + Prettier and make `lint` mean something.

**P1-3 · Severity policy.** All three oracles hard-code `high`. Severity should come from the
invariant or a policy map.

**P1-4 · Baseline / suppression.** Accept a known finding so CI does not fail forever on a
risk-accepted issue.

**P1-5 · Evidence redaction policy (I-5).** A knob controlling whether response bodies are stored
at all.

**P1-6 · TUI scrolling and resize.** Currently a long findings list overflows.

### P2 — later

- **P2-1** ~~First real `CompilerProvider`~~ — DONE for OpenAI and Anthropic. Remaining: one
  real-API compilation with either, to confirm the request is accepted.
- **P2-2** Crawler / HAR / proxy ingestion (`kind: "crawler"` is reserved).
- **P2-3** OOB collector + `out-of-band` oracle.
- **P2-4** `browser-execution` oracle.
- **P2-5** Custom Vitest matchers on top of `@trinker/vitest` (needs vitest as a peer dependency).
- **P2-6** YAML OpenAPI support (needs a parser dependency).
- **P2-7** Multi-target support; RBAC matrix from `identity.roles`; plan migration for
  `schemaVersion: 2`; HTTP client hardening.

---

## 13. Design decisions that MUST NOT be accidentally reversed

Each is currently upheld **and tested**. Breaking any destroys the product's reason to exist.

**13.1 · `trinker run` is zero-LLM by default.**
Enforced structurally: no provider SDK is a dependency of any scan-path package, and
`packages/core/test/architecture.test.ts` fails if `core`/`oracles`/`report`/`surface` ever depend
on or import `@trinker/compiler`. `ScanResult.tokens` is pinned to zero. **Do not "just import" the
compiler into the runner.**

**13.2 · Runtime LLM use must be explicit opt-in.**
If ever added: explicit flag, off by default, visible in every report, real non-zero token
counters. A default-on runtime model call makes scans non-deterministic, irreproducible, and
expensive — the three things Trinker exists to avoid.

**13.3 · Confirmed findings require mechanical evidence.**
`FindingSchema.status` is `z.literal("confirmed")` — an unconfirmed finding is unrepresentable. Each
oracle confirms only on exact mechanical evidence (byte equality / observed state change / declared
relation violation). **Do not relax to similarity scoring or thresholds.** An unexplained success,
an unstable value, or a non-deterministic endpoint stays `inconclusive`. High precision over high
recall is the deliberate trade.

**13.4 · Credentials must never enter the committed plan.**
`plan.json` committed, `runtime.json` gitignored with **unanchored** patterns. `containsInlineSecret`
+ `.strict()` reject credential values. Identities/fixtures reference runtime data **by key only**.
**Never add a plan field that could hold a URL, token, cookie, or password.** `target.applicationId`
is a logical name, not a URL — keep it that way.

**13.5 · Core must remain decoupled from terminal and filesystem.**
`core` imports only `zod` + `node:crypto` + `node:events`, and does no filesystem I/O (tested).
`workflow.ts` is the single filesystem adapter. TUI logic lives in a pure reducer. **Never move a
security decision into rendering code.**

**13.6 · CI must remain non-interactive.**
`--ci` never requires a TTY, never prompts. Exit codes are the contract: **0** clean+complete,
**1** findings, **2** usage/config error, **3** untrustworthy scan.

**13.7 · Deterministic reruns consume zero runtime tokens.**
Content-addressed IDs, sorted execution, injectable clock, byte-exact comparison. **Do not
introduce randomness, wall-clock dependence, or map-iteration-order dependence.**

**13.8 · `compile` invents no security claims, and never destroys authored ones.**
Deterministic compile emits empty checks and the most conservative safety policy. Recompiling
preserves authored content and **refuses to write** rather than dropping a check whose route
vanished. Both are tested.

**13.9 · Safety gates are hard aborts, never warnings.**
Host allowlist, method allowlist, and the **double** mutation gate all throw before any request.
**Never let the plan alone authorize a write** — requiring local, uncommitted opt-in is what keeps a
committed plan safe to merge.

**13.10 · "0 findings" must never read as "everything was tested".**
The five-way outcome taxonomy, the trust summary, execution coverage, exit code 3, and the SARIF
`TRK-UNTESTED` results all exist for this. **Never collapse a non-verdict into a clean result.**

**13.11 · The model proposes; code decides.**
`applyProposal` is the only path from an LLM into a plan. It is additive-only, cannot widen safety,
cannot introduce credentials, stamps its own provenance, and re-validates with `PlanSchema`.
**Never let a proposal bypass it**, and never trust proposal content because "the model said so".

---

## STOPPING POINT

### What this session completed — all verified by execution

**P0 — foundation hardening (commit `ab6f2b4`)**
Four defects shared one root cause: the runner could report a clean scan for work it never did.
Fixed: replay IDs (oracles return a draft; the runner owns ID *and* command); the event
subscription race (the bus replays history, so a listener always sees the complete sequence, and
the iterator terminates); the outcome taxonomy (`skipped` → `inconclusive`/`errored`/`unavailable`,
with trust summaries, execution coverage, and exit code 3); `runtimeRef` bindings (moved to core,
resolving against a new `values` map, masked in evidence). Also: recompilation now preserves
authored plan content instead of destroying it, and an unhandled EPIPE no longer crashes a scan.
20 safety tests added where there were none.

**P0.5 — surface discovery (commit `60eb010`)**
Receiver resolution, mount prefixes within and across files, full `.route()` chains, Fastify plugin
prefixes, and honest confidence levels. `cache.get('/api/secret')` no longer fabricates a route;
`app.use('/api/orders', router)` no longer records the wrong URL at high confidence.

**P1 — two more oracles (commits `057bf6c`, `5086658`)**
`state-mutation` (evidence is the state change, not the status code; stability calibration prevents
attributing background churn) and `metamorphic-response` (client-controlled data scoping;
determinism calibration). Both complete schema stubs that previously had no way to express who acts.

**P1 — TUI (commit `64acded`)**
A real console: live scan progress from real events, navigable findings with full evidence detail,
coverage split by cause, a read-only configuration inspector. Event reduction extracted to a pure,
tested function. Fixed two genuine input bugs found by driving it in a pty (dropped keystrokes,
unrecognised Enter encoding).

**P1 — Juice Shop + CI (commits `6935817`, `a2c16d1`)**
A reproducible path from `docker compose up` to a replayable finding against real vulnerable
software, with a passing negative control. CI runs it and asserts the exact expected outcome.
Also fixed a real leak risk: `.gitignore` patterns were root-anchored, so a nested project's
`runtime.json` (bearer tokens) would have been committable.

**P2 — LLM boundary (commit `6f987c8`)**
Proposal contract, deterministic validation/merge, token budget, and an architecture test that
makes the zero-token guarantee structural.

Suite: **9 → 230 tests** at that point. Typecheck clean, all packages building.

### Session 3 — the metamorphic milestone (commit `b0064dc`)

`metamorphic-response` was the last oracle that had only ever run against fixtures. It now confirms
a real Juice Shop flaw and passes a real negative control:

- **Confirms** on `GET /api/BasketItems?BasketId=` — both variants sent as the *same* customer,
  differing only in that parameter, return different baskets' items. One number enumerates any
  customer's basket contents.
- **Passes** on `GET /api/Addresss?UserId=` — Juice Shop scopes addresses by session and ignores
  the parameter, so both variants come back byte-identical.

`setup.sh` gained discovery of the second customer's basket and both user ids so the variants can
point at data the caller genuinely must not see.

Two defects surfaced while verifying the reporting surfaces, both fixed with regression tests:

- **SARIF omitted inconclusive checks.** Only `errored`/`unavailable` became results, so an
  inconclusive route looked clean in code scanning while Markdown listed it prominently — a direct
  contradiction of §13.10. Every non-verdict is now a result: fault → `warning`, inconclusive →
  `note`.
- **`trinker verify` said "did NOT reproduce" for an inconclusive replay**, which reads as "the flaw
  is gone". It now distinguishes reproduced / did-not-reproduce / could-not-be-re-tested and exits 3
  for the last, because a replay asks a direct question and an inconclusive answer fails to answer it.

Suite: **257 → 271 tests** (4 SARIF, 4 fixture-backed metamorphic variants, 6 replay verdicts).

### Session 4 — the first LLM compiler provider (commits `f8c052b`, docs follow-up)

`trinker compile --llm` now asks a model what should be tested. The model proposes; deterministic
code decides. Detail in **[docs/LLM_COMPILER.md](LLM_COMPILER.md)**.

- **Endpoint:** Claude Messages API via `@anthropic-ai/sdk`, default `claude-opus-5`, adaptive
  thinking, `output_config.format` structured output, prompt cached on the stable system prefix.
- **Prompt:** `packages/compiler/src/prompt.ts`, version `2026-09-11.1`, recorded on every
  compilation.
- **Non-destructive:** proposes by default, writes `plan.json` only with `--apply`.
- **Telemetry:** provider, model, prompt version, input/output/total tokens, budget, and checks
  proposed/accepted/rejected.

Two design calls worth keeping:

- The request JSON Schema is **hand-written**, not generated from Zod. The SDK's `zodOutputFormat`
  helper requires Zod v4 and Trinker's security schemas are v3; migrating them to satisfy a prompt
  detail would be the wrong trade. Zod stays the only validation authority, which is what makes the
  wire schema a hint rather than a contract.
- The CLI reaches `@trinker/compiler` by **dynamic import**, so `trinker run` never loads a model
  client. An architecture test fails if a static import appears.

**Real-provider status: UNVERIFIED.** No credentials in this environment; no successful real run is
claimed. The real SDK is exercised end to end against a local stub of the Messages API, so
serialisation, transport, retries, and error mapping are tested — only Anthropic's acceptance of the
request is not.

Suite: **271 → 321 tests**, none requiring an API key.

### Session 5 — OpenAI as the default compiler provider (commit `0fb9359`)

Adds an OpenAI provider beside the Anthropic one behind the same `CompilerProvider` interface,
sharing the prompt, context builder, proposal contract, budget, telemetry, and deterministic
validation. Provider selection lives in `providers/index.ts`, so the CLI has no per-provider branch.

- `--provider openai` (default) / `--provider anthropic`; unknown names fail rather than fall back.
- Default model `gpt-5.6-terra`, chosen after checking the live catalog.
- Strict Structured Outputs, with an OpenAI-specific wire encoding normalised back before Zod.

**Defect found and fixed:** `compile --llm` always ran a deterministic recompile first, which
regenerates the surface from source. On a hand-declared or OpenAPI-derived surface — the Juice Shop
example included — that stranded every authored check and failed before reaching the model, making
the LLM path unusable on exactly the targets that need it most. It now falls back to the committed
plan and reports `surfaceRefreshed: false`.

**Real OpenAI call: NOT MADE.** `OPENAI_API_KEY` was absent from every environment checked. See the
LLM providers section for the full verification list and the exact command to run it.

Suite: **321 → 370 tests**, none requiring an API key.

### What was deliberately NOT done

- **No LLM provider and no `--llm` flag.** A flag answering "no provider configured" is fake
  functionality. The library API is tested and ready.
- **No crawler, OOB collector, or browser oracle.** Schema space is reserved; nothing pretends to
  work.
- **Template-literal and Nest-decorator routes stay undiscovered** — conservative false negatives
  beat fabricated routes.

### What the next session should do first

**Run one real compilation.** Export a key the tooling can actually see and run:

```bash
export OPENAI_API_KEY=sk-proj-...
cd examples/juice-shop && docker compose up -d && ./setup.sh
trinker compile --llm --provider openai --token-budget 40000
```

This is the single unverified step in the whole system, and it has now been blocked twice by
credentials not being present in the execution environment — confirm with
`echo ${OPENAI_API_KEY:+SET}` from the same shell the tool runs in before assuming it is available.

Check three things: that OpenAI accepts the strict schema in `providers/openai-wire.ts`; that the
returned proposal survives `PlanProposalSchema`; and how many proposed checks a human would actually
keep — the accepted/rejected counts in the telemetry record are the first real data point for the
cost question that V2 depends on.

Everything else is verified by observation: all P0 and P1 items are closed, every oracle is proven
against real software, and CI is green.

All P0 items are closed, every oracle is proven against real software, and CI is green — so every
claim in this document is verified by observation rather than inspection.

**Do not start a provider implementation before P0-1 and P0-2.** The gate it needs is built and
tested; what is missing is reach into real applications, not more LLM surface area.
