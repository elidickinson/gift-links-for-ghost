const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let threshold = LEVELS.info;
let initialized = false;

export function truncate(str, max = 4096) {
  return str.length > max ? str.slice(0, max) + '... [truncated]' : str;
}

export function setLevel(level) {
  if (initialized) return;
  threshold = LEVELS[level] ?? LEVELS.info;
  initialized = true;
}

export const log = {
  debug: (...args) => threshold <= LEVELS.debug && console.log('[debug]', ...args),
  info:  (...args) => threshold <= LEVELS.info  && console.log('[info]', ...args),
  warn:  (...args) => threshold <= LEVELS.warn  && console.warn('[warn]', ...args),
  error: (...args) => threshold <= LEVELS.error && console.error('[error]', ...args),
};
