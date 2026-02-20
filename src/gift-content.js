import { lookupGiftToken } from './gift-token.js';
import { getBotSession, refreshSession } from './bot-session.js';
import { corsHeaders } from './router.js';
import { escapeHtml } from './escape-html.js';
import { log } from './log.js';

// Regex over HTMLRewriter because we need the exact original HTML, not a reconstruction.
// Fallback chain for themes that don't use Ghost's default section.gh-content.
//
// Class matching: \b treats hyphens as word boundaries, so \bpost\b falsely matches
// "post-card". Use (?<=[ "]) and (?=[ "]) to require space or quote boundaries,
// ensuring exact CSS class matching within class="..." attributes.
const CONTENT_PATTERNS = [
  // Ghost default: section.gh-content (accept first match — specific enough)
  { pattern: /<section[^>]*class="[^"]*\bgh-content\b[^"]*"[^>]*>([\s\S]*?)<\/section>/, unique: false },
  // article with exact "post" class (not post-card, post-access-tiers, etc.)
  { pattern: /<article[^>]*class="(?:[^"]*\s)?post(?:\s[^"]*)?"[^>]*>([\s\S]*?)<\/article>/, unique: true },
  // single article element
  { pattern: /<article[^>]*>([\s\S]*?)<\/article>/, unique: true },
  // element with exact "content" class (not content-width, content-cta, etc.)
  { pattern: /<(\w+)[^>]*class="(?:[^"]*\s)?content(?:\s[^"]*)?"[^>]*>([\s\S]*?)<\/\1>/, unique: true },
];

export function extractContent(html) {
  for (const { pattern, unique } of CONTENT_PATTERNS) {
    const matches = [...html.matchAll(new RegExp(pattern, 'g'))];
    if (matches.length === 0) continue;
    if (unique && matches.length !== 1) continue;
    return matches[0][matches[0].length - 1];
  }
  return '';
}

export async function handleFetchContent(request, env, ctx) {
  const { token, url: rawUrl } = await request.json();
  const url = new URL(rawUrl).href;

  const metadata = await lookupGiftToken(env, token);
  if (!metadata) {
    log.debug('redeem: token not found', token.slice(0, 6));
    return Response.json({ error: 'not_found' }, { status: 404, headers: corsHeaders() });
  }
  if (metadata.expired_at) {
    log.debug('redeem: token expired', token.slice(0, 6));
    return Response.json({ error: 'expired' }, { status: 410, headers: corsHeaders() });
  }

  if (url !== metadata.url) {
    log.warn('redeem: url mismatch', { token: token.slice(0, 6), expected: metadata.url, got: url });
    return Response.json({ error: 'invalid' }, { status: 400, headers: corsHeaders() });
  }

  const sessionCookies = await getBotSession(env, new URL(url).origin);
  if (!sessionCookies) {
    log.error('redeem: no bot session for', new URL(url).origin);
    return Response.json({ error: 'no_session' }, { status: 503, headers: corsHeaders() });
  }

  const startTime = Date.now();
  const result = await fetchGhostContent(url, sessionCookies);
  const durationMs = Date.now() - startTime;

  if (result.paywalled) {
    log.error('redeem: bot session expired, requesting refresh', { url, durationMs });
    const origin = new URL(url).origin;
    ctx.waitUntil(refreshSession(origin, env.BOT_EMAIL, env.DB).catch(err =>
      log.error('redeem: background session refresh failed', { origin, error: err.message }),
    ));
    return Response.json({ error: 'fetch_failed' }, { status: 502, headers: corsHeaders() });
  }

  if (!result.html) {
    log.error('redeem: content extraction failed', { url, durationMs, pageBytes: result.pageBytes });
    return Response.json({ error: 'fetch_failed' }, { status: 502, headers: corsHeaders() });
  }

  const html = result.html;

  log.info('redeem', { token: token.slice(0, 6), url, durationMs });
  ctx.waitUntil(recordView(env, token, request));

  return Response.json({ html, gifter_name: escapeHtml(metadata.gifter_name) }, {
    headers: corsHeaders(),
  });
}

// Paywall gate detection — if any of these match as HTML elements (not CSS), the
// bot session likely expired and the page is showing a paywall.
const PAYWALL_PATTERNS = [
  /<aside[^>]*gh-post-upgrade-cta/,     // Ghost default (Casper)
  /<div[^>]*class="[^"]*\bcontent-cta\b/, // common theme pattern
  /<div[^>]*class="[^"]*\bpost-sneak-peek\b/, // truncated content indicator
];

async function fetchGhostContent(url, sessionCookies) {
  const response = await fetch(url, {
    headers: { 'Cookie': sessionCookies },
  });

  if (!response.ok) {
    log.warn('ghost fetch failed', { url, status: response.status });
    return { html: null, pageBytes: 0 };
  }

  const pageHtml = await response.text();

  // Ghost always injects CTA styles, but only renders the element when
  // the visitor lacks access. Match an actual HTML element, not the CSS.
  if (PAYWALL_PATTERNS.some(p => p.test(pageHtml))) {
    return { html: null, paywalled: true, pageBytes: pageHtml.length };
  }

  return { html: extractContent(pageHtml), pageBytes: pageHtml.length };
}

function normalizeReferer(refererHeader) {
  if (!refererHeader) return null;
  try {
    return new URL(refererHeader).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

async function recordView(env, token, request) {
  const refererDomain = normalizeReferer(request.headers.get('Referer'));
  const country = request.headers.get('CF-IPCountry') || null;
  await env.DB.prepare(
    'INSERT INTO link_views (token, viewed_at, referer_domain, country) VALUES (?, ?, ?, ?)'
  ).bind(token, Date.now(), refererDomain, country).run();
}
