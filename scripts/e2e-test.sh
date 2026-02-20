#!/bin/sh
# E2E test for the full gift link flow: create as paid member, redeem as anonymous.
#
# Prerequisites:
#   docker compose -f docker-compose.dev.yml up -d   (Ghost + Mailpit)
#   npm run dev                                       (Cloudflare Worker)
#
# Auto-runs scripts/dev-setup.sh if the test post is missing (Ghost was reset).
# Auto-resets Ghost rate limits between runs (scripts/reset-ratelimit.sh).
#
# Uses `br` (headless browser CLI) for browser interactions. Kill stale browser
# processes before running if you see hangs: pkill -f headless_shell
#
# Debugging:
#   - On failure, the browser DOM is dumped automatically (fail function)
#   - For deeper tracing: bash -x scripts/e2e-test.sh
#   - UI assertions use `br eval` with DOM selectors — text-independent
set -e

GHOST_URL="${GHOST_URL:-http://localhost:2368}"
WORKER_URL="${WORKER_URL:-http://localhost:8787}"
MAILPIT_URL="${MAILPIT_URL:-http://localhost:8025}"
POST_PATH="/premium-test-post/"

PASS=0

cleanup() { br stop > /dev/null 2>&1 || true; }
trap cleanup EXIT

# Warn about stale processes that cause hangs and port conflicts
STALE_WRANGLER=$(pgrep -fc "wrangler.*dev" 2>/dev/null || true)
STALE_CHROME=$(pgrep -fc "headless_shell" 2>/dev/null || true)
if [ "$STALE_WRANGLER" -gt 1 ] 2>/dev/null; then
  echo "WARNING: $STALE_WRANGLER wrangler dev processes running (expect 1). Kill extras: pkill -f 'wrangler.*dev'"
fi
if [ "$STALE_CHROME" -gt 0 ] 2>/dev/null; then
  echo "WARNING: $STALE_CHROME stale headless_shell processes. Kill them: pkill -f headless_shell"
fi

fail() {
  echo "  FAIL: $1"
  echo ""
  echo "--- browser state at failure ---"
  br eval "location.href" 2>&1 || true
  echo ""
  br view-tree 2>&1 | head -40 || true
  echo "--- end ---"
  exit 1
}

# Fail with the actual value shown (for non-browser assertions like API responses)
fail_value() {
  echo "  FAIL: $1"
  echo "    got: $2"
  exit 1
}

pass() {
  echo "  PASS: $1"
  PASS=$((PASS + 1))
}

# Assert a string contains a pattern. Shows actual value on mismatch (not browser DOM).
assert_contains() {
  if echo "$1" | grep -q "$2"; then pass "$3"; else fail_value "$3 (expected: $2)" "$1"; fi
}

# Assert a browser tree contains a pattern. Shows browser DOM on mismatch.
assert_page() {
  if echo "$1" | grep -q "$2"; then pass "$3"; else fail "$3 (expected: $2)"; fi
}

# -- 1. Prereq checks --

echo "==> Checking services"
curl -sf --max-time 2 "$GHOST_URL" > /dev/null || fail "Ghost not responding at $GHOST_URL"
pass "Ghost responding"
curl -sf --max-time 2 "$WORKER_URL/client.js" > /dev/null || fail "Worker not responding at $WORKER_URL"
pass "Worker responding"

# -- 1b. Run dev-setup if Ghost content is missing --

if ! curl -sf --max-time 2 "$GHOST_URL$POST_PATH" > /dev/null 2>&1; then
  echo "==> Ghost not configured, running dev-setup..."
  scripts/dev-setup.sh
fi

# -- 2. Reset rate limits (repeated test runs trigger brute-force protection) --

scripts/reset-ratelimit.sh

# -- 3. Set up bot session via setup form --

echo "==> Setting up bot session"
curl -s -X DELETE "$MAILPIT_URL/api/v1/messages" > /dev/null

curl -sf -X POST "$WORKER_URL/api/setup" -d "url=$GHOST_URL" > /dev/null || fail "Setup form request failed"
pass "Setup form returns success"

# Poll Mailpit for bot magic link email
BOT_MESSAGE_ID=""
for i in $(seq 1 10); do
  sleep 0.5
  BOT_MESSAGE_ID=$(curl -s "$MAILPIT_URL/api/v1/messages" \
    | grep -o '"ID":"[^"]*"' | head -1 | cut -d'"' -f4)
  if [ -n "$BOT_MESSAGE_ID" ]; then break; fi
done
test -n "$BOT_MESSAGE_ID" || fail "No bot magic link email received"

