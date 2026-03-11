# Threat Model

## Assets

1. **Paywalled content** — site admin's paid articles (their revenue)
2. **Member privacy** — gifter emails in D1, analytics showing who shared what
3. **System availability** — gift links working when clicked

## Adversaries

| Adversary | Goal | Motivation |
|---|---|---|
| Random internet user | Read paywalled content | Avoid paying |
| Free Ghost member | Create gift links they shouldn't be able to | Bypass paywall |
| Rogue paid member | Mass-create gift links, share widely | Undermine paywall |
| External attacker | Abuse worker as proxy, steal data, phish | Opportunistic |
| Compromised CF account | Read all content, exfil member data | Targeted |

## Threats

### T1: JWT forgery to create gift links — FIXED
**Adversary:** Free member or random user
**How:** Craft a JWT with any `sub` email, POST to `/api/gift-link/create`.
**Impact:** Unlimited gift links for any post URL. Completely bypasses "paid members only".
**Likelihood:** High — trivial with curl.
**Mitigation:** RS512 signature verification via Ghost's JWKS endpoint (`/members/.well-known/jwks.json`). Uses Web Crypto API directly (Ghost 6 generates 1024-bit RSA keys, which `jose` rejects). Validates `iss`, `aud`, and `exp` claims. Returns 401 for forged/expired tokens.

### T2: Mass gift link creation
**Adversary:** Rogue paid member
**How:** Legitimate JWT, automated script hitting `/api/gift-link/create`.
**Impact:** Hundreds of gift links for the same post. Effectively removes the paywall.
**Likelihood:** Medium — requires paid account.
**Mitigation:** None. Fix: per-member rate limits.

### T3: SSRF via arbitrary URL in gift link creation
**Adversary:** External attacker
**How:** Create gift link with `url` pointing to internal service. On redemption, worker fetches that URL with bot session cookies.
**Impact:** Worker becomes SSRF proxy. Bot cookies sent to attacker-controlled URL.
**Likelihood:** Medium.
**Mitigation:** FIXED — URL origin must match an existing session origin.

### T4: Admin dashboard brute force
**Adversary:** External attacker
**How:** Automated password guessing against `/admin`.
**Impact:** Access to gifter emails, post URLs, referer domains, countries.
**Likelihood:** Low — requires knowing endpoint exists.
**Mitigation:** HTTP Basic Auth only. Fix: Cloudflare Access or rate limiting.

### T5: Bot session exfiltration via D1
**Adversary:** Compromised CF account
**How:** `wrangler d1 execute` to read sessions table.
**Impact:** Direct access to all paywalled content.
**Likelihood:** Low — requires CF account compromise.
**Mitigation:** Inherent to architecture. Recovery: revoke bot member in Ghost Admin.

### T6: Gift link redistribution
**Adversary:** Anyone with a valid gift link
**How:** Post gift link publicly.
**Impact:** Unlimited reads of that article for 14-day TTL.
**Likelihood:** High — intended use case working against site admin.
**Mitigation:** TTL expiry, analytics showing view counts per link.

### T7: Poisoned email triggers wrong magic link
**Adversary:** Someone who can send email to bot address
**How:** Email containing crafted magic link URL before Ghost's real one.
**Impact:** Bot session established for wrong Ghost instance.
**Likelihood:** Very low — CF Email Routing only forwards configured addresses.
**Mitigation:** Accept risk.

## Risk to the Ghost site admin

The bot member has complimentary paid access — it can read everything. A bug or compromise of this app could affect the site admin's business:

- **Content leaks at scale.** If gift link creation is abused (T2, T8), an attacker could generate links for every paywalled post and publish them. Mitigation: TTL expiry limits the window, analytics surface unusual activity. Not yet mitigated: rate limits.
- **Bot session stolen.** If D1 is compromised (T5), the attacker gets session cookies that bypass the paywall entirely — no gift links needed. Mitigation: none beyond CF account security. Recovery: revoke the bot member in Ghost Admin, which instantly invalidates the session.
- **No write access.** The bot member is a reader, not an admin. A compromised app cannot publish posts, delete content, modify settings, or access the Ghost Admin API. The blast radius is limited to *reading* paywalled content.
- **No member data exposure via Ghost.** The bot session only grants access to post content. It cannot list other members, view subscriber emails, or access billing data — those require Ghost Admin API credentials, which this app never touches.
- **Analytics data in D1.** The `link_views` and `gift_links` tables contain gifter emails, post URLs, referer domains, and countries. A D1 breach exposes this. Mitigation: admin dashboard is auth-protected; D1 access requires CF account credentials.

### T8: Unauthorized gift link creation
**Adversary:** Free or lower-tier Ghost member
**How:** A member with a valid identity JWT creates a gift link for a post they cannot access themselves.
**Impact:** Gift links for content the member hasn't paid for — bypasses Ghost's tiered access model.
**Likelihood:** Low — requires a valid Ghost member account.

**Why it's hard to fix:**

Ghost's identity JWT contains only the member's email (`sub` claim) — no subscription status or tier information. The `ghost-members-ssr` session cookies are HttpOnly, so client JS cannot read or forward them to the worker for a server-side access check. There is no Ghost API endpoint that accepts a JWT and returns whether a specific member can access a specific post.

Other server-rendered signals investigated: `ghost-access` + `ghost-access-hmac` cookies contain HMAC-signed tier info but are also HttpOnly. Tinybird analytics attributes (`data-tb_member_status`) and the `@member` template object are visible in page source but not secret — any member could read another's values. Everything that reliably proves access is either HttpOnly or trivially fakeable.

**Approaches considered:**

1. **Ghost Admin API** — look up the member's subscriptions by email, compare against the post's tier requirements via a custom integration. Works but requires an Admin API key per Ghost site, adding setup burden for site admins.

2. **Content proof** — the client sends a hash or snippet of the post content alongside the create request. The worker fetches the post with the bot session and verifies the proof matches. This proves the member can see the content in their browser. Tradeoffs: adds ~500ms latency to gift link creation (bot must fetch the page), and text normalization between browser DOM and server-side HTML extraction is fragile.

**Current status:** Accepted risk, documented in README. The client-side UI only shows the gift button to members who can see the full content, but this is not enforced server-side.

## Priority

| # | Threat | Severity | Status |
|---|---|---|---|
| T1 | JWT forgery | High | **Fixed** |
| T3 | SSRF via URL | High | **Fixed** |
| T2 | Mass gift creation | Medium | Open |
| T8 | Unauthorized gift creation | Medium | Accepted |
| T6 | Content redistribution | Medium | Mitigated (TTL + analytics) |
| T4 | Admin brute force | Low | Open |
| T5 | D1 exfiltration | Low | Inherent |
| T7 | Email poisoning | Very low | Accepted |
