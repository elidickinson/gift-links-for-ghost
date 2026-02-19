import { handleEmail } from './email-handler.js';
import { handleRequest } from './router.js';
import { handleScheduled } from './session-refresh.js';
import { setLevel } from './log.js';

export default {
  async fetch(request, env, ctx) {
    setLevel(env.LOG_LEVEL);
    return handleRequest(request, env, ctx);
  },

  async email(message, env, ctx) {
    setLevel(env.LOG_LEVEL);
    return handleEmail(message, env, ctx);
  },

  async scheduled(event, env, ctx) {
    setLevel(env.LOG_LEVEL);
    // Daily maintenance cron — must match wrangler.toml [triggers].crons
    if (event.cron === '0 4 * * *') {
      return handleScheduled(env);
    }
    // Keepalive: touch D1 to prevent cold starts
    await env.DB.prepare('SELECT 1').run();
  },
};
