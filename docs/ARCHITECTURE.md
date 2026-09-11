# Architecture

Trinker compiles application-specific security knowledge into a reviewed plan, then executes that plan deterministically. The current MVP intentionally contains no LLM provider or network client.

## Dependency Direction

```text
trinker CLI/TUI -> core runner -> oracle contracts -> findings -> reports
                  ^                ^
                  |                |
             surface metadata   deterministic oracle implementations
```

`@trinker/core` owns the Zod schemas, safety preflight, execution scheduler, scan event stream, findings contract, and coverage calculation. The CLI is an adapter: it does not make a security decision itself.

## Runtime Boundary

`.trinker/plan.json` is the reviewed, committed artifact. It contains route templates, identities by ID, fixture references, invariants, checks, safety policy, and provenance. It contains no target URL, credentials, or inline credential-like fields. Zod rejects inline values under credential-like keys.

`.trinker/runtime.json` is local and gitignored. It provides target URLs, explicit host allowlists, credential headers, fixture data, and the mutation authorization flag. A plan refers to these values by stable keys only.

## Events

`ScanEventBus` emits ordered envelopes with a core-owned `sequence`, `scanId`, timestamp, type, and real data. Current event types cover scan start/completion, phase changes, calibration, check lifecycle, confirmed findings, and token usage. The TUI subscribes to this stream; CI and reporters can consume the same stream without a terminal.

## Safety

Only localhost is allowed implicitly. A remote target must appear in the local runtime allowlist. Any checked method must appear in the plan's `safety.allowedMethods`. Write checks additionally require a plan mutation policy that permits them and `mutationAuthorized: true` in runtime configuration.

## Confirmed Findings

The current differential authorization oracle obtains successful witnesses for allowed identities, then makes the configured number of requests for every denied identity. It records denial fingerprints from measurable response properties. It confirms BOLA only when a denied identity receives the exact same successful response digest and status as an allowed identity. An unexpected but non-equivalent success is inconclusive, not a finding.

Every finding includes a route, invariant, oracle verdict, redacted witness requests/responses, and its replay check ID. `trinker verify <finding-id>` replays that check without an LLM.

## Coverage

Plan coverage is `enabled checks' route IDs / in-scope route IDs`. Excluded routes remain explicit in the plan and require a reason. Execution coverage is not yet separately persisted; scan result counts expose passed, failed, and skipped checks.
