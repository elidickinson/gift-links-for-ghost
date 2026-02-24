import { escapeHtml } from './escape-html.js';

export async function handleAdmin(env) {
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  const [
    linksTotal,
    linksRecent,
    viewsTotal,
    viewsRecent,
    sessions,
    recentLinks,
    recentActivity,
    topPosts,
    linksPerOrigin,
  ] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) as count FROM gift_links WHERE expired_at IS NULL').first(),
    env.DB.prepare('SELECT COUNT(*) as count FROM gift_links WHERE created_at > ? AND expired_at IS NULL').bind(sevenDaysAgo).first(),
    env.DB.prepare('SELECT COUNT(*) as count FROM link_views').first(),
    env.DB.prepare('SELECT COUNT(*) as count FROM link_views WHERE viewed_at > ?').bind(sevenDaysAgo).first(),
    env.DB.prepare(`SELECT origin, cookies, created_at, jwks, last_magic_link_at, refresh_failures
      FROM sessions ORDER BY created_at DESC`).all(),
    env.DB.prepare(`
      SELECT gl.token, gl.url, gl.gifter_name, gl.email, gl.created_at, gl.expired_at, gl.max_views, gl.ttl_days,
             COUNT(lv.viewed_at) as views
      FROM gift_links gl
      LEFT JOIN link_views lv ON lv.token = gl.token
      GROUP BY gl.token
      ORDER BY gl.created_at DESC LIMIT 50
    `).all(),
    env.DB.prepare(`
      SELECT lv.token, lv.viewed_at, lv.referer_domain, lv.country,
             gl.url, gl.gifter_name, gl.email
      FROM link_views lv
      LEFT JOIN gift_links gl ON gl.token = lv.token
      ORDER BY lv.viewed_at DESC LIMIT 50
    `).all(),
    env.DB.prepare(`
      SELECT gl.url,
             COUNT(DISTINCT gl.token) as links_created,
             COUNT(lv.viewed_at) as redemptions
      FROM gift_links gl
      LEFT JOIN link_views lv ON lv.token = gl.token
      WHERE gl.created_at > ?
      GROUP BY gl.url
      ORDER BY redemptions DESC LIMIT 20
    `).bind(thirtyDaysAgo).all(),
    env.DB.prepare('SELECT url FROM gift_links WHERE expired_at IS NULL').all(),
  ]);

  // Build origin -> active link count map
  const linkCounts = {};
  for (const row of linksPerOrigin.results) {
    try {
      const o = new URL(row.url).origin;
      linkCounts[o] = (linkCounts[o] || 0) + 1;
    } catch { /* skip malformed */ }
  }

  const now = Date.now();
  const maxFailures = parseInt(env.MAX_REFRESH_FAILURES) || 5;

  const html = renderPage({
    linksTotal: linksTotal.count,
    linksRecent: linksRecent.count,
    viewsTotal: viewsTotal.count,
    viewsRecent: viewsRecent.count,
    sessions: sessions.results,
    recentLinks: recentLinks.results,
    recentActivity: recentActivity.results,
    topPosts: topPosts.results,
    linkCounts,
    maxFailures,
    now,
  });

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    },
  });
}

function sessionStatus(s, maxFailures) {
  if (s.refresh_failures >= maxFailures) return { label: 'disabled', cls: 'badge-red' };
  const ageDays = (Date.now() - s.created_at) / 86400000;
  if (ageDays > 150) return { label: 'stale', cls: 'badge-yellow' };
  return { label: 'healthy', cls: 'badge-green' };
}

