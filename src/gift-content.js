import { parseDocument } from 'htmlparser2';
import { selectAll } from 'css-select';
import render from 'dom-serializer';
import { lookupGiftToken } from './gift-token.js';
import { getBotSession, refreshSession } from './bot-session.js';
import { corsHeaders } from './router.js';
import { escapeHtml } from './escape-html.js';
import { log } from './log.js';

// Fallback chain for themes that don't use Ghost's default section.gh-content.
// Uses css-select on an htmlparser2 DOM — handles nesting, attribute quoting, etc.
const CONTENT_SELECTORS = [
  { selector: 'section.gh-content', unique: false },
  { selector: 'article.post', unique: true },
  { selector: 'article', unique: true },
  { selector: '.content', unique: true },
];

function innerHTML(el) {
  return render(el.children);
}

export function extractContent(html, customSelector) {
  const doc = parseDocument(html);

  if (customSelector) {
    const matches = selectAll(customSelector, doc);
    if (matches.length > 0) return innerHTML(matches[0]);
    return '';
  }

  for (const { selector, unique } of CONTENT_SELECTORS) {
    const matches = selectAll(selector, doc);
    if (matches.length === 0) continue;
    if (unique && matches.length !== 1) continue;
    return innerHTML(matches[0]);
  }
  return '';
}

export async function handleFetchContent(request, env, ctx) {
  const { token, url: rawUrl, content_selector } = await request.json();
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
  const result = await fetchGhostContent(url, sessionCookies, content_selector);
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

// Paywall gate detection — if any of these selectors match an element in the DOM,
// the bot session likely expired and the page is showing a paywall.
// Ghost always injects CTA styles, but only renders the element when the visitor
// lacks access — so a DOM element match means the paywall is visible.
const PAYWALL_SELECTORS = [
  'aside.gh-post-upgrade-cta',   // Ghost default (Casper)
  '.content-cta',                // common theme pattern
  '.post-sneak-peek',            // truncated content indicator
];

export function isPaywalled(doc) {
  return PAYWALL_SELECTORS.some(sel => selectAll(sel, doc).length > 0);
}

async function fetchGhostContent(url, sessionCookies, contentSelector) {
  const response = await fetch(url, {
    headers: { 'Cookie': sessionCookies },
  });

  if (!response.ok) {
    log.warn('ghost fetch failed', { url, status: response.status });
    return { html: null, pageBytes: 0 };
  }

  const pageHtml = await response.text();
  const doc = parseDocument(pageHtml);

  if (isPaywalled(doc)) {
    return { html: null, paywalled: true, pageBytes: pageHtml.length };
  }

  return { html: extractContent(pageHtml, contentSelector), pageBytes: pageHtml.length };
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
