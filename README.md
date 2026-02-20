# <img src="public/apple-touch-icon.png" alt="" width="28" align="absmiddle"> Gift Links for Ghost

Let paid Ghost subscribers share paywalled articles with anyone via gift links. No theme edits, no API keys, no DNS changes.

> **[giftlinks.net](https://giftlinks.net)** — setup instructions, how it works, FAQ, and customization options.

## Self-Hosting

The hosted service at giftlinks.net is free, but you can self-host the Cloudflare Worker if you prefer.

### Prerequisites

- A [Ghost](https://ghost.org) site with paid memberships
- A [Cloudflare](https://cloudflare.com) account (Workers paid plan, $5/month)
- A domain on Cloudflare DNS (for email routing)

### 1. Create D1 Database

```
npx wrangler d1 create giftlinks
```

Copy the output `database_id` into `wrangler.toml`, replacing the placeholder.

Apply the schema migration:

```
npx wrangler d1 migrations apply giftlinks
```

### 2. Configure

Update `wrangler.toml` vars:

| Variable | Default | Description |
|---|---|---|
| `BOT_EMAIL` | — | Email address of the bot member in Ghost |
| `DEFAULT_TTL_DAYS` | `14` | How long gift links remain valid in days (0 = never expires) |
| `DEFAULT_MAX_VIEWS` | `0` | Max redemptions per link (0 = unlimited) |

### 3. Deploy

```
npx wrangler deploy
```

Optionally add a custom domain via Cloudflare dashboard or wrangler.toml routes (e.g. `giftlinks.yourdomain.com`).

### 4. Set Up Email Routing

Cloudflare dashboard → Email Routing → Create rule:

- **From:** `reader@giftlinks.yourdomain.com`
- **Action:** Route to the `giftlinks` worker

This lets the worker capture Ghost magic link emails to establish a bot session.

### 5. Add Bot Member and Inject Script

Follow the setup instructions on your worker's homepage, and be sure to point the script at your worker URL:

```html
<script src="https://your-worker.example.com/client.js" data-gl4g-api="https://your-worker.example.com" defer></script>
```

## Design Choices

These are deliberate decisions, informed by how NYT, Washington Post, Bloomberg, Hearst, and others handle gift links.

**No recipient signup.** Gift links work instantly — no account, no email capture. The NYT and Bloomberg take this approach. WaPo and Hearst require signup to capture emails, but that adds friction and changes the nature of the gift. We optimize for the recipient experience.

**Multi-use links.** A single gift link can be shared with multiple people, like the NYT model. BLOX Digital uses single-use links (one redemption, then the paywall returns), which prevents viral spread but makes the link feel fragile. We chose shareability over control.

**No monthly quota (yet).** Every major newspaper limits subscribers to 5–20 gift links per month. We don't enforce this yet, though usage can be monitored in the admin dashboard.

**Optional per-link redemption limit.** Site admins can add `data-gl4g-max-views="10"` to the script tag to cap how many times each gift link can be viewed. The limit is stored per-link at creation time. Without it, links use the `DEFAULT_MAX_VIEWS` setting (0 = unlimited).

**Optional per-link TTL.** Site admins can add `data-gl4g-ttl-days="7"` to the script tag to override the default expiry. The TTL is stored per-link at creation time. Without it, links use the `DEFAULT_TTL_DAYS` setting (default 14).

**Links expire then soft-delete.** Expired links are marked inactive (not deleted) so analytics and admin views preserve the full history.

**No link revocation (yet).** Once created, a gift link is valid until expiry. Beehiiv is the only platform with explicit revocation. Planned for a future release.

**Identity verified via Ghost JWT (kinda).** Gift link creation requires a valid Ghost member session token (RS512, verified against the site's JWKS). This prevents anonymous link creation. The JWT does not contain tier information, so any authenticated member at any tier can create gift links — Ghost doesn't expose per-member access details in the identity token.

**No gift link data stored in Ghost.** The client script, tokens, bot session, and gift link analytics all live on Cloudflare (Workers + D1). The only touch point on Ghost is one line of code injection and one bot member. Uninstall by removing both. Page analytics in Ghost should continue to work as normal.

**Content fetched on every redemption.** No caching — each redemption fetches the page fresh from Ghost using the bot session. This means recipients always see the current version of the post and view counts in Ghost should accurately count gift link redemptions. May need to investigate caching for high-volume sites, though Workers should scale horizontally seamlessly.

## Security Notes

**Risk: App gets hacked**
 - The bot sessions table could be used to gain access to paid posts. If compromised, Ghsot admins should revoke bot membership in Ghost Admin and re-add/
 - Identity of members who recently created gift links could be exposed.
 - Analytics (but not PII) about popularity of different gift links could be exposed

**Risk: Gift link gets used by "too many" people**
 - By default there is no limit on the number of redemptions per gift link and they could end up going viral on social media, etc. Site admins can set `data-gl4g-max-views` to cap views per link.
 - It is unlikely that Google or other search engines would index a gift link because Ghost adds a `canonical` tag to the main post URL
 
**Risk: Non-paying members exploit gift link system**
 - It would take a little effort, but someoen who isn't a paid member may be able to trick the the gift link app into creating a gift link for them anyway.
 - Plan to address this in the future, but realistically you should not enable gift links if you are very worried about people sneaking around the paywall.

## Development

```
npm install
npm test          # vitest (runs in Cloudflare Workers runtime)
npm run dev       # wrangler dev (local worker)
```

### Local Dev Setup

`docker compose -f docker-compose.dev.yml up -d` starts Ghost and Mailpit:

| Service | URL |
|---|---|
| Ghost site | http://localhost:2368 |
| Ghost admin | http://localhost:2368/ghost/ |
| Mailpit inbox | http://localhost:8025 |

Ghost sends all email to Mailpit. Magic links show up there instead of going to real addresses.

### Quick Start

```sh
docker compose -f docker-compose.dev.yml up -d
npm run dev       # start worker (in another terminal)
npm run setup     # reset Ghost, create members/post, apply D1 migrations, create bot session
```

This gives you a clean Ghost with an admin, a bot member (`bot@giftlinks.net`), a paid test member (`paid@example.com`), a paywalled "Premium Test Post", and an active bot session in D1.

To test: open Mailpit, find the `paid@example.com` sign-in link, open it in your browser. Visit the premium post, click "Gift this article", open the gift URL in an incognito window.

### E2E Tests

```sh
scripts/e2e-test.sh    # requires Ghost, Mailpit, and worker running
```

Runs the full flow: bot session setup, member sign-in, gift link creation, anonymous redemption, forged JWT rejection, and expired token handling. Auto-runs `dev-setup.sh` if Ghost isn't configured.

### Dev Endpoints

When `DEV_MODE` is set (via `.env`, never in production), the worker exposes:

| Endpoint | Method | Description |
|---|---|---|
| `/dev/simulate-email` | POST | Accepts raw RFC 822 email body. Runs it through the email handler (extract magic link → follow → store session). |

### Dev Members

`dev-setup.sh` creates these via the Ghost Admin API:

| Email | Name | Status | Purpose |
|---|---|---|---|
| `admin@example.com` | — | owner | Ghost admin (password in `.env`) |
| `bot@giftlinks.net` | Gift Bot | comped | Bot member for fetching paywalled content |
| `paid@example.com` | Paid Member | comped | Test gift link creator |

## Limitations

- Not compatible with private/password-protected Ghost sites

## Future Plans

- Per-post access verification (via content proof or Ghost Admin API)
- Per-subscriber gift link creation limits
- Gift link revocation
