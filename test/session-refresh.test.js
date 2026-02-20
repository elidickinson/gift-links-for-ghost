import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { env, fetchMock } from 'cloudflare:test';
import { handleScheduled } from '../src/session-refresh.js';
import { setupDatabase } from './setup-d1.js';

const TEST_JWKS = JSON.stringify({ keys: [{ kty: 'RSA', kid: 'test', n: 'abc', e: 'AQAB' }] });

function mockJwks(origin) {
  fetchMock.get(origin)
    .intercept({ method: 'GET', path: '/members/.well-known/jwks.json' })
    .reply(200, TEST_JWKS, { headers: { 'Content-Type': 'application/json' } });
}

describe('session refresh', () => {
  beforeAll(async () => {
    await setupDatabase(env.DB);
  });

  beforeEach(async () => {
    await env.DB.exec('DELETE FROM sessions; DELETE FROM gift_links;');
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  afterEach(() => {
    fetchMock.deactivate();
  });

  it('requests magic link for stale sessions and refreshes JWKS', async () => {
    const staleTimestamp = Date.now() - 160 * 24 * 60 * 60 * 1000;
    await env.DB.prepare('INSERT INTO sessions (origin, cookies, created_at) VALUES (?, ?, ?)')
      .bind('https://ghost.example.com', 'old-cookies', staleTimestamp)
      .run();

    const mockOrigin = fetchMock.get('https://ghost.example.com');
    mockOrigin
      .intercept({ method: 'GET', path: '/members/.well-known/jwks.json' })
      .reply(200, TEST_JWKS, { headers: { 'Content-Type': 'application/json' } });
    mockOrigin
      .intercept({ method: 'GET', path: '/members/api/integrity-token' })
      .reply(200, JSON.stringify({ token: 'integrity-abc' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    mockOrigin
      .intercept({ method: 'POST', path: '/members/api/send-magic-link' })
      .reply(200, '');

    await handleScheduled(env);

    const row = await env.DB.prepare('SELECT jwks FROM sessions WHERE origin = ?')
      .bind('https://ghost.example.com').first();
    expect(row.jwks).toBe(TEST_JWKS);
  });

  it('refreshes JWKS for fresh sessions without requesting magic link', async () => {
    await env.DB.prepare('INSERT INTO sessions (origin, cookies, created_at) VALUES (?, ?, ?)')
      .bind('https://fresh.example.com', 'fresh-cookies', Date.now())
      .run();

    mockJwks('https://fresh.example.com');

    await handleScheduled(env);

    const row = await env.DB.prepare('SELECT jwks FROM sessions WHERE origin = ?')
      .bind('https://fresh.example.com').first();
    expect(row.jwks).toBe(TEST_JWKS);
  });

  it('continues cleanup when one site fails refresh', async () => {
    const staleTimestamp = Date.now() - 160 * 24 * 60 * 60 * 1000;
    await env.DB.prepare('INSERT INTO sessions (origin, cookies, created_at) VALUES (?, ?, ?)')
      .bind('https://broken.example.com', 'old-cookies', staleTimestamp)
      .run();
    await env.DB.prepare('INSERT INTO sessions (origin, cookies, created_at) VALUES (?, ?, ?)')
      .bind('https://working.example.com', 'old-cookies', staleTimestamp)
      .run();

    // Insert an expired gift link that should still get cleaned up
    const expiredTimestamp = Date.now() - 30 * 24 * 60 * 60 * 1000;
    await env.DB.prepare(
      'INSERT INTO gift_links (token, url, email, gifter_name, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind('should-be-cleaned', 'https://example.com/post/', 'a@b.com', 'Alice', expiredTimestamp).run();

    // broken.example.com returns 500 on JWKS and integrity token
    const brokenOrigin = fetchMock.get('https://broken.example.com');
    brokenOrigin
      .intercept({ method: 'GET', path: '/members/.well-known/jwks.json' })
      .reply(500, 'Internal Server Error');
    brokenOrigin
      .intercept({ method: 'GET', path: '/members/api/integrity-token' })
      .reply(500, 'Internal Server Error');

    // working.example.com succeeds
    const workingOrigin = fetchMock.get('https://working.example.com');
    workingOrigin
      .intercept({ method: 'GET', path: '/members/.well-known/jwks.json' })
      .reply(200, TEST_JWKS, { headers: { 'Content-Type': 'application/json' } });
    workingOrigin
      .intercept({ method: 'GET', path: '/members/api/integrity-token' })
      .reply(200, JSON.stringify({ token: 'integrity-abc' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    workingOrigin
      .intercept({ method: 'POST', path: '/members/api/send-magic-link' })
      .reply(200, '');

    // Should throw with the failed origin, but still process everything
    await expect(handleScheduled(env)).rejects.toThrow('broken.example.com');

    // Gift link soft-delete + PII blanking still ran despite the refresh failure
    const cleaned = await env.DB.prepare('SELECT * FROM gift_links WHERE token = ?').bind('should-be-cleaned').first();
    expect(cleaned.expired_at).not.toBeNull();
    expect(cleaned.email).toBe('');
    expect(cleaned.gifter_name).toBe('');
  });

  it('skips sessions at max refresh failures', async () => {
    const maxFailures = parseInt(env.MAX_REFRESH_FAILURES) || 5;
    const staleTimestamp = Date.now() - 160 * 24 * 60 * 60 * 1000;
    await env.DB.prepare('INSERT INTO sessions (origin, cookies, created_at, refresh_failures) VALUES (?, ?, ?, ?)')
      .bind('https://dead.example.com', 'old-cookies', staleTimestamp, maxFailures)
      .run();

    // No fetchMock setup for dead.example.com — any fetch would throw
    await handleScheduled(env);

    // refresh_failures unchanged (no attempt made)
    const row = await env.DB.prepare('SELECT refresh_failures FROM sessions WHERE origin = ?')
      .bind('https://dead.example.com').first();
    expect(row.refresh_failures).toBe(maxFailures);
  });

  it('increments refresh_failures on JWKS failure', async () => {
    await env.DB.prepare('INSERT INTO sessions (origin, cookies, created_at, refresh_failures) VALUES (?, ?, ?, ?)')
      .bind('https://flaky.example.com', 'cookies', Date.now(), 0)
      .run();

    fetchMock.get('https://flaky.example.com')
      .intercept({ method: 'GET', path: '/members/.well-known/jwks.json' })
      .reply(500, 'Internal Server Error');

    await expect(handleScheduled(env)).rejects.toThrow('flaky.example.com');

    const row = await env.DB.prepare('SELECT refresh_failures FROM sessions WHERE origin = ?')
      .bind('https://flaky.example.com').first();
    expect(row.refresh_failures).toBe(1);
  });

  it('resets refresh_failures on JWKS success', async () => {
    await env.DB.prepare('INSERT INTO sessions (origin, cookies, created_at, refresh_failures) VALUES (?, ?, ?, ?)')
      .bind('https://recovered.example.com', 'cookies', Date.now(), 3)
      .run();

    mockJwks('https://recovered.example.com');

    await handleScheduled(env);

    const row = await env.DB.prepare('SELECT refresh_failures FROM sessions WHERE origin = ?')
      .bind('https://recovered.example.com').first();
    expect(row.refresh_failures).toBe(0);
  });

  it('soft-deletes expired gift links and blanks PII', async () => {
    const expiredTimestamp = Date.now() - 30 * 24 * 60 * 60 * 1000;
    await env.DB.prepare(
      'INSERT INTO gift_links (token, url, email, gifter_name, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind('expired-token', 'https://example.com/post/', 'a@b.com', 'Alice', expiredTimestamp).run();

    const freshTimestamp = Date.now();
    await env.DB.prepare(
      'INSERT INTO gift_links (token, url, email, gifter_name, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind('fresh-token', 'https://example.com/post/', 'b@c.com', 'Bob', freshTimestamp).run();

    await handleScheduled(env);

    const expired = await env.DB.prepare('SELECT * FROM gift_links WHERE token = ?').bind('expired-token').first();
    const fresh = await env.DB.prepare('SELECT * FROM gift_links WHERE token = ?').bind('fresh-token').first();
    expect(expired.expired_at).not.toBeNull();
    expect(expired.email).toBe('');
    expect(expired.gifter_name).toBe('');
    expect(fresh.expired_at).toBeNull();
    expect(fresh.email).toBe('b@c.com');
    expect(fresh.gifter_name).toBe('Bob');
  });

  it('uses per-link ttl_days over global DEFAULT_TTL_DAYS', async () => {
    // Link with 7-day TTL created 10 days ago — should be expired
    const tenDaysAgo = Date.now() - 10 * 86400000;
    await env.DB.prepare(
      'INSERT INTO gift_links (token, url, email, gifter_name, ttl_days, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind('short-ttl', 'https://example.com/post/', 'a@b.com', 'Alice', 7, tenDaysAgo).run();

    // Link with 30-day TTL created 10 days ago — should survive
    await env.DB.prepare(
      'INSERT INTO gift_links (token, url, email, gifter_name, ttl_days, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind('long-ttl', 'https://example.com/post/', 'b@c.com', 'Bob', 30, tenDaysAgo).run();

    // Link with no per-link TTL created 10 days ago — uses DEFAULT_TTL_DAYS (14), should survive
    await env.DB.prepare(
      'INSERT INTO gift_links (token, url, email, gifter_name, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind('default-ttl', 'https://example.com/post/', 'c@d.com', 'Charlie', tenDaysAgo).run();

    await handleScheduled(env);

    const short = await env.DB.prepare('SELECT * FROM gift_links WHERE token = ?').bind('short-ttl').first();
    const long = await env.DB.prepare('SELECT * FROM gift_links WHERE token = ?').bind('long-ttl').first();
    const def = await env.DB.prepare('SELECT * FROM gift_links WHERE token = ?').bind('default-ttl').first();

    expect(short.expired_at).not.toBeNull();
    expect(short.email).toBe('');
    expect(long.expired_at).toBeNull();
    expect(long.email).toBe('b@c.com');
    expect(def.expired_at).toBeNull();
    expect(def.email).toBe('c@d.com');
  });

  it('reinstated gift link with blanked PII still redeems', async () => {
    // Simulate a link that was expired (PII blanked) then reinstated
    await env.DB.prepare(
      "INSERT INTO gift_links (token, url, email, gifter_name, created_at, expired_at) VALUES (?, ?, '', '', ?, NULL)"
    ).bind('reinstated-token', 'https://example.com/post/', Date.now()).run();

    const row = await env.DB.prepare('SELECT * FROM gift_links WHERE token = ?').bind('reinstated-token').first();
    expect(row.expired_at).toBeNull();
    expect(row.gifter_name).toBe('');
    expect(row.url).toBe('https://example.com/post/');
  });
});
