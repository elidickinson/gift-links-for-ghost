import { handleCreate } from './gift-link.js';
import { handleFetchContent } from './gift-content.js';
import { handleAdmin } from './admin.js';
import { handleLanding, handleSetup } from './public-web.js';
import { processRawEmail } from './email-handler.js';

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
    return handleLanding();
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

  if (url.pathname.startsWith('/.') || url.pathname.startsWith('/wp-')) {
    // Send annoying bots to the tarpit to waste their time. Childish, I know...
    return Response.redirect(`https://tarpit.esd.workers.dev${url.pathname}`);
  }

  if (url.pathname.startsWith('/dev/') && env.DEV_MODE) {
    return handleDevRoute(url.pathname, request, env);
  }

  return new Response('Not Found', { status: 404 });
}

async function handleDevRoute(pathname, request, env) {
  if (pathname === '/dev/simulate-email' && request.method === 'POST') {
    const rawEmail = await request.arrayBuffer();
    await processRawEmail(rawEmail, env);
    return Response.json({ ok: true });
  }

  return new Response('Not Found', { status: 404 });
}
