#!/bin/sh
set -e

GHOST_URL="${GHOST_URL:-http://localhost:2368}"
WORKER_URL="${WORKER_URL:-http://localhost:8787}"
MAILPIT_URL="${MAILPIT_URL:-http://localhost:8025}"
CONTAINER="${GHOST_CONTAINER:-ghostgift-ghost}"
ADMIN_EMAIL="${GHOST_ADMIN_EMAIL:-admin@example.com}"
ADMIN_PASSWORD="${GHOST_ADMIN_PASSWORD:-Tr0ub4dor&3horse}"
GHOST_API="$GHOST_URL/ghost/api/admin"
COOKIE_JAR=$(mktemp)
trap 'rm -f "$COOKIE_JAR"' EXIT

# -- Helpers --

check_service() {
  if ! curl -s -o /dev/null -w '' --max-time 2 "$1" 2>/dev/null; then
    echo "ERROR: $2 not responding at $1"
    echo "Run: docker compose -f docker-compose.dev.yml up -d"
    exit 1
  fi
}

wait_for_ghost_api() {
  echo "Waiting for Ghost API..."
  for i in $(seq 1 60); do
    if curl -s --max-time 2 "$GHOST_API/authentication/setup" 2>/dev/null | grep -q '"setup"'; then
      return
    fi
    sleep 1
  done
  echo "ERROR: Ghost API did not become ready after 60s"
  exit 1
}

# Authenticated Admin API request using session cookie
ghost_api() {
  METHOD="$1"; ENDPOINT="$2"; shift 2
  curl -s -b "$COOKIE_JAR" -X "$METHOD" "$GHOST_API/$ENDPOINT" \
    -H "Content-Type: application/json" \
    -H "Origin: $GHOST_URL" "$@"
}

# -- 1. Check services --

echo "==> Checking services"
check_service "$GHOST_URL" "Ghost"
check_service "$MAILPIT_URL" "Mailpit"

# -- 2. Reset Ghost to fresh state --

echo "==> Resetting Ghost database"
docker exec "$CONTAINER" sh -c 'rm -f /var/lib/ghost/content/data/ghost.db'
docker restart "$CONTAINER" > /dev/null
wait_for_ghost_api

# -- 3. Ghost initial setup + login --

echo "==> Running Ghost setup"
curl -s -o /dev/null -X POST "$GHOST_API/authentication/setup" \
  -H "Content-Type: application/json" \
  -d "{\"setup\":[{\"name\":\"Test Admin\",\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\",\"blogTitle\":\"Gift Link Test\",\"status\":\"active\"}]}"

curl -s -o /dev/null -c "$COOKIE_JAR" -X POST "$GHOST_API/session" \
  -H "Content-Type: application/json" \
  -H "Origin: $GHOST_URL" \
  -d "{\"username\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}"

# -- 4. Get paid tier ID --

PAID_TIER_ID=$(ghost_api GET "tiers/" \
  | python3 -c "import sys,json; tiers=json.load(sys.stdin)['tiers']; print(next(t['id'] for t in tiers if t['type']=='paid'))")
echo "    Paid tier: $PAID_TIER_ID"

# -- 5. Create members --

echo "==> Creating members"
ghost_api POST "members/" \
  -d "{\"members\":[{\"email\":\"bot@giftlinks.net\",\"name\":\"Gift Link Bot\",\"tiers\":[{\"id\":\"$PAID_TIER_ID\"}]}]}" > /dev/null
echo "    bot@giftlinks.net (comped)"

ghost_api POST "members/" \
  -d "{\"members\":[{\"email\":\"paid@example.com\",\"name\":\"Paid Member\",\"tiers\":[{\"id\":\"$PAID_TIER_ID\"}]}]}" > /dev/null
echo "    paid@example.com (comped)"

# -- 6. Create paywalled test post --