# Feed raw email to worker to store bot session
TMPFILE=$(mktemp)
curl -s -o "$TMPFILE" "$MAILPIT_URL/api/v1/message/$BOT_MESSAGE_ID/raw"
SIMULATE_RESULT=$(curl -s -X POST "$WORKER_URL/dev/simulate-email" \
  -H "Content-Type: application/octet-stream" --data-binary "@$TMPFILE")
rm -f "$TMPFILE"
assert_contains "$SIMULATE_RESULT" '"ok":true' "Bot session stored"

# -- 4. Start browser, sign in as paid member --

echo "==> Signing in as paid member"
br stop > /dev/null 2>&1 || true
br start --headless > /dev/null 2>&1

# Clear Mailpit, request magic link for paid member
curl -s -X DELETE "$MAILPIT_URL/api/v1/messages" > /dev/null
INTEGRITY_TOKEN=$(curl -s "$GHOST_URL/members/api/integrity-token")
curl -s -o /dev/null -X POST "$GHOST_URL/members/api/send-magic-link" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"paid@example.com\",\"emailType\":\"signin\",\"integrityToken\":\"$INTEGRITY_TOKEN\"}"

# Poll Mailpit for magic link (parsed JSON — raw body is base64-encoded)
MAGIC_LINK=""
for i in $(seq 1 10); do
  sleep 0.5
  MESSAGE_ID=$(curl -s "$MAILPIT_URL/api/v1/messages" \
    | grep -o '"ID":"[^"]*"' | head -1 | cut -d'"' -f4)
  if [ -n "$MESSAGE_ID" ]; then
    MAGIC_LINK=$(curl -s "$MAILPIT_URL/api/v1/message/$MESSAGE_ID" \
      | grep -o 'http[^"]*\/members\/[?]token=[A-Za-z0-9_-]*\\u0026action=signin' \
      | sed 's/\\u0026/\&/' | head -1)
    break
  fi
done
test -n "$MAGIC_LINK" || fail "No magic link found in Mailpit (message ID: ${MESSAGE_ID:-none})"
pass "Magic link received"

# Follow magic link in browser to get session cookies
br goto "$MAGIC_LINK" > /dev/null 2>&1
sleep 2

# -- 5. Visit paywalled post as paid member --

echo "==> Visiting paywalled post as paid member"
br goto "${GHOST_URL}${POST_PATH}" > /dev/null 2>&1
sleep 3

HAS_BUTTON=$(br eval "document.querySelector('.gl4g-button') !== null" 2>&1)
assert_contains "$HAS_BUTTON" "true" "Gift button visible"

# -- 6. Create gift link --

echo "==> Creating gift link"
br click ".gl4g-button" > /dev/null 2>&1
sleep 2

CURRENT_URL=$(br eval "location.href" 2>&1)
assert_contains "$CURRENT_URL" "gift=" "Gift token in URL"
GIFT_URL=$(echo "$CURRENT_URL" | grep -o 'http[^ ]*')
echo "    $GIFT_URL"

HAS_BAR=$(br eval "document.querySelector('.gl4g-bar') !== null" 2>&1)
assert_contains "$HAS_BAR" "true" "Confirmation banner shown"

# -- 7. Redeem via API (no cookies, proves bot session fetched the content) --

echo "==> Redeeming gift link via API"
GIFT_TOKEN=$(echo "$GIFT_URL" | grep -o 'gift=[^&]*' | cut -d= -f2)
REDEEM_BODY=$(curl -s -X POST "$WORKER_URL/api/gift-link/fetch-content" \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"$GIFT_TOKEN\",\"url\":\"${GHOST_URL}${POST_PATH}\"}")
assert_contains "$REDEEM_BODY" "premium content behind the paywall" "API returns premium content"

# -- 8. Redeem in browser as anonymous visitor --

echo "==> Redeeming gift link in browser"
# Restart browser to clear httpOnly session cookies
br stop > /dev/null 2>&1
br start --headless > /dev/null 2>&1

br goto "$GIFT_URL" > /dev/null 2>&1
sleep 3

HAS_BAR=$(br eval "document.querySelector('.gl4g-bar') !== null" 2>&1)
assert_contains "$HAS_BAR" "true" "Gift banner visible"

# Paywall gate should be gone
if echo "$TREE" | grep -q "gh-post-upgrade-cta"; then
  fail "Paywall gate still present"
fi
pass "Paywall gate removed"

# -- 9. Forged JWT rejected --

