import { log } from './log.js';

export async function sendPushover(env, message) {
  if (!env.PUSHOVER_USER || !env.PUSHOVER_TOKEN) return;

  try {
    const resp = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: env.PUSHOVER_TOKEN,
        user: env.PUSHOVER_USER,
        message,
        priority: -1,
      }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    log.info('pushover: notification sent');
  } catch (error) {
    log.warn('pushover: notification failed', error.message);
  }
}
