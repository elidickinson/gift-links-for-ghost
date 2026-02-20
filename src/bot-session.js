export async function getBotSession(env, origin) {
  const row = await env.DB.prepare('SELECT cookies FROM sessions WHERE origin = ?').bind(origin).first();
  return row ? row.cookies : null;
}

export async function storeBotSession(env, origin, cookies, jwks = null) {
  await env.DB.prepare('INSERT OR REPLACE INTO sessions (origin, cookies, jwks, created_at) VALUES (?, ?, ?, ?)')
    .bind(origin, cookies, jwks, Date.now())
    .run();
}

const MAGIC_LINK_COOLDOWN_MS = 5 * 60 * 1000;

export async function refreshSession(origin, botEmail, db = null) {
  if (db) {
    const row = await db.prepare('SELECT last_magic_link_at FROM sessions WHERE origin = ?').bind(origin).first();
    if (row?.last_magic_link_at && Date.now() - row.last_magic_link_at < MAGIC_LINK_COOLDOWN_MS) {
      return;
    }
  }

  const integrityResponse = await fetch(`${origin}/members/api/integrity-token`);
  if (!integrityResponse.ok) {
    const hint = integrityResponse.status === 404
      ? 'Wrong URL?'
      : `HTTP ${integrityResponse.status}`;
    throw new Error(`Could not reach ${origin} members API. ${hint}`);
  }
  // Follow redirects (e.g. coyotemedia.org -> www.coyotemedia.org)
  origin = new URL(integrityResponse.url).origin;
  const integrityBody = await integrityResponse.text();
  if (!integrityBody) {
    throw new Error(`No integrity token returned by ${origin}`);
  }
  const integrityToken = integrityBody.trim();

  const magicLinkResponse = await fetch(`${origin}/members/api/send-magic-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: botEmail, emailType: 'signin', integrityToken }),
  });
  if (!magicLinkResponse.ok) {
    const hint = magicLinkResponse.status === 400
      ? `Is ${botEmail} a member of this site?`
      : `HTTP ${magicLinkResponse.status}`;
    throw new Error(`Magic link request failed for ${origin}. ${hint}`);
  }

  if (db) {
    await db.prepare('UPDATE sessions SET last_magic_link_at = ? WHERE origin = ?').bind(Date.now(), origin).run();
  }
}

export async function listAllOrigins(env) {
  const maxFailures = parseInt(env.MAX_REFRESH_FAILURES) || 5;
  const { results } = await env.DB.prepare('SELECT origin FROM sessions WHERE refresh_failures < ?').bind(maxFailures).all();
  return results.map(row => row.origin);
}

export async function listStaleSessions(env, maxAgeDays) {
  const maxFailures = parseInt(env.MAX_REFRESH_FAILURES) || 5;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const { results } = await env.DB.prepare('SELECT origin FROM sessions WHERE created_at < ? AND refresh_failures < ?').bind(cutoff, maxFailures).all();
  return results.map(row => row.origin);
}
