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
    return handleScheduled(env);
  },
};
