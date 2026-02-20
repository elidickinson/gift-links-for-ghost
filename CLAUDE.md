# Gift Links for Ghost

## User Personas

- **App admin (us)** — Develops and operates the Cloudflare Worker. Manages deployments, D1 database, cron jobs, and wrangler config. Not necessarily the same person as the site admin.
- **Site admin** — The Ghost blog owner. Installs the gift link script on their site via code injection. Has access to Ghost Admin. Cares about which posts are being shared, usage volume, and leak detection.
- **Gift link creator** — A paying Ghost member/subscriber. Generates a gift link to share a paywalled post with someone else. Wants a link that works, nothing more.
- **Gift link recipient** — Receives and opens a gift link. Not a Ghost member. Gets access to the post content without signing up or paying.

## Guidelines

- No fallbacks — find the one right way
- Fail fast — let errors surface
- Test fixtures from real output, not invented

## Local Dev

Local Ghost via `docker compose -f docker-compose.dev.yml up -d` — see README for details. Use `br` (headless browser CLI) for interaction: `br view-tree` for accessibility IDs, `br click`/`br type` for input.

## Testing

- Unit tests: `npx vitest run` — runs in workerd via `@cloudflare/vitest-pool-workers`
- E2E: `scripts/e2e-test.sh` — requires Ghost + Mailpit (`docker compose -f docker-compose.dev.yml up -d`) and worker (`npm run dev`)
- E2E sets up its own bot session via the setup form — no pre-seeding needed
- Dev env setup: `scripts/dev-setup.sh` — resets Ghost, creates admin/members/post via Admin API, applies D1 migrations, establishes bot session

## Project Notes

- Ghost source code: `Ghost/` dir (full monorepo, has its own `CLAUDE.md`)
- CSS class prefix: `gl4g-` (defined as constant in `public/client.js`)
- Theme button: if `.gl4g-button` exists in DOM, client.js uses it instead of creating a floating button; `.gl4g-button-wrapper` parent gets unhidden; auto-created floating button gets `gl4g-button--float`
- `client.js` and `privacy.html` are served as Cloudflare static assets from `public/`
- Worker URL: `https://giftlinks.net`
- Admin: HTTP Basic Auth at `/admin`, user=`admin`, `ADMIN_PASSWORD` is a wrangler secret

## D1 Schema

- `sessions`: keyed by `origin` (e.g. `https://ghost.eli.pizza`), stores `cookies` + `created_at`
- `gift_links`: keyed by `token`, stores `url` (full post URL) + `email` + `gifter_name` + `max_views` (nullable, NULL = unlimited, 0 treated as unlimited) + `ttl_days` (nullable, NULL = use global `DEFAULT_TTL_DAYS`) + `created_at`
- `link_views`: tracks gift link redemptions (referer, country, timestamp)
- Session lookup from gift link: `new URL(metadata.url).origin` → sessions PK

## Ghost Internals

- Paywall gate: fallback chain — `.gh-post-upgrade-cta` → `.gh-cta` → `.single-cta` → `.content-cta` → `.post-sneak-peek`. Override via `data-gl4g-gate` on script tag
- Content container: fallback chain — `.gh-content` → `.post-content` → `.post__content` → `.post-body` → `article.post` → `article` → `.content` (all except `.gh-content` require unique match). Override via `data-gl4g-content` on script tag. Custom selector is passed through to backend as `content_selector` in the fetch-content API.
- HTML parsing: `htmlparser2` + `css-select` + `dom-serializer` for server-side content extraction (replaced regex). Handles nested same-tag elements correctly.
- Theme bar: `data-gl4g-bar="my-bar-class"` on script tag — if `.my-bar-class` exists in DOM, its innerHTML is replaced instead of creating a new bar element
- Post detection: `body.post-template` class from `{{body_class}}` helper
- Member session: `ghost-members-ssr` + `.sig` cookies, 184-day TTL
- Identity JWT: RS512, 10-min TTL, `sub` = member email, JWKS at `/members/.well-known/jwks.json`
- Content API key: in Portal script tag `data-key` attribute
- Ghost 6 generates 1024-bit RSA keys; `jose` enforces 2048+ minimum, but Web Crypto in workerd accepts 1024-bit — use direct Web Crypto JWT verification (`src/jwt-verify.js`)
- Admin API: session auth via `POST /ghost/api/admin/session` with Origin header, cookie `ghost-admin-api-session`
- Brute-force protection on login — multiple failed attempts cause 403s
- Session refresh: daily cron in `src/session-refresh.js`, >150 days triggers magic link re-request
- Integrity token: `GET /members/api/integrity-token`
- Magic link request: `POST /members/api/send-magic-link` with `integrityToken` in JSON body

## workerd / vitest-pool-workers Gotchas

- `@cloudflare/vitest-pool-workers` caps vitest at 2.0.x–3.2.x (check peer deps before upgrading)
- fetchMock array-of-arrays headers are broken in workerd — keys become `"0"`, `"1"` instead of header names. Use object headers (one value per header name)
- Vite `?raw` imports work in tests but not in wrangler's esbuild — use `[[rules]] type = "Text"` in wrangler.toml for text module imports (currently used for landing.html)
- D1 `db.exec()` with multiple statements crashes in workerd (metadata aggregation bug) — use separate `exec()` calls per statement
