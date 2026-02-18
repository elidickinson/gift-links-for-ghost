import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { env, fetchMock } from 'cloudflare:test';
import PostalMime from 'postal-mime';
import { extractMagicLink, followMagicLink, processRawEmail } from '../src/email-handler.js';
import { setupDatabase } from './setup-d1.js';
import emailFixture from './fixtures/magic-link-email.txt?raw';

const EXPECTED_MAGIC_LINK =
  'https://ghost.eli.pizza/members/?token=OAct-0yzjER-KvjPnoj1LAAobDQO22Ux&action=signin&r=https%3A%2F%2Fghost.eli.pizza%2F';

describe('email handler', () => {
  beforeAll(async () => {
    await setupDatabase(env.DB);
  });

  beforeEach(async () => {
    await env.DB.exec('DELETE FROM sessions; DELETE FROM gift_links;');
  });

  afterEach(() => {
    fetchMock.deactivate();
  });

  it('parses magic link from real email fixture', async () => {
    const rawBuffer = new TextEncoder().encode(emailFixture).buffer;
    const parsed = await new PostalMime().parse(rawBuffer);
    const magicLink = extractMagicLink(parsed.text);
    expect(magicLink).toBe(EXPECTED_MAGIC_LINK);
  });

  it('returns null when no magic link present', () => {
    expect(extractMagicLink('Hello, just a normal email.')).toBeNull();
    expect(extractMagicLink(null)).toBeNull();
  });

  it('follows redirect chain and captures session cookies', async () => {
    fetchMock.activate();
    fetchMock.disableNetConnect();

    // workerd fetchMock can only set one Set-Cookie per response (object headers),
    // so we split across two redirects to test accumulation
    const origin = fetchMock.get('https://ghost.eli.pizza');
    origin
      .intercept({ method: 'GET', path: /^\/members\/\?.*token=/ })
      .reply(302, '', {
        headers: {
          'Location': 'https://ghost.eli.pizza/#set-sig',
          'Set-Cookie': 'ghost-members-ssr=session-value; Path=/; HttpOnly; Max-Age=15897600',
        },
      });
    origin
      .intercept({ method: 'GET', path: '/' })
      .reply(302, '', {
        headers: {
          'Location': 'https://ghost.eli.pizza/done',
          'Set-Cookie': 'ghost-members-ssr.sig=sig-value; Path=/; HttpOnly; Max-Age=15897600',
        },
      });
    origin
      .intercept({ method: 'GET', path: '/done' })
      .reply(200, '');

    const cookies = await followMagicLink(EXPECTED_MAGIC_LINK);
    expect(cookies).toBe('ghost-members-ssr=session-value; ghost-members-ssr.sig=sig-value');
  });

  it('processes full email and stores session with JWKS in D1', async () => {
    fetchMock.activate();
    fetchMock.disableNetConnect();

    const testJwks = JSON.stringify({ keys: [{ kty: 'RSA', kid: 'test', n: 'abc', e: 'AQAB' }] });
    const origin = fetchMock.get('https://ghost.eli.pizza');
    origin
      .intercept({ method: 'GET', path: /^\/members\/\?.*token=/ })
      .reply(302, '', {
        headers: {
          'Location': 'https://ghost.eli.pizza/#set-sig',
          'Set-Cookie': 'ghost-members-ssr=full-test-session; Path=/; HttpOnly',
        },
      });
    origin
      .intercept({ method: 'GET', path: '/' })
      .reply(302, '', {
        headers: {
          'Location': 'https://ghost.eli.pizza/done',
          'Set-Cookie': 'ghost-members-ssr.sig=full-test-sig; Path=/; HttpOnly',
        },
      });
    origin
      .intercept({ method: 'GET', path: '/done' })
      .reply(200, '');
    origin
      .intercept({ method: 'GET', path: '/members/.well-known/jwks.json' })
      .reply(200, testJwks, { headers: { 'Content-Type': 'application/json' } });

    const rawBuffer = new TextEncoder().encode(emailFixture).buffer;
    await processRawEmail(rawBuffer, env);

    const row = await env.DB.prepare('SELECT cookies, jwks FROM sessions WHERE origin = ?')
      .bind('https://ghost.eli.pizza').first();
    expect(row.cookies).toBe('ghost-members-ssr=full-test-session; ghost-members-ssr.sig=full-test-sig');
    expect(row.jwks).toBe(testJwks);
  });
});