echo "==> Creating test post"
ghost_api POST "posts/" \
  -d '{"posts":[{"title":"Premium Test Post","mobiledoc":"{\"version\":\"0.3.1\",\"atoms\":[],\"cards\":[],\"markups\":[],\"sections\":[[1,\"p\",[[0,[],0,\"This is the free preview paragraph that everyone can see.\"]]],[1,\"p\",[[0,[],0,\"This is premium content behind the paywall. If you can see this, you have access.\"]]],[1,\"p\",[[0,[],0,\"Here is some more premium content with details about the secret sauce.\"]]],[1,\"p\",[[0,[],0,\"Final paragraph of the premium post.\"]]]]}","status":"published","visibility":"paid"}]}' > /dev/null
echo "    /premium-test-post/ (paid visibility)"

# -- 7. Set code injection --

echo "==> Setting code injection"
SCRIPT_TAG="<script src='$WORKER_URL/client.js' data-gl4g-api='$WORKER_URL' defer></script>"
ghost_api PUT "settings/" \
  -d "{\"settings\":[{\"key\":\"codeinjection_foot\",\"value\":\"$SCRIPT_TAG\"}]}" > /dev/null
echo "    Footer: $SCRIPT_TAG"

# -- 8. Apply D1 migrations --

echo "==> Resetting D1 database"
npx wrangler d1 execute giftlinks --local \
  --command "DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS gift_links; DROP TABLE IF EXISTS link_views;" \
  > /dev/null 2>&1
for migration in migrations/*.sql; do
  npx wrangler d1 execute giftlinks --local --file "$migration" > /dev/null 2>&1
done
curl -s -X DELETE "$MAILPIT_URL/api/v1/messages" > /dev/null

# -- 9. Set up bot session --

echo "==> Setting up bot session"

if ! curl -s -o /dev/null --max-time 2 "$WORKER_URL/client.js" 2>/dev/null; then
  echo "WARNING: Worker not running at $WORKER_URL — skipping bot session setup"
  echo "Run 'npm run dev' then re-run this script."
  echo ""
  echo "Done (partial). Ghost ready, D1 ready."
  exit 0
fi

if ! curl -sf -X POST "$WORKER_URL/api/setup" -d "url=$GHOST_URL" > /dev/null; then
  echo "WARNING: Setup form failed"
  exit 1
fi

# Poll Mailpit for the email (up to 5 seconds)
MESSAGE_ID=""
for i in $(seq 1 10); do
  sleep 0.5
  MESSAGE_ID=$(curl -s "$MAILPIT_URL/api/v1/messages" | grep -o '"ID":"[^"]*"' | head -1 | cut -d'"' -f4)
  if [ -n "$MESSAGE_ID" ]; then
    break
  fi
done
if [ -z "$MESSAGE_ID" ]; then
  echo "WARNING: No email received from Ghost"
  exit 1
fi

# Download raw email to temp file, feed to worker (avoids shell string mangling)
TMPFILE=$(mktemp)
curl -s -o "$TMPFILE" "$MAILPIT_URL/api/v1/message/$MESSAGE_ID/raw"
RESULT=$(curl -s -X POST "$WORKER_URL/dev/simulate-email" \
  -H "Content-Type: application/octet-stream" \
  --data-binary "@$TMPFILE")
rm -f "$TMPFILE"
if echo "$RESULT" | grep -q '"ok":true'; then
  echo "    Bot session stored"
else
  echo "WARNING: Bot session setup failed. Response: $RESULT"
fi

# -- Done --

echo ""
echo "Done. Local environment ready:"
echo "  Ghost:   $GHOST_URL (admin: $ADMIN_EMAIL)"
echo "  Mailpit: $MAILPIT_URL"
echo "  Worker:  $WORKER_URL"
echo "  Members: bot@giftlinks.net (bot), paid@example.com (paid)"
echo ""
echo "To test: sign in as paid@example.com via Mailpit, visit a premium post."
