# <img src="public/apple-touch-icon.png" alt="" width="28" align="absmiddle"> Gift Links for Ghost

Free service that lets members of your Ghost site create gift links they can share with non-members. Doesn't require Admin API or sharing member data. 

> **Check out [giftlinks.net](https://giftlinks.net) for the hosted service, including Ghost site setup instructions, overview, FAQ, and customization.**

## How It Works

**Setup (one-time per Ghost site):**

1. Site admin adds a bot member to their Ghost site and pastes a `<script>` tag into Ghost's code injection.
2. The worker requests a Ghost magic link for the bot's email address.
3. Ghost sends the magic link email → Cloudflare Email Routing delivers it to the worker.
4. The worker follows the magic link's redirect chain, captures the `ghost-members-ssr` session cookies, and stores them in D1 alongside the site's JWKS public keys.

**Creating a gift link (paid member → worker):**

1. `client.js` checks `body.post-template` to confirm it's a post page, then checks `/members/api/session` and the Content API to confirm the visitor is a logged-in member viewing a paywalled post.
2. Member clicks the gift button → `client.js` fetches the member's identity JWT from `/members/api/session` and POSTs it with the post URL to `/api/gift-link/create`.
3. The worker verifies the JWT signature against the site's cached JWKS (RS512 via Web Crypto), then generates a random token and stores the gift link metadata in D1.
4. `client.js` appends `?gift=<token>` to the page URL.

**Redeeming a gift link (anonymous visitor → worker → Ghost):**

1. `client.js` detects the `?gift=` parameter and the paywall gate in the DOM.
2. It POSTs the token and URL to `/api/gift-link/fetch-content`.
3. The worker looks up the token in D1, checks expiry and view limits, then fetches the full post page from Ghost using the bot's session cookies.
4. The worker parses the HTML (htmlparser2 + css-select), extracts the content container, and returns just the post body.
5. `client.js` removes the paywall gate element, replaces the content container's innerHTML with the full conten from the worker, and shows a "gifted by" banner.

**Maintenance (daily cron):**

- Refreshes JWKS for all connected sites.
- Re-requests magic links for bot sessions older than 7 days (Ghost sessions expire after 184 days, but the cookie refresh keeps them alive).
- Soft-deletes expired gift links and blanks PII (email, gifter name).

## Security Notes

**Risk: This app or its hosting platform are hacked**
 - The bot sessions table could be used to gain access to paid posts.
 - Identity of members who recently created gift links could be exposed.

**Risk: Gift link gets used by "too many" people**
 - By default there is no limit on the number of times a gift link can be used. They could go viral on social media, etc. Site admins can set `data-gl4g-max-views` to cap views per link.
 - It is unlikely that Google or another search engines would index the gift link version because Ghost adds a `canonical` tag to pages that points to the main post URL.
 
**Risk: Non-paying members exploit gift link system**
 - It would take a little effort, but it's possible for a free member to trick the Gift Links app into generating a gift link for a post they shouldn't have access to in the first place.
 - I'd like to address this in the future, but for now consider it an acceptable risk. You should not enable Gift Links if you are really worried about people sneaking past the paywall.

## Known Limitations

- Not compatible with private/password-protected Ghost sites

## Future Plans

- Per-post access verification (via content proof or Ghost Admin API)
- Gift link revocation
- Simple analytics reports for Ghost site admins

## Self-Hosting

The hosted service at giftlinks.net is free, but you can self-host the Cloudflare Worker if you prefer.

### Prerequisites

- A [Ghost](https://ghost.org) site with paid memberships
- A [Cloudflare](https://cloudflare.com) account (Workers paid plan, $5/month)
- A domain on Cloudflare DNS (for email routing)

### 1. Configure

```
cp wrangler.toml.sample wrangler.toml
```

### 2. Create D1 Database

```
npx wrangler d1 create giftlinks
```

Copy the output `database_id` into `wrangler.toml`, then apply migrations:

```
npx wrangler d1 migrations apply giftlinks
```

Edit `wrangler.toml` — fill in your `zone_id` and update vars:

| Variable | Default | Description |
|---|---|---|
| `BOT_EMAIL` | — | Email address of the bot member in Ghost |
| `DEFAULT_TTL_DAYS` | `14` | How long gift links remain valid in days (0 = never expires) |
| `DEFAULT_MAX_VIEWS` | `0` | Max redemptions per link (0 = unlimited) |

Set the admin dashboard password: `npx wrangler secret put ADMIN_PASSWORD`

### 3. Deploy

```
npx wrangler deploy
```

Optionally add a custom domain via Cloudflare dashboard or wrangler.toml routes (e.g. `giftlinks.yourdomain.com`).

### 4. Set Up Email Routing

Cloudflare dashboard → Email Routing → Create rule:

- **From:** `reader@giftlinks.example.com`
- **Action:** Route to the `giftlinks` worker

This lets the worker capture Ghost magic link emails to establish a bot session.

### 5. Add Bot Member and Inject Script

Follow the setup instructions on your worker's homepage, and be sure to point the script at your worker URL **and set the `data-gl4g-api` parameter**:

```html
<script src="https://your-worker.example.com/client.js" data-gl4g-api="https://your-worker.example.com" defer></script>
```
 
## Development

```sh
npm install
docker compose -f docker-compose.dev.yml up -d   # Ghost (localhost:2368) + Mailpit (localhost:8025)
npm run dev                                       # start worker (in another terminal)
npm run setup                                     # reset Ghost, create members/post, apply D1 migrations, create bot session
```

`npm run setup` gives you a clean Ghost with an admin (`admin@example.com`), a bot member (`bot@giftlinks.net`), a paid test member (`paid@example.com`), a paywalled post, and an active bot session in D1. Ghost sends all email to Mailpit.

### Testing

```sh
npx vitest run          # unit tests (runs in Cloudflare Workers runtime)
scripts/e2e-test.sh     # full flow: setup, sign-in, create, redeem, forged JWT, expiry
```

E2E requires Ghost, Mailpit, and the worker running. Auto-runs `dev-setup.sh` if Ghost isn't configured.
