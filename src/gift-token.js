export async function createGiftToken(env, { url, email, gifter_name, max_views, ttl_days }) {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  const token = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, 'x')
    .replace(/\//g, 'y')
    .replace(/=/g, '');

  await env.DB.prepare(
    'INSERT INTO gift_links (token, url, email, gifter_name, max_views, ttl_days, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(token, url, email, gifter_name, max_views, ttl_days, Date.now()).run();

  return token;
}

export async function lookupGiftToken(env, token) {
  return env.DB.prepare('SELECT * FROM gift_links WHERE token = ?').bind(token).first();
}
