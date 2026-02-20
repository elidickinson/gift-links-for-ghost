import { verifyJwt } from './jwt-verify.js';
import { createGiftToken } from './gift-token.js';
import { getBotSession } from './bot-session.js';
import { corsHeaders } from './router.js';
import { log } from './log.js';

export async function handleCreate(request, env) {
  const { jwt, url: rawUrl, gifter_name, max_views, ttl_days } = await request.json();
  const url = new URL(rawUrl).href;

  // Validate URL origin has an active bot session (prevents SSRF)
  const urlOrigin = new URL(url).origin;
  const session = await getBotSession(env, urlOrigin);
  if (!session) {
    log.warn('create rejected: unknown origin', urlOrigin);
    return Response.json({ error: 'unknown_origin' }, { status: 403, headers: corsHeaders() });
  }

  let email;
  try {
    email = await verifyIdentityToken(jwt, urlOrigin, env);
  } catch (error) {
    log.warn('create rejected: invalid token', { code: error.code, message: error.message });
    return Response.json(
      { error: 'invalid_token', code: error.code, message: error.message }, // also checked in e2e-test.sh and api.test.js
      { status: 401, headers: corsHeaders() },
    );
  }

  const parsedMaxViews = parseMaxViews(max_views, env.DEFAULT_MAX_VIEWS);
  const parsedTtlDays = parseTtlDays(ttl_days, env.DEFAULT_TTL_DAYS);
  const token = await createGiftToken(env, { url, email, gifter_name, max_views: parsedMaxViews, ttl_days: parsedTtlDays });
  log.info('create', { email, url });

  return Response.json({ token }, {
    headers: corsHeaders(),
  });
}

// Returns a positive integer for a view limit, or null for unlimited.
// 0 explicitly means unlimited. Missing/invalid falls back to the env default.
export function parseMaxViews(value, envDefault) {
  const v = typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
  const effective = v !== undefined ? v : parseInt(envDefault, 10) || 0;
  return effective > 0 ? effective : null;
}

// Returns a positive integer for TTL days, or null to use the global default at expiry time.
// Valid positive int → store it; 0/missing/invalid → null (use global default).
export function parseTtlDays(value, envDefault) {
  const v = typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
  if (v !== undefined) return v;
  const fallback = parseInt(envDefault, 10);
  return fallback > 0 ? fallback : null;
}

async function verifyIdentityToken(token, origin, env) {
  const row = await env.DB.prepare('SELECT jwks FROM sessions WHERE origin = ?').bind(origin).first();
  if (!row?.jwks) {
    throw new Error(`No cached JWKS for ${origin}`);
  }

  const audience = `${origin}/members/api`;
  const payload = await verifyJwt(token, JSON.parse(row.jwks), {
    issuer: audience,
    audience,
  });

  return payload.sub;
}
