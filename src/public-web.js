import landingHtml from '../client/landing.html';
import { refreshSession } from './bot-session.js';
import { log } from './log.js';

const SETUP_MSG_PLACEHOLDER = '<!--SETUP_MSG-->';

export function handleLanding({ error, success, status = 200 } = {}) {
  let msg = '';
  if (error) msg = `<p class="setup-msg setup-error">${error}</p>`;
  if (success) msg = `<p class="setup-msg setup-ok">${success}</p>`;
  const html = landingHtml.replace(SETUP_MSG_PLACEHOLDER, msg);
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': msg ? 'no-store' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    },
  });
}

export async function handleSetup(request, env) {
  const formData = await request.formData();
  let url = (formData.get('url') || '').trim();
  if (url && !/^https?:\/\//.test(url)) url = 'https://' + url;

  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return handleLanding({ error: 'Invalid URL.', status: 400 });
  }

  try {
    await refreshSession(origin, env.BOT_EMAIL);
  } catch (error) {
    log.warn('setup: failed for', origin, error.message);
    return handleLanding({ error: error.message, status: 502 });
  }

  log.info('setup: magic link requested for', origin);
  return handleLanding({ success: 'Request sent. Your Ghost site should be connected in a few seconds.' });
}
