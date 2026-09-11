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
export OPENAI_API_KEY=sk-proj-...          # or ANTHROPIC_API_KEY for --provider anthropic

# Propose. Writes .trinker/proposal.json and prints the diff. plan.json is NOT touched.
trinker compile --llm --token-budget 60000

# Review .trinker/proposal.json, then apply exactly what you reviewed — no second model call.
trinker compile --apply-proposal
```

| flag | meaning |
|---|---|
| `--llm` | opt in. Without it, `compile` is entirely deterministic and free. |
| `--provider <name>` | `openai` (default) or `anthropic`. |
| `--token-budget <n>` | hard ceiling for one compilation. Default 60000. |
| `--model <id>` | provider default if omitted. |
| `--apply` | propose **and** write in one call. No separate review step. |
| `--apply-proposal` | write the proposal already recorded. Makes no model call. |

> Use `--apply-proposal` for the review workflow. `--llm --apply` would call the model *again* and
> apply that result — and a model is not deterministic, so it would not be the proposal you read.
> `--apply-proposal` applies the recorded bytes, refuses if the plan has moved on since, and
> re-validates the file rather than trusting it.

`trinker run` has no `--llm` flag and never contacts a provider.

## Providers

| provider | key | default model | price (in/out per MTok) |
|---|---|---|---|
| `openai` (default) | `OPENAI_API_KEY` | `gpt-5.6-terra` | $2 / $12 |
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-opus-5` | $5 / $25 |

`gpt-5.6-terra` rather than the frontier `gpt-6-astra` ($10/$50) or the cheapest `gpt-5.6-luna`
($0.20/$1.20): compiling a plan is a judgement task where a bad proposal costs a reviewer's time,
so the bottom tier is a false economy — but it is not work that needs the most expensive model
available. Override with `--model`.

An unknown `--provider` fails rather than falling back to a default. Silently compiling with a
provider nobody asked for would misattribute both the cost and the resulting plan.

## Configuration

| setting | source |
|---|---|
| API key | `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`. Never read from, or written to, the plan. |
| provider | `--provider`, default `openai` |
| model | `--model`, provider default if omitted |
| endpoint | `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`, or the provider's `baseUrl` option, for a gateway |
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

## Prompt and wire schemas

`packages/compiler/src/prompt.ts` holds the versioned system prompt
(`COMPILER_PROMPT_VERSION`) and the Anthropic request schema. Both providers share that prompt; the
version is recorded on every compilation so a plan can be traced to what produced it. Bump it
whenever the instructions change.

Request schemas are hand-written rather than generated from `PlanProposalSchema`. For Anthropic,
because the SDK's Zod helper requires Zod v4 and Trinker's security schemas are v3. For OpenAI,
because strict Structured Outputs is a narrow JSON Schema subset. Either way the wire schema is a
*request*; `PlanProposalSchema` remains the only validation authority.

### OpenAI's wire encoding

`packages/compiler/src/providers/openai-wire.ts` (`OPENAI_WIRE_VERSION`, reported as
`<prompt>+openai-wire.N`). Strict mode forbids `anyOf`, `minItems`, and optional properties, and
requires `additionalProperties: false` everywhere — so it can express neither optional fields nor
arbitrary-key maps. Two consequences:

- optional fields are **nullable** and the nulls are stripped on return, because
  `PlanProposalSchema` is `.strict()` and would reject an explicit `null` where it expects an
  absent key
- binding maps and the rationale map travel as **arrays of entries** and are rebuilt
- a request body travels as a **JSON string** in `bodyJson`

Normalisation only removes nulls and reshapes containers. It can never add or alter content, and
anything it does not recognise is passed through unchanged so `PlanProposalSchema` rejects it
rather than being quietly repaired into something that validates.

## Safety boundaries

- `trinker run` is LLM-free. The CLI reaches `@trinker/compiler` only through a dynamic import, so
  a scan never loads a model client, and `packages/core/test/architecture.test.ts` fails if a static
  import appears or if a scan-path package gains a provider dependency.
- A model can propose a check. Only an oracle can confirm a finding.
- Credentials never enter a plan, and the API key is stripped from provider error messages, which
  reach terminals and CI logs.
- `--apply` is required to change `plan.json`.

## A stale surface

`compile --llm` re-derives the surface from source first, so the model reasons about current
routes. A plan whose surface was hand-declared or ingested from a specification cannot be
re-derived, and `compile` rightly refuses to write a plan that would strand its checks.

Rather than fail, the compiler falls back to the committed plan and says so:

```text
Surface was NOT re-derived from source; the committed plan's routes were used as-is.
```

That is the normal path for the Juice Shop example and for any OpenAPI-derived plan.

## Real-provider status

**OpenAI: verified (2026-09-11).** One real compilation against a live Juice Shop container with
`gpt-5.6-terra`:

```
prompt version   2026-09-11.1+openai-wire.1
tokens           3680 in + 812 out = 4492  (budget 40000)   ≈ $0.017
checks           2 proposed, 2 accepted, 0 rejected, over 5 routes
```

Strict Structured Outputs accepted the schema as written. The proposal passed deterministic
validation unchanged, was purely additive, and contained no secrets. After review and
`--apply-proposal`, one of its checks confirmed a real BOLA on `GET /api/BasketItems/:id` that the
hand-written plan had missed; the other passed as a negative control.

**Anthropic: still unverified.** No credentials available; whether `output_config.format` is
accepted as written remains untested. A rejection surfaces as a `ProviderError` with the upstream
message rather than producing a bad plan.

What is verified for both, without credentials:

- the whole pipeline with a fake provider: validation, merge, budget, telemetry
- the **real SDKs** (`openai` and `@anthropic-ai/sdk`) against local stubs of their APIs — real
  serialisation, transport, retries, and error mapping
- the CLI flow end to end against a stub **using the actual Juice Shop plan**, including
  `--apply`, the non-destructive default, and the stale-surface fallback
- that a credential deliberately planted in `runtime.json` does **not** appear anywhere in the
  request payload

### Running it for real

```bash
export OPENAI_API_KEY=sk-proj-...
cd examples/juice-shop
docker compose up -d && ./setup.sh          # or any project with a compiled plan
trinker compile --llm --provider openai --token-budget 40000   # propose (1 API call)
# review .trinker/proposal.json
trinker compile --apply-proposal                                # apply (0 API calls)
```

The `record` block in `.trinker/proposal.json` carries provider, model, prompt version, token
counts, budget, and checks proposed/accepted/rejected.

Expect some variation between runs: the same prompt against the same surface produced two checks,
then one, then two across three observed runs. That is why applying goes through the recorded
proposal rather than a fresh call.
