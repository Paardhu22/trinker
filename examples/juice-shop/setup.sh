#!/usr/bin/env bash
#
# Prepare a Juice Shop scan: log in as two seeded customers, discover fixtures that the first
# customer genuinely owns, and write .trinker/runtime.json.
#
# Credentials only ever reach runtime.json, which is gitignored. The committed plan.json refers to
# these identities by key and never holds a token.
#
# Usage:  ./setup.sh [base-url]
set -euo pipefail

BASE="${1:-http://localhost:3000}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRINKER_DIR="$HERE/.trinker"

# Seeded Juice Shop accounts. These are public demo credentials for an intentionally vulnerable
# application, not secrets.
OWNER_EMAIL="jim@juice-sh.op"
OWNER_PASSWORD="ncc-1701"
OTHER_EMAIL="bender@juice-sh.op"
OTHER_PASSWORD='OhG0dPlease1nsertLiquor!'

say() { printf '%s\n' "$*" >&2; }
die() { say "$*"; exit 1; }

curl -fsS -m 10 -o /dev/null "$BASE/" || die "Juice Shop is not reachable at $BASE. Start it with: docker compose up -d"

json_string() { python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$1"; }

login() {
  local token
  token=$(curl -fsS -m 15 -X POST "$BASE/rest/user/login" \
    -H 'content-type: application/json' \
    -d "{\"email\":$(json_string "$1"),\"password\":$(json_string "$2")}" \
    | python3 -c 'import json,sys;print(json.load(sys.stdin)["authentication"]["token"])')
  [ -n "$token" ] || die "Login failed for $1"
  printf '%s' "$token"
}

# The user id is in the JWT payload. Reading it is what lets us pick a basket the owner genuinely
# owns, rather than merely one they can read — the whole point of the example is the distinction.
user_id_of() {
  python3 -c '
import base64, json, sys
payload = sys.argv[1].split(".")[1]
payload += "=" * (-len(payload) % 4)
print(json.loads(base64.urlsafe_b64decode(payload))["data"]["id"])' "$1"
}

say "Logging in as $OWNER_EMAIL …"
OWNER_TOKEN=$(login "$OWNER_EMAIL" "$OWNER_PASSWORD")
say "Logging in as $OTHER_EMAIL …"
OTHER_TOKEN=$(login "$OTHER_EMAIL" "$OTHER_PASSWORD")

OWNER_ID=$(user_id_of "$OWNER_TOKEN")
say "Owner is user $OWNER_ID."

# Find the basket whose UserId is the owner's. Reading someone else's basket is the very flaw under
# test, so picking "the first basket that returns 200" would make the owner a non-owner too.
BASKET_ID=""
for candidate in $(seq 1 8); do
  body=$(curl -fsS -m 10 -H "authorization: Bearer $OWNER_TOKEN" "$BASE/rest/basket/$candidate" 2>/dev/null) || continue
  owner_of=$(printf '%s' "$body" | python3 -c 'import json,sys;print(json.load(sys.stdin)["data"].get("UserId",""))' 2>/dev/null) || continue
  if [ "$owner_of" = "$OWNER_ID" ]; then
    BASKET_ID="$candidate"
    # A basket item inside the owner's own basket, for the state-mutation check.
    BASKET_ITEM_ID=$(printf '%s' "$body" | python3 -c '
import json, sys
products = json.load(sys.stdin)["data"].get("Products", [])
items = [p["BasketItem"]["id"] for p in products if p.get("BasketItem")]
print(items[0] if items else "")')
    break
  fi
done
[ -n "$BASKET_ID" ] || die "Could not find a basket owned by user $OWNER_ID. Is this a freshly seeded Juice Shop?"
[ -n "${BASKET_ITEM_ID:-}" ] || die "Basket $BASKET_ID has no items, so the state-mutation check has nothing to observe."
say "Owner's basket is $BASKET_ID, containing basket item $BASKET_ITEM_ID."

mkdir -p "$TRINKER_DIR"
cp "$HERE/plan.json" "$TRINKER_DIR/plan.json"

OWNER_TOKEN="$OWNER_TOKEN" OTHER_TOKEN="$OTHER_TOKEN" BASKET_ID="$BASKET_ID" \
BASKET_ITEM_ID="$BASKET_ITEM_ID" BASE="$BASE" \
python3 - "$TRINKER_DIR/runtime.json" <<'PY'
import json, os, sys
runtime = {
    "targets": {"local": {"url": os.environ["BASE"], "allowHosts": []}},
    "identities": {
        "basket_owner": {"headers": {"authorization": f"Bearer {os.environ['OWNER_TOKEN']}"}},
        "other_customer": {"headers": {"authorization": f"Bearer {os.environ['OTHER_TOKEN']}"}},
        # identity_anonymous has no entry on purpose: it sends no auth header, which is the
        # negative control proving the oracle does not simply always fire.
    },
    "fixtures": {
        "ownedBasket": {"id": os.environ["BASKET_ID"]},
        "ownedBasketItem": {"id": os.environ["BASKET_ITEM_ID"]},
    },
    "values": {},
    # The state-mutation check writes to the target. Both this and the plan's mutationPolicy must
    # allow it; neither alone is enough.
    "mutationAuthorized": True,
}
with open(sys.argv[1], "w") as handle:
    json.dump(runtime, handle, indent=2)
    handle.write("\n")
PY

say ""
say "Wrote $TRINKER_DIR/plan.json and $TRINKER_DIR/runtime.json"
say "Now run:  (cd $HERE && trinker run)"