echo "==> Creating gift link with forged JWT"
FORGED_HEADER=$(printf '{"alg":"RS512","typ":"JWT"}' | base64 | tr -d '=')
FORGED_PAYLOAD=$(printf '{"sub":"forger@evil.com","iss":"%s/members/api","aud":"%s/members/api"}' "$GHOST_URL" "$GHOST_URL" | base64 | tr -d '=')
FORGED_JWT="${FORGED_HEADER}.${FORGED_PAYLOAD}.fake-signature"

FORGED_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$WORKER_URL/api/gift-link/create" \
  -H "Content-Type: application/json" \
  -d "{\"jwt\":\"$FORGED_JWT\",\"url\":\"${GHOST_URL}${POST_PATH}\",\"gifter_name\":\"Forger\"}")
if [ "$FORGED_STATUS" = "401" ]; then pass "Forged JWT returns 401"; else fail "Forged JWT returns 401 (got: $FORGED_STATUS)"; fi

FORGED_BODY=$(curl -s -X POST "$WORKER_URL/api/gift-link/create" \
  -H "Content-Type: application/json" \
  -d "{\"jwt\":\"$FORGED_JWT\",\"url\":\"${GHOST_URL}${POST_PATH}\",\"gifter_name\":\"Forger\"}")
assert_contains "$FORGED_BODY" '"invalid_token"' "Forged JWT error body contains invalid_token"

# -- 10. Bogus token shows normal paywall --

echo "==> Visiting with bogus gift token"
br goto "${GHOST_URL}${POST_PATH}?gift=bogus-token" > /dev/null 2>&1
sleep 3

TREE=$(br view-tree 2>&1)
assert_page "$TREE" "for paying subscribers only" "Paywall gate still shown for bogus token"

# -- 11. Theme-placed button --

echo "==> Testing theme-placed button"

# Authenticate with Ghost Admin API
ADMIN_COOKIE=$(mktemp)
ADMIN_EMAIL="${GHOST_ADMIN_EMAIL:-admin@example.com}"
ADMIN_PASSWORD="${GHOST_ADMIN_PASSWORD:-Tr0ub4dor&3horse}"
scripts/reset-ratelimit.sh
curl -s -o /dev/null -c "$ADMIN_COOKIE" -X POST "$GHOST_URL/ghost/api/admin/session" \
  -H "Content-Type: application/json" \
  -H "Origin: $GHOST_URL" \
  -d "{\"username\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}"

# Inject theme button via code injection (appended to existing client.js script tag)
INJECT_JSON=$(WORKER_URL="$WORKER_URL" python3 << 'PYEOF'
import json, os
worker = os.environ["WORKER_URL"]
script = f"<script src='{worker}/client.js' data-gl4g-api='{worker}' defer></script>"
button = '<div class="gl4g-button-wrapper" style="display:none"><a href="#" class="gl4g-button gh-btn">Gift this article</a></div>'
print(json.dumps({"settings": [{"key": "codeinjection_foot", "value": script + button}]}))
PYEOF
)
curl -s -o /dev/null -b "$ADMIN_COOKIE" -X PUT "$GHOST_URL/ghost/api/admin/settings/" \
  -H "Content-Type: application/json" \
  -H "Origin: $GHOST_URL" \
  -d "$INJECT_JSON"

# Sign in as paid member (fresh browser)
br stop > /dev/null 2>&1 || true
br start --headless > /dev/null 2>&1

curl -s -X DELETE "$MAILPIT_URL/api/v1/messages" > /dev/null
INTEGRITY_TOKEN=$(curl -s "$GHOST_URL/members/api/integrity-token")
curl -s -o /dev/null -X POST "$GHOST_URL/members/api/send-magic-link" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"paid@example.com\",\"emailType\":\"signin\",\"integrityToken\":\"$INTEGRITY_TOKEN\"}"

MAGIC_LINK=""
for i in $(seq 1 10); do
  sleep 0.5
  MESSAGE_ID=$(curl -s "$MAILPIT_URL/api/v1/messages" \
    | grep -o '"ID":"[^"]*"' | head -1 | cut -d'"' -f4)
  if [ -n "$MESSAGE_ID" ]; then
    MAGIC_LINK=$(curl -s "$MAILPIT_URL/api/v1/message/$MESSAGE_ID" \
      | grep -o 'http[^"]*\/members\/[?]token=[A-Za-z0-9_-]*\\u0026action=signin' \
      | sed 's/\\u0026/\&/' | head -1)
    break
  fi
done
test -n "$MAGIC_LINK" || fail "No magic link for theme button test"
br goto "$MAGIC_LINK" > /dev/null 2>&1
sleep 2

# Visit paywalled post — client.js should find theme button, not create floating one
br goto "${GHOST_URL}${POST_PATH}" > /dev/null 2>&1
sleep 3

