import { listStaleSessions, listAllOrigins, refreshSession } from './bot-session.js';
import { log } from './log.js';

async function refreshJwks(origin, db) {
  const response = await fetch(`${origin}/members/.well-known/jwks.json`);
  if (!response.ok) {
    throw new Error(`Failed to fetch JWKS for ${origin}: ${response.status}`);
  }
  const jwks = await response.text();
  await db.prepare('UPDATE sessions SET jwks = ?, refresh_failures = 0 WHERE origin = ?').bind(jwks, origin).run();
}

export async function handleScheduled(env) {
  const errors = [];

  // Refresh JWKS for all sessions
  const allOrigins = await listAllOrigins(env);
  log.debug('cron: refreshing JWKS for', allOrigins.length, 'origins');
  for (const origin of allOrigins) {
    try {
      await refreshJwks(origin, env.DB);
      log.debug('cron: JWKS refreshed for', origin);
    } catch (error) {
      await env.DB.prepare('UPDATE sessions SET refresh_failures = refresh_failures + 1 WHERE origin = ?').bind(origin).run();
      errors.push({ origin, error });
      log.error('cron: JWKS refresh failed for', origin, error.message);
    }
  }

  // Refresh stale bot sessions
  // Ghost cookies last ~184 days, but sessions can die early (Ghost restart,
  // key rotation, DB reset). A failed redemption auto-refreshes, but refreshing
  // weekly avoids even that one failed request.
  const staleSessions = await listStaleSessions(env, 7);
  if (staleSessions.length > 0) {
    log.info('cron: refreshing', staleSessions.length, 'stale sessions');
  }
  for (const origin of staleSessions) {
    try {
      await refreshSession(origin, env.BOT_EMAIL, env.DB);
      log.info('cron: magic link requested for', origin);
    } catch (error) {
      await env.DB.prepare('UPDATE sessions SET refresh_failures = refresh_failures + 1 WHERE origin = ?').bind(origin).run();
      errors.push({ origin, error });
      log.error('cron: session refresh failed for', origin, error.message);
    }
  }

  const ttlDays = parseInt(env.GIFT_TTL_DAYS) || 14;
  const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const { meta } = await env.DB.prepare(
    "UPDATE gift_links SET expired_at = ?, email = '', gifter_name = '' WHERE created_at < ? AND expired_at IS NULL"
  ).bind(now, cutoff).run();
  if (meta.changes > 0) {
    log.info('cron: expired', meta.changes, 'gift links');
  }

  if (errors.length > 0) {
    throw new Error(`Scheduled tasks failed for: ${errors.map(e => e.origin).join(', ')}`);
  }
}
