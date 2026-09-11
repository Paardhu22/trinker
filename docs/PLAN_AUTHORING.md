# Plan Authoring

Run `trinker compile` first. It extracts routes and writes a valid starter plan with **no checks**.
It deliberately does not invent authorization claims — deciding who may access what is a human
judgement.

Recompiling after a code change **preserves** everything you author here. If a check's route
disappears, compile refuses to write and names the check rather than silently dropping it.

## The two files

`.trinker/plan.json` is committed and reviewed. It holds routes, identities, fixtures, invariants,
checks, and the safety policy — all referring to runtime data **by key only**.

`.trinker/runtime.json` is gitignored. It holds the target URL, credentials, fixture data, and
runtime values.

Zod rejects a plan containing a credential-like value, so this separation is enforced, not merely
advised:

```jsonc
// rejected: "Plans may not contain inline credential-like values"
"headerBindings": { "authorization": { "literal": "Bearer abc" } }

// accepted: a reference the runtime config resolves
"headerBindings": { "authorization": { "runtimeRef": "ownerToken" } }
```

## Value bindings

| binding | resolves from | appears in evidence? |
|---|---|---|
| `{ "literal": "abc" }` | the plan itself | yes |
| `{ "fixtureRef": "fixture_order", "field": "id" }` | `runtime.fixtures.<runtimeRef>.<field>` | yes — a finding about object 42 is unreadable if 42 is hidden |
| `{ "runtimeRef": "tenantId" }` | `runtime.values.<key>` | **no** — treated as secret and masked wherever recorded |

Put test data in `fixtures` and anything deployment-specific or secret in `values`. A missing
reference is a loud error, never a silently skipped check.

Bindings work in `pathBindings`, `queryBindings`, `headerBindings`, and nested anywhere inside a
request `body`.

## Identities

```json
{
  "identities": [
    { "id": "identity_owner", "credentialRef": "owner", "roles": ["user"], "capabilities": [] },
    { "id": "identity_peer", "credentialRef": "peer", "roles": ["user"], "capabilities": [] },
    { "id": "identity_anonymous", "roles": [], "capabilities": [] }
  ]
}
```

`credentialRef` names an entry in `runtime.identities`. An identity with **no** `credentialRef`
entry sends no authentication headers — that is how you express an anonymous caller, which makes a
useful negative control.

## Authorization check (`differential-authorization`)

Confirms Broken Object Level Authorization. It confirms only when a denied identity's response
matches an allowed identity's witness on **both** status and full-body sha256.

```json
{
  "id": "chk_order_owner_only",
  "invariantId": "inv_order_owner_only",
  "enabled": true,
  "oracle": "differential-authorization",
  "request": {
    "routeId": "route_get_api_orders_id_d57bfb5a",
    "pathBindings": { "id": { "fixtureRef": "fixture_order", "field": "id" } },
    "queryBindings": {},
    "headerBindings": {}
  },
  "allowedIdentityIds": ["identity_owner"],
  "deniedIdentityIds": ["identity_peer"],
  "calibration": { "trials": 3 }
}
```

`trials` controls how many times each denied identity is sampled, which is how the oracle learns
the application's real denial behaviour instead of assuming 401/403.

## State mutation check (`state-mutation`)

Confirms that an unauthorized identity **changed** protected state. A 200 response is not evidence;
the value must actually differ.

```json
{
  "id": "chk_order_owner_writes",
  "invariantId": "inv_order_owner_writes",
  "enabled": true,
  "oracle": "state-mutation",
  "request": {
    "routeId": "route_patch_api_orders_id_39392b30",
    "pathBindings": { "id": { "fixtureRef": "fixture_order", "field": "id" } },
    "queryBindings": {},
    "headerBindings": {},
    "body": { "ownerId": "peer" }
  },
  "readRequest": {
    "routeId": "route_get_api_orders_id_d57bfb5a",
    "pathBindings": { "id": { "fixtureRef": "fixture_order", "field": "id" } },
    "queryBindings": {},
    "headerBindings": {}
  },
  "readIdentityId": "identity_owner",
  "unauthorizedIdentityIds": ["identity_peer"],
  "protectedPaths": ["ownerId"],
  "calibration": { "stabilityReads": 1 }
}
```

`protectedPaths` are dotted paths into the read response (`owner.id`, `items.0.price`).
`stabilityReads` are control reads proving the value is stable before any change is attributed to
the mutation — without them, a timestamp would look like a vulnerability.

**This check writes to live state and does not restore it.** It requires
`safety.mutationPolicy: "explicit-authorization-required"` *and* `mutationAuthorized: true` in
runtime config. Both, deliberately: a committed plan alone can never authorize a write.

## Metamorphic check (`metamorphic-response`)

Confirms that a response depends on a parameter it should not. The canonical case is
client-controlled data scoping.

```json
{
  "id": "chk_orders_scoped_by_session",
  "invariantId": "inv_orders_scoped_by_session",
  "enabled": true,
  "oracle": "metamorphic-response",
  "request": {
    "routeId": "route_get_api_orders_6b48c5c5",
    "pathBindings": {}, "queryBindings": {}, "headerBindings": {}
  },
  "identityId": "identity_owner",
  "relation": "identical",
  "variants": [
    { "name": "own-scope", "queryBindings": { "userId": { "literal": "owner" } } },
    { "name": "tampered-scope", "queryBindings": { "userId": { "literal": "someone-else" } } }
  ],
  "calibration": { "stabilityReads": 1 }
}
```

All variants run as the same identity; only the parameters differ. `relation: "identical"` requires
matching status and body. Use `"status-identical"` when the body legitimately varies — an endpoint
whose body carries a timestamp is reported inconclusive under `identical`, not confirmed.

## Runtime configuration

```json
{
  "targets": { "local": { "url": "http://localhost:3000", "allowHosts": [] } },
  "identities": {
    "owner": { "headers": { "authorization": "Bearer local-owner-token" } },
    "peer": { "headers": { "authorization": "Bearer local-peer-token" } }
  },
  "fixtures": { "order": { "id": "42" } },
  "values": { "tenantId": "acme" },
  "mutationAuthorized": false
}
```

Any non-loopback host must be named in that target's `allowHosts`, or the scan aborts before
sending a request.

## Running

```bash
trinker run                      # interactive event stream
trinker run --ci --format sarif  # automation
trinker run --ci --strict        # also fail when a check was inconclusive
trinker coverage                 # planned vs verified routes
trinker verify TRK-0001          # replay one confirmed finding
```

Exit codes: `0` clean and complete · `1` violation confirmed · `2` usage/config error · `3` the
scan could not be trusted (a check errored or had no oracle).

A scan consumes no LLM tokens.

## Checks that do not run

`browser-execution` and `out-of-band` are valid in the schema but have no implementation. A check
naming them validates, then reports `unavailable` — counted separately, shown in every report, and
enough to make the run exit 3. "0 findings" never means "everything was tested".
