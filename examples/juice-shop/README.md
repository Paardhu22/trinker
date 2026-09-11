# OWASP Juice Shop — end-to-end evaluation

This is Trinker's integration target: a real, intentionally vulnerable application, scanned over
real HTTP, producing a mechanically confirmed finding that can be replayed.

It exercises both directions in a single run:

| check | expectation | why it matters |
|---|---|---|
| `chk_basket_cross_customer` | **confirms a finding** | any authenticated customer can read any basket |
| `chk_basket_requires_auth` | **passes** | an anonymous request is correctly refused with 401 |

The second check is the negative control. A scanner that only ever fires is not evidence of
anything, so this example proves the oracle stays quiet when authorization actually works.

> Run this only against your own local container. Juice Shop is deliberately vulnerable; never
> point this at a shared or hosted instance.

## Reproduce it

```bash
# 1. start the target
cd examples/juice-shop
docker compose up -d
# give it ~20s to seed its database

# 2. log in as two seeded customers and write .trinker/runtime.json
./setup.sh

# 3. scan
trinker run
#   or, if the CLI is not linked:  node ../../packages/trinker/dist/cli.js run

# 4. replay the confirmed finding
trinker verify TRK-0001

# 5. export a report
trinker report --markdown
```

Tear down with `docker compose down`.

## Expected output

```text
check.progress  identity_basket_owner   role=allowed  status=200
check.progress  identity_other_customer role=denied   trial=1 status=200
oracle.calibrated  denialStatuses=[200]
finding.confirmed  TRK-0001  high  Broken Object Level Authorization
check.passed       chk_basket_requires_auth  (denial statuses: 401)
scan.completed     1 passed, 1 failed, 0 inconclusive, 0 errored, 0 unavailable

COMPLETE - every planned check produced a verdict; 1 violation(s) confirmed.
```

Exit code **1** — a violation was confirmed. `trinker verify TRK-0001` reproduces it and also
exits 1.

## What makes the finding trustworthy

The oracle does not conclude "different user got a 200, therefore broken". It:

1. Reads the basket as its owner and keeps that response as a **witness**.
2. Requests the same basket three times as a different customer, measuring how the application
   actually denies access rather than assuming 401/403.
3. Confirms only because the other customer's response matched the witness on **both** the HTTP
   status and the sha256 of the entire body — byte-identical, not merely similar.

Against the `chk_basket_requires_auth` check the same oracle sees 401s that match nothing, and
reports `passed`.

Credentials never enter the finding. The recorded witnesses show `authorization: [REDACTED]`, and
the report contains no JWT.

## How the pieces map to Trinker's model

| file | role | committed? |
|---|---|---|
| `plan.json` | the reviewed security artifact: routes, identities by ID, invariants, checks | **yes** — this is the point of a plan |
| `.trinker/runtime.json` | target URL, bearer tokens, the basket fixture | **no** — gitignored |
| `setup.sh` | logs in, discovers a readable basket, writes runtime.json | yes |

`setup.sh` copies `plan.json` into `.trinker/plan.json` and generates `.trinker/runtime.json`
beside it. The plan refers to `basket_owner`, `other_customer`, and `ownedBasket` by key only, so
the same committed plan works against any Juice Shop instance once runtime config points at it.

`identity_anonymous` deliberately has **no** entry in `runtime.identities`, which is how a
credential-free request is expressed: the request is built with no authorization header.

## Why this plan is hand-written

`trinker compile` reads source, and Juice Shop ships as a bundled application whose API is not
recoverable from the files on disk. Its routes are therefore declared by hand with
`sourceRefs.kind: "manual"`.

This is the intended workflow for any target whose surface the extractor cannot reach; an OpenAPI
document or a future crawler input would fill the same role. The plan still passes exactly the same
schema and safety validation as a compiled one.

## Scope

This example covers one route and one class of flaw. Juice Shop contains many more, and the
existing oracles (`state-mutation`, `metamorphic-response`) could be pointed at several of them.
That is a good next exercise; the point here is a reproducible, honest end-to-end path from a
running container to a replayable finding.
