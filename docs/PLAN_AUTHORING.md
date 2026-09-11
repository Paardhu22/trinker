# Plan Authoring

Run `trinker compile` first. It extracts routes and writes a valid, empty starter plan. It deliberately does not invent authorization claims.

Add reviewed identities, fixtures, invariants, and checks before running an authorization scan. Keep all values that identify a deployment, authenticate, or otherwise carry secrets in `.trinker/runtime.json`.

```json
{
  "identities": [
    { "id": "identity_owner", "credentialRef": "owner", "roles": ["user"], "capabilities": [] },
    { "id": "identity_peer", "credentialRef": "peer", "roles": ["user"], "capabilities": [] }
  ],
  "fixtures": [
    { "id": "fixture_order", "runtimeRef": "orderOwnedByOwner", "ownerIdentityId": "identity_owner" }
  ],
  "invariants": [
    {
      "id": "inv_order_owner_only",
      "kind": "authorization",
      "statement": "Only the owner may retrieve this order.",
      "routeIds": ["route_get_api_orders_id_d57bfb5a"],
      "provenance": "manual"
    }
  ]
}
```

The corresponding check uses the deterministic oracle:

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

The runtime file supplies matching local-only data:

```json
{
  "targets": { "local": { "url": "http://localhost:3000", "allowHosts": [] } },
  "identities": {
    "owner": { "headers": { "authorization": "Bearer local-owner-token" } },
    "peer": { "headers": { "authorization": "Bearer local-peer-token" } }
  },
  "fixtures": { "orderOwnedByOwner": { "id": "42" } },
  "mutationAuthorized": false
}
```

Run `trinker run --ci --format sarif` for automation or `trinker` for the interactive shell. The normal run path consumes no LLM tokens.
