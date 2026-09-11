# The LLM compiler

`trinker compile --llm` asks a model **what should be tested**, then validates every suggestion
deterministically before it can become part of a plan.

It never asks the model what is vulnerable. Trinker confirms a finding only when a mechanical
oracle observes specific evidence, and that is unchanged by anything here.

```text
application source
      ↓  deterministic surface discovery
  routes + narrow source excerpts
      ↓  compile --llm  (the only place a model is involved)
  PlanProposal (structured JSON)
      ↓  applyProposal — filter + re-validate with PlanSchema
  proposed additions + rationale
      ↓  human review, then --apply
  .trinker/plan.json
      ↓  trinker run — zero LLM tokens, forever
```

## Usage

```bash
export ANTHROPIC_API_KEY=sk-ant-...

# Propose. Writes .trinker/proposal.json and prints the diff. plan.json is NOT touched.
trinker compile --llm --token-budget 60000

# Review .trinker/proposal.json, then merge it in.
trinker compile --llm --token-budget 60000 --apply
```

| flag | meaning |
|---|---|
| `--llm` | opt in. Without it, `compile` is entirely deterministic and free. |
| `--token-budget <n>` | hard ceiling for one compilation. Default 60000. |
| `--model <id>` | default `claude-opus-5`. |
| `--apply` | write the merged plan. Without it nothing is written to `plan.json`. |

`trinker run` has no `--llm` flag and never contacts a provider.

## Configuration

| setting | source |
|---|---|
| API key | `ANTHROPIC_API_KEY`. Never read from, or written to, the plan. |
| model | `--model`, default `claude-opus-5` |
| endpoint | `ANTHROPIC_BASE_URL`, or the provider's `baseUrl` option, for a gateway |
| budget | `--token-budget` |

## What the model is given

Only what it needs to reason about the attack surface:

- discovered routes with methods, path templates, parameters, and extraction confidence
- resources inferred from shared path parameters
- a narrow window of source around each route declaration (capped and deduplicated)
- the oracles that actually have an implementation
- the plan's allowed methods and mutation policy
- what the plan already contains, so it proposes only additions

It is **not** given runtime configuration, credentials, or the target URL. `compileWithProvider`
asserts that separately from the function that builds the context, because that is the one call
that sends data off the machine.

## What the model may propose

The structured `PlanProposal` contract and nothing else: identities, fixtures, invariants, checks,
per-check rationales, and reviewer notes. Prose is rejected rather than scraped for checks.

It cannot write code, run commands, make its own HTTP requests, touch source files, alter runtime
credentials, or declare a finding.

## What happens to the proposal

`applyProposal` enforces all of this in code, not in the prompt:

| rule | effect |
|---|---|
| additive only | cannot redefine an identity, fixture, invariant, or check a human already reviewed |
| safety is fixed | cannot widen `allowedMethods` or the mutation policy |
| method allowlist | a check on a method the plan forbids is rejected |
| mutation policy | a mutating check under `mutationPolicy: "forbid"` is rejected |
| references must resolve | unknown route, identity, fixture, or invariant → rejected |
| oracle must exist | a check naming an unimplemented oracle is rejected, not merged as dead weight |
| no credentials | the merged plan is re-validated by `PlanSchema`, which rejects inline credential-like values |
| provenance is stamped | invariants are marked `llm-assisted` by us, never by the proposal |

One bad item is reported with a reason rather than discarding the whole proposal — but nothing
invalid is ever merged.

A proposed check also cannot *run* until a human supplies its identities and fixtures in
`runtime.json`. Until then the runner reports it as `errored` with a missing-reference message,
which is the correct outcome: a check nobody has wired up has tested nothing.

## Token accounting

Every compilation records:

```json
{
  "provider": "anthropic:claude-opus-5",
  "model": "claude-opus-5",
  "promptVersion": "2026-09-11.1",
  "inputTokens": 3120, "outputTokens": 640, "totalTokens": 3760,
  "tokenBudget": 50000,
  "checksProposed": 2, "checksAccepted": 1, "checksRejected": 1,
  "routesConsidered": 2,
  "compiledAt": "2026-09-11T16:51:29.115Z"
}
```

The budget is enforced twice: an estimate is checked *before* the call, and real usage is recorded
*after*, so a provider that under-estimates still trips the ceiling rather than having the overrun
absorbed. This record is the basis for comparing what a compilation cost against how much reviewed
security knowledge it bought.

## Prompt

`packages/compiler/src/prompt.ts` holds the versioned system prompt
(`COMPILER_PROMPT_VERSION`) and the JSON Schema the model fills in. Bump the version whenever
either changes; it is recorded on every compilation so a plan can be traced to the prompt that
produced it.

The request schema is hand-written rather than generated from `PlanProposalSchema`, because the
SDK's Zod helper requires Zod v4 and Trinker's security schemas are v3. Migrating them to satisfy
a prompt detail would be the wrong trade. The wire schema is a *request*; `PlanProposalSchema`
remains the only validation authority. Keep the two aligned.

## Safety boundaries

- `trinker run` is LLM-free. The CLI reaches `@trinker/compiler` only through a dynamic import, so
  a scan never loads a model client, and `packages/core/test/architecture.test.ts` fails if a static
  import appears or if a scan-path package gains a provider dependency.
- A model can propose a check. Only an oracle can confirm a finding.
- Credentials never enter a plan, and the API key is stripped from provider error messages, which
  reach terminals and CI logs.
- `--apply` is required to change `plan.json`.

## Real-provider status

**Unverified.** No Anthropic credentials were available in the environment where this was built, and
no successful real-provider run is claimed.

What *is* verified, without credentials:

- the whole pipeline with a fake provider, including validation, merge, budget, and telemetry
- the real `@anthropic-ai/sdk` client against a local stub of the Messages API — real
  serialisation, transport, retry, and error mapping, asserting the request carries the surface and
  the API key travels only in the header
- the CLI flow end to end against that stub, including `--apply` and the non-destructive default

What remains untested is Anthropic's own acceptance of the request — in particular whether the
`output_config.format` JSON Schema is accepted as written. Run one compilation against the real API
before relying on it, and see the handoff for what to check.
