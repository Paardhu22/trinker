#!/usr/bin/env bash
#
# Prepare a Juice Shop scan: log in as two seeded customers, discover a basket to target, and
# write .trinker/runtime.json.
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

if ! curl -fsS -m 10 -o /dev/null "$BASE/"; then
  say "Juice Shop is not reachable at $BASE"
  say "Start it with:  docker compose up -d"
  exit 1
fi

login() {
  local email="$1" password="$2" token
  token=$(curl -fsS -m 15 -X POST "$BASE/rest/user/login" \
    -H 'content-type: application/json' \
    -d "$(printf '{"email":%s,"password":%s}' "$(printf '%s' "$email" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" "$(printf '%s' "$password" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')")" \
    | python3 -c 'import json,sys;print(json.load(sys.stdin)["authentication"]["token"])')
  if [ -z "$token" ]; then say "Login failed for $email"; exit 1; fi
  printf '%s' "$token"
}

say "Logging in as $OWNER_EMAIL …"
OWNER_TOKEN=$(login "$OWNER_EMAIL" "$OWNER_PASSWORD")
say "Logging in as $OTHER_EMAIL …"
OTHER_TOKEN=$(login "$OTHER_EMAIL" "$OTHER_PASSWORD")

# Find a basket the owner can actually read, so the check has a valid reference response.
BASKET_ID=""
for candidate in 1 2 3 4 5 6; do
  if curl -fsS -m 10 -o /dev/null -H "authorization: Bearer $OWNER_TOKEN" "$BASE/rest/basket/$candidate"; then
    BASKET_ID="$candidate"
    break
  fi
done
if [ -z "$BASKET_ID" ]; then
  say "Could not find a readable basket. Is this a freshly seeded Juice Shop?"
  exit 1
fi
say "Using basket $BASKET_ID as the fixture."

mkdir -p "$TRINKER_DIR"
cp "$HERE/plan.json" "$TRINKER_DIR/plan.json"

OWNER_TOKEN="$OWNER_TOKEN" OTHER_TOKEN="$OTHER_TOKEN" BASKET_ID="$BASKET_ID" BASE="$BASE" \
python3 - "$TRINKER_DIR/runtime.json" <<'PY'
import json, os, sys
runtime = {
    "targets": {"local": {"url": os.environ["BASE"], "allowHosts": []}},
    "identities": {
        "basket_owner": {"headers": {"authorization": f"Bearer {os.environ['OWNER_TOKEN']}"}},
        "other_customer": {"headers": {"authorization": f"Bearer {os.environ['OTHER_TOKEN']}"}},
        # identity_anonymous has no credentialRef entry on purpose: it sends no auth header,
        # which is the negative control proving the oracle does not simply always fire.
    },
    "fixtures": {"ownedBasket": {"id": os.environ["BASKET_ID"]}},
    "values": {},
    "mutationAuthorized": False,
}
with open(sys.argv[1], "w") as handle:
    json.dump(runtime, handle, indent=2)
    handle.write("\n")
PY

say ""
say "Wrote $TRINKER_DIR/plan.json and $TRINKER_DIR/runtime.json"
say "Now run:  (cd $HERE && trinker run)"