# Wrapper should be unhidden
WRAPPER_DISPLAY=$(br eval "document.querySelector('.gl4g-button-wrapper')?.style.display" 2>&1)
assert_contains "$WRAPPER_DISPLAY" '""' "Theme button wrapper unhidden"

# Only one .gl4g-button should exist (the theme one, no auto-created floating button)
BUTTON_COUNT=$(br eval "document.querySelectorAll('.gl4g-button').length" 2>&1)
assert_contains "$BUTTON_COUNT" "1" "Single theme button (no duplicate)"

# Click handler should work (button gets disabled during creation)
br click ".gl4g-button" > /dev/null 2>&1
sleep 1
BUTTON_DISABLED=$(br eval "document.querySelector('.gl4g-button')?.disabled" 2>&1)
assert_contains "$BUTTON_DISABLED" "true" "Theme button click handler attached"

# Restore original code injection (remove theme button)
RESTORE_JSON=$(WORKER_URL="$WORKER_URL" python3 << 'PYEOF'
import json, os
worker = os.environ["WORKER_URL"]
script = f"<script src='{worker}/client.js' data-gl4g-api='{worker}' defer></script>"
print(json.dumps({"settings": [{"key": "codeinjection_foot", "value": script}]}))
PYEOF
)
curl -s -o /dev/null -b "$ADMIN_COOKIE" -X PUT "$GHOST_URL/ghost/api/admin/settings/" \
  -H "Content-Type: application/json" \
  -H "Origin: $GHOST_URL" \
  -d "$RESTORE_JSON"

# -- 12. Configurable content selector (data-gl4g-content) --

echo "==> Testing data-gl4g-content config"

# Inject script with explicit content selector pointing at Ghost default
CONTENT_JSON=$(WORKER_URL="$WORKER_URL" python3 << 'PYEOF'
import json, os
worker = os.environ["WORKER_URL"]
script = f"<script src='{worker}/client.js' data-gl4g-api='{worker}' data-gl4g-content='section.gh-content' defer></script>"
print(json.dumps({"settings": [{"key": "codeinjection_foot", "value": script}]}))
PYEOF
)
curl -s -o /dev/null -b "$ADMIN_COOKIE" -X PUT "$GHOST_URL/ghost/api/admin/settings/" \
  -H "Content-Type: application/json" \
  -H "Origin: $GHOST_URL" \
  -d "$CONTENT_JSON"

# Fresh browser, sign in as paid member
br stop > /dev/null 2>&1 || true
br start --headless > /dev/null 2>&1

curl -s -X DELETE "$MAILPIT_URL/api/v1/messages" > /dev/null
scripts/reset-ratelimit.sh
INTEGRITY_TOKEN=$(curl -s "$GHOST_URL/members/api/integrity-token")
curl -s -o /dev/null -X POST "$GHOST_URL/members/api/send-magic-link" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"paid@example.com\",\"emailType\":\"signin\",\"integrityToken\":\"$INTEGRITY_TOKEN\"}"

MAGIC_LINK=""
for i in $(seq 1 10); do
  sleep 0.5
  MESSAGE_ID=$(curl -s "$MAILPIT_URL/api/v1/messages" \
    | grep -o '"ID":"[^"]*"' | head -1 | cut -d'"' -f4)
  if [ -n "$MESSAGE_ID" ]; then
    MAGIC_LINK=$(curl -s "$MAILPIT_URL/api/v1/message/$MESSAGE_ID" \
      | grep -o 'http[^"]*\/members\/[?]token=[A-Za-z0-9_-]*\\u0026action=signin' \
      | sed 's/\\u0026/\&/' | head -1)
    break
  fi
done
test -n "$MAGIC_LINK" || fail "No magic link for content selector test"
br goto "$MAGIC_LINK" > /dev/null 2>&1
sleep 2

br goto "${GHOST_URL}${POST_PATH}" > /dev/null 2>&1
sleep 3

HAS_BUTTON=$(br eval "document.querySelector('.gl4g-button') !== null" 2>&1)
assert_contains "$HAS_BUTTON" "true" "Gift button visible with data-gl4g-content"

# Restore original code injection
curl -s -o /dev/null -b "$ADMIN_COOKIE" -X PUT "$GHOST_URL/ghost/api/admin/settings/" \
  -H "Content-Type: application/json" \
  -H "Origin: $GHOST_URL" \
  -d "$RESTORE_JSON"
rm -f "$ADMIN_COOKIE"

# -- Done --

echo ""
echo "All $PASS checks passed."
