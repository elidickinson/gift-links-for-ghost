export function uaFetch(url, options) {
  const headers = { ...options?.headers, 'User-Agent': 'giftlinks-net-bot/1.0' };
  return fetch(url, { ...options, headers });
}
