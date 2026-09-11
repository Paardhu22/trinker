# Trinker

Trinker is a deterministic application security testing framework. It compiles a reviewable, secret-free `.trinker/plan.json` and reuses it for security scans with **zero runtime LLM tokens by default**.

## Current MVP

- Strict Zod plan and runtime configuration schemas
- Express/Fastify-style AST extraction and OpenAPI object ingestion
- Deterministic plan compilation without an LLM
- Target allowlisting and mutation safety gates
- Typed live scan event stream
- Conservative differential authorization oracle
- JSON, Markdown, and SARIF reports
- Replay of a confirmed finding with `trinker verify <id>`
- Keyboard-driven terminal shell plus non-interactive CI mode

## Quick Start

```bash
pnpm install
pnpm build
cd path/to/your/authorized-target
trinker init
trinker compile
# Review and add identities, fixtures, invariants, and checks to .trinker/plan.json.
# Put target URLs and credentials only in .trinker/runtime.json.
trinker run --ci --format sarif
```

`trinker compile` produces a safe starter plan; it intentionally does not invent authorization rules. A hand-authored authorization check is required before the current runner has work to execute.

## Safety

Localhost is allowed by default. Any non-local target must be named in `runtime.json`'s `allowHosts`. Write methods require both a plan permitting mutations and `mutationAuthorized: true` in runtime configuration. Trinker is for systems you own or are explicitly authorized to test.

## Development

```bash
pnpm test
pnpm typecheck
pnpm build
```

See [the Juice Shop setup](examples/juice-shop/README.md) for a local legal target.

For the actual contracts and plan workflow, see [architecture](docs/ARCHITECTURE.md) and [plan authoring](docs/PLAN_AUTHORING.md).
