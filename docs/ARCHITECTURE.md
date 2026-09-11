# Architecture

Trinker compiles application-specific security knowledge into a reviewed plan, then executes that
plan deterministically. The runner contains no LLM provider and no network client beyond `fetch`.

## Dependency Direction

```text
trinker CLI / TUI
    |
    +-- @trinker/surface   route extraction
    +-- @trinker/oracles   deterministic oracle implementations
    +-- @trinker/report    JSON / Markdown / SARIF
    |
    +-------------------> @trinker/core
                          schemas, safety, bindings, runner, events, findings, coverage
                                |
                               zod
```

Dependencies point inward. `@trinker/core` imports only `zod` and Node builtins — it knows nothing
about the terminal, the `.trinker/` directory layout, or the CLI. Every security decision lives in
core or in an oracle.

`@trinker/compiler` is the reserved LLM boundary and is deliberately *not* a dependency of core,
oracles, or report. That direction is what makes "a scan costs zero tokens" enforceable by the
dependency graph rather than by convention. It currently holds only a token budget guard.

## The Two Files

`.trinker/plan.json` is the reviewed, committed artifact. It holds route templates, identities by
ID, fixture references, invariants, checks, the safety policy, and provenance. It contains no
target URL, no credentials, and no inline credential-like fields; Zod rejects them.

`.trinker/runtime.json` is local and gitignored. It provides target URLs, host allowlists,
credential headers, fixture data, runtime values, and the mutation authorization flag. A plan
refers to all of it by stable key only.

Two kinds of runtime data, deliberately separated:

| | `fixtures` | `values` |
|---|---|---|
| Referenced by | `{ "fixtureRef": "...", "field": "..." }` | `{ "runtimeRef": "..." }` |
| Meaning | test data — which object to act on | deployment-specific or secret scalars |
| In evidence | appears, because a finding about object 42 is unreadable if 42 is hidden | masked everywhere it is recorded |

## Compilation

`trinker compile` extracts the surface and writes a plan. It never invents an authorization claim:
identities, fixtures, invariants, and checks start empty, and the safety policy starts at its most
conservative (`mutationPolicy: "forbid"`, `GET`/`HEAD`/`OPTIONS` only).

Recompiling **preserves** everything a human authored and replaces only what is derived from
source. If the result would not validate — typically because a check references a route that no
longer exists — compile refuses to write and names the offending checks, rather than silently
discarding reviewed security knowledge. `--force` regenerates from scratch.

Route extraction resolves the receiver of a route call before believing it. `cache.get('/x')` is
not a route. `app.use('/api/orders', router)` prefixes the routes declared on that router, across
files where the import resolves. `confidence` reflects real certainty:

| confidence | meaning |
|---|---|
| `high` | receiver proven by a framework factory call, path fully resolved |
| `medium` | receiver matched only by naming convention, or router mounted at several prefixes, or mount resolved across files |
| `low` | router is never mounted in the analysed sources, so the path is probably incomplete |

An unrecognised receiver produces no route at all. A missing endpoint is recoverable; a fabricated
one silently corrupts the plan.

## Execution

`runPlan` validates safety, then executes enabled checks in `check.id` order, dispatching each to a
registered oracle. It assigns finding IDs, and therefore also assigns each finding's replay
command — an oracle returns a `FindingDraft` with no ID and cannot desynchronise the two.

## Check Outcomes

Every planned check produces exactly one outcome. Only the first two are verdicts.

| status | meaning |
|---|---|
| `passed` | the oracle ran and the invariant held |
| `failed` | the oracle ran and mechanically confirmed a violation |
| `inconclusive` | the oracle ran but could not reach a verdict (no usable reference response, unstable state, non-deterministic endpoint) |
| `errored` | the oracle threw — a bug, a bad binding, an unreachable target |
| `unavailable` | no oracle is registered for this check's `oracle` field; nothing was tested |

There is deliberately no "skipped". An oracle that cannot conclude reports `inconclusive` and says
why; an oracle that malfunctions throws. Neither is folded into a clean result, because "0 findings"
must never be readable as "everything was tested".

Every report leads with a trust summary saying whether the scan was COMPLETE or INCOMPLETE, and
lists each check that produced no verdict. SARIF emits those as results too, so a dashboard cannot
show a green run for a scan that executed nothing.

## Exit Codes

| code | meaning |
|---|---|
| 0 | every planned check reached a verdict and none confirmed a violation |
| 1 | at least one violation was mechanically confirmed |
| 2 | usage or configuration error, raised before a scan produced a result |
| 3 | the scan could not be trusted: a check errored or had no oracle |

3 is kept distinct from 1 so a broken pipeline is never mistaken for a vulnerability, and distinct
from 0 so a scan that tested nothing cannot report success. `--strict` extends 3 to inconclusive
checks, for pipelines that require a definite verdict on everything.

## Events

`ScanEventBus` emits ordered envelopes with a core-owned `sequence`, `scanId`, timestamp, type, and
data. The bus retains its history and replays it to any listener that attaches later, so a consumer
always observes the complete sequence from `scan.started` — the runner is free to emit before any
consumer exists. Async iteration terminates on `scan.completed` or `scan.failed`. A safety refusal
emits `scan.failed` rather than leaving consumers waiting on a scan that will never finish.

The TUI reduces this stream into a view with a pure function (`scan-view.ts`), tested without a
terminal. CI consumes the same stream.

## Safety

Only loopback (`localhost`, `127.0.0.1`, `::1`) is allowed implicitly. Any other host must appear in
the local runtime allowlist. Every checked method must appear in the plan's `safety.allowedMethods`.
A write check additionally requires *both* a plan policy that permits mutation *and*
`mutationAuthorized: true` in runtime configuration — the committed plan alone can never authorize a
write, which is what keeps a plan safe to merge.

All gates are hard aborts before any HTTP request, never warnings.

## Confirmed Findings

| oracle | confirms | evidence required |
|---|---|---|
| `differential-authorization` | Broken Object Level Authorization | a denied identity received a response matching an allowed identity's witness on **both** status and full-body sha256 |
| `state-mutation` | Unauthorized State Mutation | a protected path's value **changed** after an unauthorized write, having first been proven stable across control reads |
| `metamorphic-response` | response depends on a caller-supplied parameter | a variant violated the plan's declared relation, on an endpoint first proven deterministic |

Each oracle calibrates before it judges: the authorization oracle measures how the application
actually denies access rather than assuming 401/403, and the other two prove the thing they are
watching is stable before attributing any change to the attack. An unexplained success, an unstable
value, or a non-deterministic endpoint is `inconclusive` — never a finding.

`browser-execution` and `out-of-band` are valid in the schema but have no oracle. A check naming
them is reported `unavailable`.

Every finding carries its route, invariant, oracle verdict, redacted witness requests and
responses with body digests, remediation, and a replay command that matches its own ID.
`trinker verify <id>` replays that single check with no LLM.

A state-mutation finding writes to live state and does not restore it, which is inherent to testing
whether a write is possible. Such a finding says so, because replaying it can report "did not
reproduce" purely because the first run already changed the state.

## Coverage

Plan coverage is `enabled checks' route IDs / in-scope route IDs` — what the plan intends to test.

Execution coverage is narrower: a route counts as **verified** only when *every* planned check on it
reached a verdict. One unavailable oracle is enough to make a route unverified, because a partially
tested route cannot support a claim that it is clean. Unverified routes are attributed to their
cause (inconclusive, errored, unavailable).
