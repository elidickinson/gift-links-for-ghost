#!/bin/sh
# Dump key D1 tables to stdout. Defaults to remote; use --local for local DB.
set -e

FLAG="${1:---remote}"

query() {
  npx wrangler d1 execute giftlinks "$FLAG" --json --command "$1" 2>/dev/null \
    | python3 -c "
import sys, json
from datetime import datetime, timezone
def fmt_ts(v):
  try: return datetime.fromtimestamp(int(v)/1000, tz=timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
  except: return v
TS_COLS = {'created_at','viewed_at','expired_at'}
raw = sys.stdin.read()
try: data = json.loads(raw)
except: print('  (error: ' + raw[:100] + ')'); sys.exit()
if isinstance(data, dict) and 'error' in data:
  print('  (error: ' + data['error'] + ')'); sys.exit()
rows = data[0]['results']
if not rows: print('  (empty)'); sys.exit()
for r in rows:
  for c in TS_COLS & r.keys():
    if r[c] is not None: r[c] = fmt_ts(r[c])
cols = list(rows[0].keys())
widths = [max(len(str(r.get(c,''))) for r in rows + [{c:c for c in cols}]) for c in cols]
sep = '+-' + '-+-'.join('-'*w for w in widths) + '-+'
hdr = '| ' + ' | '.join(c.ljust(w) for c,w in zip(cols,widths)) + ' |'
print(sep); print(hdr); print(sep)
for r in rows:
  print('| ' + ' | '.join(str(r.get(c,'')).ljust(w) for c,w in zip(cols,widths)) + ' |')
print(sep)
"
}

echo "=== Sessions ==="
query "SELECT origin, created_at, length(cookies) as cookie_len FROM sessions ORDER BY created_at DESC"

echo "=== Gift Links (last 20) ==="
query "SELECT token, url, email, gifter_name, created_at, expired_at FROM gift_links ORDER BY created_at DESC LIMIT 20"

echo "=== Link Views (last 20) ==="
query "SELECT token, referer_domain, country, viewed_at FROM link_views ORDER BY viewed_at DESC LIMIT 20"

echo "=== Counts ==="
query "SELECT (SELECT count(*) FROM sessions) as sessions, (SELECT count(*) FROM gift_links) as gift_links, (SELECT count(*) FROM gift_links WHERE expired_at IS NULL) as active_links, (SELECT count(*) FROM link_views) as views"
