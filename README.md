# Trinker

Trinker is a deterministic application security testing framework. It compiles a reviewable,
secret-free `.trinker/plan.json` and replays it on every scan with **zero runtime LLM tokens**.

The thesis: security knowledge is expensive to derive and cheap to replay. Working out that "only
the owner of order 42 may read order 42" takes judgement. *Checking* it is two requests and a byte
comparison. Trinker makes the expensive step a compilation that produces a durable, diffable
artifact, and the cheap step something you can run on every pull request.

A confirmed finding is not an opinion. It is a replayable mechanical fact, and the command to
replay it is printed in the report.

## What works today

- Strict Zod contracts for the plan and runtime config, with credential-like values rejected from
  the committed plan
- Express/Fastify route extraction that resolves receivers and mount prefixes, and reports honest
  confidence instead of guessing
- OpenAPI ingestion (`compile --openapi`), so a target whose surface is not in source is still
  reachable
- Deterministic compilation that preserves hand-authored security knowledge across recompiles
- Three deterministic oracles: **differential authorization** (BOLA), **state mutation**, and
  **metamorphic response** (client-controlled data scoping)
- Loopback-only targets by default, and a double gate on writes
- A replayable typed event stream, consumed identically by CI and the terminal console
- JSON, Markdown, and SARIF reports that state whether the scan can be trusted
- A keyboard-driven console with live scan progress and finding evidence
- An end-to-end [OWASP Juice Shop evaluation](examples/juice-shop/README.md) that confirms a real
  BOLA and passes a negative control

## Quick start

```bash
pnpm install
pnpm build

cd path/to/your/authorized-target
trinker init                # writes .trinker/runtime.json
trinker compile             # extracts routes into .trinker/plan.json
# or, when the surface is not recoverable from source:
trinker compile --openapi openapi.json
# Author identities, fixtures, invariants, and checks — see docs/PLAN_AUTHORING.md
trinker run --ci --format sarif
```

`trinker compile` writes **no checks**. It will not invent an authorization rule, so a plan tests
nothing until you author one. That is the design, not a gap.

To see the whole loop against a real vulnerable application in about a minute, start with the
[Juice Shop example](examples/juice-shop/README.md).

## Exit codes

| code | meaning |
|---|---|
| 0 | every planned check reached a verdict and none confirmed a violation |
| 1 | a violation was mechanically confirmed |
| 2 | usage or configuration error |
| 3 | the scan could not be trusted — a check errored or had no oracle |

3 exists so "0 findings" can never be confused with "everything was tested". Add `--strict` to
treat inconclusive checks the same way.

## Safety

Loopback is allowed implicitly; any other host must be named in `allowHosts` in your local
`runtime.json`. Write checks require **both** a plan that permits mutation **and**
`mutationAuthorized: true` in runtime config — the committed plan alone can never authorize a
write, which is what keeps a plan safe to merge.

All gates abort before any request is sent. Trinker is for systems you own or are explicitly
authorized to test.

## Development

```bash
pnpm test        # 189 tests
pnpm typecheck
pnpm build
```

If `pnpm` is unavailable, the workspace binaries work directly:
`./node_modules/.bin/vitest run` and `./node_modules/.bin/tsc --noEmit`.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — packages, execution flow, outcome taxonomy, safety model
- [Plan authoring](docs/PLAN_AUTHORING.md) — how to write each kind of check
- [Juice Shop evaluation](examples/juice-shop/README.md) — reproducible end-to-end run
- [Session handoff](docs/SESSION_HANDOFF.md) — current state and roadmap