function renderPage(data) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gift Links Admin</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 1100px; margin: 0 auto; padding: 20px; color: #333; }
  h1 { font-size: 20px; margin-bottom: 24px; }
  h2 { font-size: 16px; margin-top: 32px; border-bottom: 1px solid #eee; padding-bottom: 8px; }
  .stats { display: flex; gap: 24px; flex-wrap: wrap; }
  .stat { background: #f8f9fa; padding: 16px; border-radius: 8px; min-width: 140px; }
  .expired { color: #d32f2f; font-style: italic; }
  .stat-value { font-size: 28px; font-weight: 600; }
  .stat-label { font-size: 13px; color: #666; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 12px; }
  th { text-align: left; padding: 8px; border-bottom: 2px solid #eee; font-weight: 600; }
  td { padding: 8px; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
  .mono { font-family: monospace; font-size: 12px; }
  .muted { color: #999; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .badge-green { background: #e6f4ea; color: #1e7e34; }
  .badge-yellow { background: #fff8e1; color: #b8860b; }
  .badge-red { background: #fdecea; color: #d32f2f; }
  .detail { font-size: 11px; color: #888; }
  .post-path { max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
</head>
<body>
<h1>Gift Links Admin</h1>

<div class="stats">
  <div class="stat">
    <div class="stat-value">${data.linksTotal}</div>
    <div class="stat-label">Active gift links</div>
  </div>
  <div class="stat">
    <div class="stat-value">${data.linksRecent}</div>
    <div class="stat-label">Created (7d)</div>
  </div>
  <div class="stat">
    <div class="stat-value">${data.viewsTotal}</div>
    <div class="stat-label">Total redemptions</div>
  </div>
  <div class="stat">
    <div class="stat-value">${data.viewsRecent}</div>
    <div class="stat-label">Redemptions (7d)</div>
  </div>
  <div class="stat">
    <div class="stat-value">${data.sessions.length}</div>
    <div class="stat-label">Sessions</div>
  </div>
</div>

<h2>Recent Gift Links</h2>
<table>
  <tr><th>Token</th><th>Post</th><th>Gifter</th><th>Created</th><th>Expires</th><th>Views</th><th>Limit</th></tr>
  ${data.recentLinks.map(l => {
    const when = timeAgo(data.now - l.created_at);
    const expiredClass = l.expired_at ? 'expired' : '';
    const expiresDisplay = l.expired_at
      ? '<span class="expired">expired</span>'
      : l.ttl_days
        ? timeUntil(l.created_at + l.ttl_days * 86400000 - data.now)
        : '<span class="muted">never</span>';
    const limitDisplay = l.max_views
      ? (l.views >= l.max_views ? `<span class="muted">${l.views}&nbsp;/&nbsp;${l.max_views}</span>` : `${l.views}&nbsp;/&nbsp;${l.max_views}`)
      : '<span class="muted">\u221e</span>';
    return `<tr>
    <td class="mono"><a href="${l.url}?gift=${escapeHtml(l.token)}" target="_blank" rel="noreferrer noopener" >${escapeHtml(l.token.slice(0, 8))}\u2026</a></td>
    <td class="mono post-path ${expiredClass}" title="${escapeHtml(l.url || '')}">${escapeHtml(l.url) || '<span class="muted">\u2014</span>'}</td>
    <td>${escapeHtml(l.gifter_name || '\u2014')}${l.email ? `<div class="detail">${escapeHtml(l.email)}</div>` : ''}</td>
    <td title="${formatDate(l.created_at)}">${when}</td>
    <td>${expiresDisplay}</td>
    <td>${l.views}</td>
    <td>${limitDisplay}</td>
  </tr>`;
  }).join('')}
</table>

<h2>Sessions</h2>
<table>
  <tr><th>Origin</th><th>Status</th><th>Age</th><th>JWKS</th><th>Last Magic Link</th><th>Failures</th><th>Links</th></tr>
  ${data.sessions.map(s => {
    const status = sessionStatus(s, data.maxFailures);
    const ageDays = Math.floor((data.now - s.created_at) / 86400000);
    const hasJwks = !!s.jwks;
    let jwksKeys = 0;
    if (hasJwks) { try { jwksKeys = JSON.parse(s.jwks).keys?.length || 0; } catch {} }
    const lastMagic = s.last_magic_link_at ? timeAgo(data.now - s.last_magic_link_at) : '\u2014';
    const linkCount = data.linkCounts[s.origin] || 0;
    return `<tr>
    <td class="mono">${escapeHtml(s.origin)}</td>
    <td><span class="badge ${status.cls}">${status.label}</span></td>
    <td>${ageDays}d</td>
    <td>${hasJwks ? `<span class="badge badge-green">${jwksKeys} key${jwksKeys !== 1 ? 's' : ''}</span>` : '<span class="badge badge-red">none</span>'}</td>
    <td>${lastMagic}</td>
    <td${s.refresh_failures >= data.maxFailures ? ' style="color: #d32f2f; font-weight: 600"' : ''}>${s.refresh_failures}</td>
    <td>${linkCount}</td>
  </tr>`;
  }).join('')}
</table>

<h2>Top Posts (30d)</h2>
<table>
  <tr><th>Post</th><th>Links</th><th>Redemptions</th></tr>
  ${data.topPosts.map(p => {
    return `<tr>
    <td class="mono post-path">${escapeHtml(p.url)}</td>
    <td>${p.links_created}</td>
    <td>${p.redemptions}</td>
  </tr>`;
  }).join('')}
</table>

<h2>Recent Activity</h2>
<table>
  <tr><th>Token</th><th>Post</th><th>Gifter</th><th>When</th><th>Referer</th><th>Country</th></tr>
  ${data.recentActivity.map(a => {
    const path = a.url ? postPath(a.url) : '(expired)';
    const when = timeAgo(data.now - a.viewed_at);
    return `<tr>
    <td class="mono">${escapeHtml(a.token.slice(0, 8))}\u2026</td>
    <td class="mono post-path">${escapeHtml(a.url)}</td>
    <td>${escapeHtml(a.gifter_name || '\u2014')}${a.email ? `<div class="detail">${escapeHtml(a.email)}</div>` : ''}</td>
    <td title="${formatDate(a.viewed_at)}">${when}</td>
    <td>${a.referer_domain ? escapeHtml(a.referer_domain) : '<span class="muted">direct</span>'}</td>
    <td>${a.country || '<span class="muted">\u2014</span>'}</td>
  </tr>`;
  }).join('')}
</table>

</body>
</html>`;
}

function postPath(url) {
  try { return new URL(url).pathname.replace(/\/$/, ''); } catch { return url; }
}

function timeAgo(ms) {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function timeUntil(ms) {
  if (ms <= 0) return '<span class="expired">expired</span>';
  const hours = Math.floor(ms / 3600000);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function formatDate(timestamp) {
  return new Date(timestamp).toISOString().replace('T', ' ').slice(0, 19);
}
