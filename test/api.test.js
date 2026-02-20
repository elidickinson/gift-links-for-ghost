import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { env, SELF, fetchMock } from 'cloudflare:test';
import { generateRsaKeyPair, exportJwks, signJwt } from './test-jwt.js';
import { setupDatabase } from './setup-d1.js';

let testKeyPair;
let testJwksJson;

beforeAll(async () => {
  await setupDatabase(env.DB);
  testKeyPair = await generateRsaKeyPair();
  const jwks = await exportJwks(testKeyPair, 'test-key-1');
  testJwksJson = JSON.stringify(jwks);
});

describe('API', () => {
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM sessions; DELETE FROM gift_links; DELETE FROM link_views;');
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  afterEach(() => {
    fetchMock.deactivate();
  });

  async function signedJwt(email, origin, overrides = {}) {
    const audience = `${origin}/members/api`;
    const now = Math.floor(Date.now() / 1000);
    return signJwt(testKeyPair.privateKey, 'test-key-1', {
      sub: email,
      iss: overrides.issuer ?? audience,
      aud: overrides.audience ?? audience,
      iat: now,
      exp: overrides.exp ?? now + 600,
    });
  }

  async function seedSession(origin, cookies) {
    await env.DB.prepare('INSERT INTO sessions (origin, cookies, jwks, created_at) VALUES (?, ?, ?, ?)')
      .bind(origin, cookies, testJwksJson, Date.now())
      .run();
  }

  it('create + redeem round-trip', async () => {
    await seedSession('https://www.example.com', 'ghost-members-ssr=val; ghost-members-ssr.sig=sig');

    // Create gift link
    const jwt = await signedJwt('alice@example.com', 'https://www.example.com');
    const createResponse = await SELF.fetch('https://worker/api/gift-link/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jwt,
        url: 'https://www.example.com/my-post/',
        gifter_name: 'Alice',
      }),
    });

    expect(createResponse.status).toBe(200);
    const { token } = await createResponse.json();
    expect(token).toBeTruthy();
    expect(token.length).toBe(14);

    // Mock the Ghost page fetch
    fetchMock.get('https://www.example.com')
      .intercept({ method: 'GET', path: '/my-post/' })
      .reply(200, '<html><body><section class="gh-content"><p>Full article</p></section></body></html>', {
        headers: { 'Content-Type': 'text/html' },
      });

    // Redeem gift link
    const redeemResponse = await SELF.fetch('https://worker/api/gift-link/fetch-content', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, url: 'https://www.example.com/my-post/' }),
    });

    expect(redeemResponse.status).toBe(200);
    const result = await redeemResponse.json();
    expect(result.html).toContain('Full article');
    expect(result.gifter_name).toBe('Alice');
  });

  it('redeem with custom content_selector extracts from specified element', async () => {
    await seedSession('https://www.example.com', 'ghost-members-ssr=val; ghost-members-ssr.sig=sig');

    const jwt = await signedJwt('alice@example.com', 'https://www.example.com');
    const createResponse = await SELF.fetch('https://worker/api/gift-link/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jwt, url: 'https://www.example.com/my-post/', gifter_name: 'Alice' }),
    });
    const { token } = await createResponse.json();

    // Page has both gh-content and a custom container — custom selector should win
    const pageHtml = `<html><body>
      <section class="gh-content"><p>Default content</p></section>
      <div class="custom-theme-body"><p>Custom theme content</p></div>
    </body></html>`;

    fetchMock.get('https://www.example.com')
      .intercept({ method: 'GET', path: '/my-post/' })
      .reply(200, pageHtml, { headers: { 'Content-Type': 'text/html' } });

    const redeemResponse = await SELF.fetch('https://worker/api/gift-link/fetch-content', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, url: 'https://www.example.com/my-post/', content_selector: 'div.custom-theme-body' }),
    });

    expect(redeemResponse.status).toBe(200);
    const result = await redeemResponse.json();
    expect(result.html).toContain('Custom theme content');
    expect(result.html).not.toContain('Default content');
  });

  it('redeem handles nested sections correctly', async () => {
    await seedSession('https://www.example.com', 'ghost-members-ssr=val; ghost-members-ssr.sig=sig');

    const jwt = await signedJwt('alice@example.com', 'https://www.example.com');
    const createResponse = await SELF.fetch('https://worker/api/gift-link/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jwt, url: 'https://www.example.com/my-post/', gifter_name: 'Alice' }),
    });
    const { token } = await createResponse.json();

    // Nested sections — the old regex would truncate at first </section>
    const pageHtml = `<html><body>
      <section class="gh-content">
        <p>Before nested</p>
        <section class="gh-card"><p>Nested card</p></section>
        <p>After nested</p>
      </section>
    </body></html>`;

    fetchMock.get('https://www.example.com')
      .intercept({ method: 'GET', path: '/my-post/' })
      .reply(200, pageHtml, { headers: { 'Content-Type': 'text/html' } });

    const redeemResponse = await SELF.fetch('https://worker/api/gift-link/fetch-content', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, url: 'https://www.example.com/my-post/' }),
    });

    expect(redeemResponse.status).toBe(200);
    const result = await redeemResponse.json();
    expect(result.html).toContain('Before nested');
    expect(result.html).toContain('Nested card');
    expect(result.html).toContain('After nested');
  });

  it('returns not_found for missing token', async () => {
    const response = await SELF.fetch('https://worker/api/gift-link/fetch-content', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'nonexistent', url: 'https://example.com/post/' }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
  });

  it('returns expired for soft-deleted token', async () => {
    await env.DB.prepare(
      'INSERT INTO gift_links (token, url, email, gifter_name, created_at, expired_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind('soft-deleted', 'https://example.com/post/', 'a@b.com', 'Alice', Date.now() - 30 * 86400000, Date.now()).run();

    const response = await SELF.fetch('https://worker/api/gift-link/fetch-content', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'soft-deleted', url: 'https://example.com/post/' }),
    });

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: 'expired' });
  });

  it('returns invalid when URL does not match token metadata', async () => {
    await seedSession('https://www.example.com', 'ghost-members-ssr=val; ghost-members-ssr.sig=sig');

    const jwt = await signedJwt('alice@example.com', 'https://www.example.com');
    const createResponse = await SELF.fetch('https://worker/api/gift-link/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jwt,
        url: 'https://www.example.com/my-post/',
        gifter_name: 'Alice',
      }),
    });
    const { token } = await createResponse.json();

    const redeemResponse = await SELF.fetch('https://worker/api/gift-link/fetch-content', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, url: 'https://www.example.com/wrong-post/' }),
    });

    expect(redeemResponse.status).toBe(400);
    expect(await redeemResponse.json()).toEqual({ error: 'invalid' });
  });

  it('rejects gift link creation for unknown origin', async () => {
    const response = await SELF.fetch('https://worker/api/gift-link/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jwt: 'ignored',
        url: 'https://no-session.example.com/post/',
        gifter_name: 'Bob',
      }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'unknown_origin' });
  });

  it('rejects forged JWT', async () => {
    await seedSession('https://www.example.com', 'ghost-members-ssr=val; ghost-members-ssr.sig=sig');

    const forgedJwt = [
      btoa(JSON.stringify({ alg: 'RS512', typ: 'JWT', kid: 'test-key-1' })),
      btoa(JSON.stringify({ sub: 'forger@example.com', iss: 'https://www.example.com/members/api', aud: 'https://www.example.com/members/api' })),
      'fake-signature',
    ].join('.');

    const response = await SELF.fetch('https://worker/api/gift-link/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jwt: forgedJwt,
        url: 'https://www.example.com/post/',
        gifter_name: 'Forger',
      }),
    });

    expect(response.status).toBe(401);
    const forgedResult = await response.json();
    expect(forgedResult.error).toBe('invalid_token');
    expect(forgedResult.code).toBe('ERR_JWS_SIGNATURE_VERIFICATION_FAILED');
  });

  it('rejects expired JWT', async () => {
    await seedSession('https://www.example.com', 'ghost-members-ssr=val; ghost-members-ssr.sig=sig');

    const expiredJwt = await signedJwt('alice@example.com', 'https://www.example.com', {
      exp: Math.floor(Date.now() / 1000) - 60,
    });

    const response = await SELF.fetch('https://worker/api/gift-link/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jwt: expiredJwt,
        url: 'https://www.example.com/post/',
        gifter_name: 'Alice',
      }),
    });

    expect(response.status).toBe(401);
    const expiredResult = await response.json();
    expect(expiredResult.error).toBe('invalid_token');
    expect(expiredResult.code).toBe('ERR_JWT_EXPIRED');
  });

  it('rejects JWT from wrong site', async () => {
    await seedSession('https://www.example.com', 'ghost-members-ssr=val; ghost-members-ssr.sig=sig');

    const crossSiteJwt = await signedJwt('alice@example.com', 'https://www.example.com', {
      issuer: 'https://evil.com/members/api',
    });

    const response = await SELF.fetch('https://worker/api/gift-link/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jwt: crossSiteJwt,
        url: 'https://www.example.com/post/',
        gifter_name: 'Eve',
      }),
    });

    expect(response.status).toBe(401);
    const result = await response.json();
    expect(result.error).toBe('invalid_token');
    expect(result.code).toBe('ERR_JWT_CLAIM_VALIDATION_FAILED');
  });

  it('rejects when session has no cached JWKS', async () => {
    // Seed session without JWKS
    await env.DB.prepare('INSERT INTO sessions (origin, cookies, created_at) VALUES (?, ?, ?)')
      .bind('https://www.example.com', 'ghost-members-ssr=val; ghost-members-ssr.sig=sig', Date.now())
      .run();

    const jwt = await signedJwt('alice@example.com', 'https://www.example.com');
    const response = await SELF.fetch('https://worker/api/gift-link/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jwt,
        url: 'https://www.example.com/post/',
        gifter_name: 'Alice',
      }),
    });

    expect(response.status).toBe(401);
    const result = await response.json();
    expect(result.error).toBe('invalid_token');
    expect(result.message).toContain('No cached JWKS');
  });

  it('strips www from referer domain in view analytics', async () => {
    await seedSession('https://www.example.com', 'ghost-members-ssr=val; ghost-members-ssr.sig=sig');

    const jwt = await signedJwt('alice@example.com', 'https://www.example.com');
    const createResponse = await SELF.fetch('https://worker/api/gift-link/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jwt,
        url: 'https://www.example.com/my-post/',
        gifter_name: 'Alice',
      }),
    });
    const { token } = await createResponse.json();

    fetchMock.get('https://www.example.com')
      .intercept({ method: 'GET', path: '/my-post/' })
      .reply(200, '<html><body><section class="gh-content"><p>Content</p></section></body></html>', {
        headers: { 'Content-Type': 'text/html' },
      });

    await SELF.fetch('https://worker/api/gift-link/fetch-content', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Referer': 'https://www.twitter.com/status/123',
      },
      body: JSON.stringify({ token, url: 'https://www.example.com/my-post/' }),
    });

    // waitUntil runs synchronously in test env
    const view = await env.DB.prepare('SELECT referer_domain, country FROM link_views WHERE token = ?')
      .bind(token).first();
    expect(view.referer_domain).toBe('twitter.com');
    expect(view.country).toBeNull();
  });

  it('returns fetch_failed when bot session sees paywall', async () => {
    await seedSession('https://www.example.com', 'ghost-members-ssr=val; ghost-members-ssr.sig=sig');

    const jwt = await signedJwt('alice@example.com', 'https://www.example.com');
    const createResponse = await SELF.fetch('https://worker/api/gift-link/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jwt, url: 'https://www.example.com/my-post/', gifter_name: 'Alice' }),
    });
    const { token } = await createResponse.json();

    // Ghost returns a paywalled page (bot session expired)
    const paywallHtml = `<html><body>
      <section class="gh-content">
        <p>Preview paragraph</p>
        <aside class="gh-post-upgrade-cta">
          <div class="gh-post-upgrade-cta-content"><h2>This post is for paying subscribers only</h2></div>
        </aside>
      </section>
    </body></html>`;

    fetchMock.get('https://www.example.com')
      .intercept({ method: 'GET', path: '/my-post/' })
      .reply(200, paywallHtml, { headers: { 'Content-Type': 'text/html' } });

    const redeemResponse = await SELF.fetch('https://worker/api/gift-link/fetch-content', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, url: 'https://www.example.com/my-post/' }),
    });

    expect(redeemResponse.status).toBe(502);
    expect(await redeemResponse.json()).toEqual({ error: 'fetch_failed' });
  });

  it('returns fetch_failed when Ghost returns non-200', async () => {
    await seedSession('https://www.example.com', 'ghost-members-ssr=val; ghost-members-ssr.sig=sig');

    const jwt = await signedJwt('alice@example.com', 'https://www.example.com');
    const createResponse = await SELF.fetch('https://worker/api/gift-link/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jwt, url: 'https://www.example.com/my-post/', gifter_name: 'Alice' }),
    });
    const { token } = await createResponse.json();

    fetchMock.get('https://www.example.com')
      .intercept({ method: 'GET', path: '/my-post/' })
      .reply(500, 'Internal Server Error');

    const redeemResponse = await SELF.fetch('https://worker/api/gift-link/fetch-content', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, url: 'https://www.example.com/my-post/' }),
    });

    expect(redeemResponse.status).toBe(502);
    expect(await redeemResponse.json()).toEqual({ error: 'fetch_failed' });
  });

  it('returns fetch_failed when no content selector matches', async () => {
    await seedSession('https://www.example.com', 'ghost-members-ssr=val; ghost-members-ssr.sig=sig');

    const jwt = await signedJwt('alice@example.com', 'https://www.example.com');
    const createResponse = await SELF.fetch('https://worker/api/gift-link/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jwt, url: 'https://www.example.com/my-post/', gifter_name: 'Alice' }),
    });
    const { token } = await createResponse.json();

    // Page with no matching content container
    fetchMock.get('https://www.example.com')
      .intercept({ method: 'GET', path: '/my-post/' })
      .reply(200, '<html><body><div class="unknown-theme"><p>Content</p></div></body></html>', {
        headers: { 'Content-Type': 'text/html' },
      });

    const redeemResponse = await SELF.fetch('https://worker/api/gift-link/fetch-content', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, url: 'https://www.example.com/my-post/' }),
    });

    expect(redeemResponse.status).toBe(502);
    expect(await redeemResponse.json()).toEqual({ error: 'fetch_failed' });
  });

  it('records null referer for invalid referer header', async () => {
    await seedSession('https://www.example.com', 'ghost-members-ssr=val; ghost-members-ssr.sig=sig');

    const jwt = await signedJwt('alice@example.com', 'https://www.example.com');
    const createResponse = await SELF.fetch('https://worker/api/gift-link/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jwt,
        url: 'https://www.example.com/my-post/',
        gifter_name: 'Alice',
      }),
    });
    const { token } = await createResponse.json();

    fetchMock.get('https://www.example.com')
      .intercept({ method: 'GET', path: '/my-post/' })
      .reply(200, '<html><body><section class="gh-content"><p>Content</p></section></body></html>', {
        headers: { 'Content-Type': 'text/html' },
      });

    await SELF.fetch('https://worker/api/gift-link/fetch-content', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Referer': 'not-a-url',
      },
      body: JSON.stringify({ token, url: 'https://www.example.com/my-post/' }),
    });

    const view = await env.DB.prepare('SELECT referer_domain FROM link_views WHERE token = ?')
      .bind(token).first();
    expect(view.referer_domain).toBeNull();
  });
});

describe('admin auth', () => {
  it('rejects missing credentials', async () => {
    const response = await SELF.fetch('https://worker/admin');
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Basic realm="Gift Links Admin"');
  });

  it('rejects wrong credentials', async () => {
    const response = await SELF.fetch('https://worker/admin', {
      headers: { 'Authorization': `Basic ${btoa('admin:wrong-password')}` },
    });
    expect(response.status).toBe(401);
  });

  it('accepts correct credentials', async () => {
    const response = await SELF.fetch('https://worker/admin', {
      headers: { 'Authorization': `Basic ${btoa('admin:test-password')}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    const html = await response.text();
    expect(html).toContain('Gift Links Admin');
  });
});

describe('CORS preflight', () => {
  it('responds to OPTIONS with wildcard CORS headers', async () => {
    const response = await SELF.fetch('https://worker/api/gift-link/create', {
      method: 'OPTIONS',
      headers: { 'Origin': 'https://ghost.example.com' },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Content-Type');
  });
});
