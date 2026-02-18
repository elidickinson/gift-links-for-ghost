import { verifyJwt } from './jwt-verify.js';
import { createGiftToken } from './gift-token.js';
import { getBotSession } from './bot-session.js';
import { corsHeaders } from './router.js';
import { log } from './log.js';

export async function handleCreate(request, env) {
  const { jwt, url: rawUrl, gifter_name } = await request.json();
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

  const token = await createGiftToken(env, { url, email, gifter_name });
  log.info('create', { email, url });

  return Response.json({ token }, {
    headers: corsHeaders(),
  });
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
