import PostalMime from 'postal-mime';
import { storeBotSession } from './bot-session.js';
import { log } from './log.js';
import { uaFetch } from './ua-fetch.js';

const MAGIC_LINK_REGEX = /https?:\/\/[^\s"]+\/members\/\?token=[^\s"]+/;

export function extractMagicLink(text) {
  const match = text?.match(MAGIC_LINK_REGEX);
  return match ? match[0] : null;
}

export async function followMagicLink(url) {
  const cookies = [];
  let currentUrl = url;

  while (true) {
    const response = await uaFetch(currentUrl, { redirect: 'manual' });
    const setCookies = response.headers.getSetCookie();
    cookies.push(...setCookies);

    const location = response.headers.get('Location');
    if (response.status >= 300 && response.status < 400 && location) {
      currentUrl = new URL(location, currentUrl).href;
    } else {
      break;
    }
  }

  return cookies
    .filter(c => c.startsWith('ghost-members-ssr'))
    .map(c => c.split(';')[0])
    .join('; ');
}

export async function processRawEmail(rawEmailBuffer, env) {
  const parsedEmail = await new PostalMime().parse(rawEmailBuffer);
  const magicLinkUrl = extractMagicLink(parsedEmail.text);
  if (!magicLinkUrl) {
    log.warn('email: no magic link found');
    return;
  }

  const origin = new URL(magicLinkUrl).origin;
  log.debug('email: following magic link for', origin);
  const sessionCookies = await followMagicLink(magicLinkUrl);

  // Fetch JWKS so JWT verification works immediately
  const jwksResponse = await uaFetch(`${origin}/members/.well-known/jwks.json`);
  const jwks = jwksResponse.ok ? await jwksResponse.text() : null;
  if (!jwks) {
    log.warn('email: JWKS fetch failed for', origin, jwksResponse.status);
  }

  await storeBotSession(env, origin, sessionCookies, jwks);
  log.info('email: session stored for', origin);
}

export async function handleEmail(message, env) {
  const rawEmail = await new Response(message.raw).arrayBuffer();
  return processRawEmail(rawEmail, env);
}
