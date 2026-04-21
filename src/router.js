import { handleCreate } from './gift-link.js';
import { handleFetchContent } from './gift-content.js';
import { handleAdmin } from './admin.js';
import { handleLanding, handleSetup } from './public-web.js';
import { processRawEmail } from './email-handler.js';
import { truncate } from './log.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export function corsHeaders() {
  return CORS_HEADERS;
}

export async function handleRequest(request, env, ctx) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);

  if (url.pathname === '/' && request.method === 'GET') {
    return handleLanding({ env });
  }

  if (url.pathname === '/robots.txt' && request.method === 'GET') {
    return new Response('User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /admin\nDisallow: /dev/\nDisallow: /.secret/\n', {
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  if (url.pathname === '/api/setup' && request.method === 'GET') {
    // Something went wrong if GET sent to /api/setup so redirect to home
    return Response.redirect(new URL('/', request.url), 302);
  }

  if (url.pathname === '/api/setup' && request.method === 'POST') {
    return handleSetup(request, env, ctx);
  }

  if (url.pathname === '/api/gift-link/create' && request.method === 'POST') {
    return handleCreate(request, env);
  }

  if (url.pathname === '/api/gift-link/fetch-content' && request.method === 'POST') {
    return handleFetchContent(request, env, ctx);
  }

  if (url.pathname === '/admin' && request.method === 'GET') {
    const authHeader = request.headers.get('Authorization') || '';
    const expected = btoa(`admin:${env.ADMIN_PASSWORD}`);
    if (!env.ADMIN_PASSWORD || authHeader !== `Basic ${expected}`) {
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="Gift Links Admin"' },
      });
    }
    return handleAdmin(env);
  }

  if (url.pathname.startsWith('/.git') || url.pathname.startsWith('/.env') || url.pathname.startsWith('/wp-')) {
    if (env.TARPIT_URL) return Response.redirect(`${env.TARPIT_URL}${url.pathname}`);
    return new Response('Not Found', { status: 404 });
  }

  if (url.pathname.startsWith('/dev/') && env.DEV_MODE) {
    return handleDevRoute(url, request, env);
  }

  return new Response('Not Found', { status: 404 });
}

async function handleDevRoute(url, request, env) {
  const pathname = url.pathname;

  if (pathname === '/dev/simulate-email' && request.method === 'POST') {
    const rawEmail = await request.arrayBuffer();
    await processRawEmail(rawEmail, env);
    return Response.json({ ok: true });
  }

  if (pathname === '/dev/test-connection' && request.method === 'GET') {
    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) {
      return new Response(JSON.stringify({ error: 'Missing url parameter' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const response = await fetch(targetUrl);
    const body = await response.text();
    const result = {
      url: targetUrl,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: truncate(body),
    };
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response('Not Found', { status: 404 });
}
