# OWASP Juice Shop — end-to-end evaluation

This is Trinker's integration target: a real, intentionally vulnerable application, scanned over
real HTTP, producing mechanically confirmed findings that can be replayed.

It exercises all three oracles and both directions in a single run:

| check | oracle | expectation | why it matters |
|---|---|---|---|
| `chk_basket_cross_customer` | differential-authorization | **confirms** | any authenticated customer can read another customer's basket |
| `chk_basket_item_cross_customer_write` | state-mutation | **confirms** | another customer can change the quantity of an item in your basket |
| `chk_basket_items_scope_tampering` | metamorphic-response | **confirms** | `GET /api/BasketItems?BasketId=N` returns whichever basket you name |
| `chk_basket_requires_auth` | differential-authorization | **passes** | an anonymous request is correctly refused with 401 |
| `chk_addresses_scope_tampering` | metamorphic-response | **passes** | `GET /api/Addresss?UserId=N` correctly ignores the parameter |

The last two are negative controls, one per oracle family. A scanner that only ever fires is not
evidence of anything, so this example proves the oracles stay quiet where the application gets
authorization right — and Juice Shop does scope addresses by session even though it does not scope
basket items.

`setup.sh` reads the owner's user id out of their JWT and picks the basket that user genuinely
owns, rather than the first basket that happens to return 200 — reading someone else's basket is
the very flaw under test, so "first readable basket" would have made the owner a non-owner too.

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

# 4. replay a confirmed finding
trinker verify TRK-0001   # and TRK-0003; both are read-only and reproduce exactly

# 5. export a report
trinker report --markdown
```

Tear down with `docker compose down`.

## Expected output

```text
oracle.calibrated  denialStatuses=[200]
finding.confirmed  TRK-0001  high  Broken Object Level Authorization
oracle.calibrated  protectedPaths=[data.quantity] stable=true
finding.confirmed  TRK-0002  high  Unauthorized State Mutation
oracle.calibrated  relation=identical referenceVariant=own-basket deterministic=true
finding.confirmed  TRK-0003  high  Response Varies With a Parameter It Should Not Depend On
check.passed       chk_basket_requires_auth        (denial statuses: 401)
check.passed       chk_addresses_scope_tampering   (all 2 variants satisfied "identical")
scan.completed     2 passed, 3 failed, 0 inconclusive, 0 errored, 0 unavailable

COMPLETE - every planned check produced a verdict; 3 violation(s) confirmed.
```

Exit code **1** — violations were confirmed.

> **Run this against a freshly seeded container.** The state-mutation check writes to the target
> and does not restore it, so a second run against the same container finds the quantity already
> set. Trinker reports that honestly as **inconclusive** — a 2xx with no state change cannot
> distinguish a rejected write from one that set the value it already had — rather than as a pass.
> `trinker verify TRK-0002` likewise answers "could not be re-tested" and exits 3, not "did not
> reproduce". `docker compose down && docker compose up -d` resets it. The other two checks are
> read-only and repeat cleanly.

## What makes the findings trustworthy

Neither oracle concludes "different user got a 200, therefore broken".

**Differential authorization:**

1. Reads the basket as its owner and keeps that response as a **witness**.
2. Requests the same basket three times as a different customer, measuring how the application
   actually denies access rather than assuming 401/403.
3. Confirms only because the other customer's response matched the witness on **both** the HTTP
   status and the sha256 of the entire body — byte-identical, not merely similar.

Against the `chk_basket_requires_auth` check the same oracle sees 401s that match nothing, and
reports `passed`.

**State mutation:** it reads the basket item as its owner, repeats that read twice more to prove
the value is stable, then attempts the write as another customer and reads again. It confirms only
because `data.quantity` actually changed. The write's 200 status is explicitly *not* the evidence —
a server that answers 200 and ignores the request has not been exploited.

**Metamorphic response:** both variants are sent as the *same* customer; only the query parameter
differs. It first repeats the reference variant twice to prove the endpoint is deterministic —
otherwise a timestamp in the body would look like a vulnerability — then compares. On
`/api/BasketItems` the two `BasketId` values return different items, so the caller decides whose
basket contents come back. On `/api/Addresss` the two `UserId` values return byte-identical bodies,
so the same oracle reports `passed`.

Credentials never enter the finding. The recorded witnesses show `authorization: [REDACTED]`, and
the report contains no JWT.

## How the pieces map to Trinker's model

| file | role | committed? |
|---|---|---|
| `plan.json` | the reviewed security artifact: routes, identities by ID, invariants, checks | **yes** — this is the point of a plan |
| `.trinker/runtime.json` | target URL, bearer tokens, basket and basket-item fixtures | **no** — gitignored |
| `setup.sh` | logs in, discovers each customer's own basket and user id, writes runtime.json | yes |

`setup.sh` copies `plan.json` into `.trinker/plan.json` and generates `.trinker/runtime.json`
beside it. The plan refers to `basket_owner`, `other_customer`, `ownedBasket`, and
`ownedBasketItem` by key only, so the same committed plan works against any Juice Shop instance
once runtime config points at it.

Because one check writes, the runtime config sets `mutationAuthorized: true` and the plan sets
`mutationPolicy: "explicit-authorization-required"`. Both are required; neither alone permits a
write, which is what keeps the committed plan safe to merge.

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

Three classes of flaw, one per implemented oracle, plus a negative control for two of them. Juice
Shop contains many more. The point here is a reproducible, honest end-to-end path from a running
container to replayable findings — and evidence that each oracle discriminates rather than simply
firing.
