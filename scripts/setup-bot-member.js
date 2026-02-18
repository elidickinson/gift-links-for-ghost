#!/usr/bin/env node
import { createHmac } from 'crypto';
import { createInterface } from 'readline';

const rl = createInterface({ input: process.stdin, output: process.stdout });
const prompt = (q) => new Promise((r) => rl.question(q, r));

function makeJwt(apiKey) {
  const [id, secret] = apiKey.split(':');
  const b64url = (obj) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: 'HS256', kid: id, typ: 'JWT' });
  const payload = b64url({ iat: now, exp: now + 300, aud: '/admin/' });
  const sig = createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${sig}`;
}

async function api(base, token, path, opts = {}) {
  const res = await fetch(`${base}/ghost/api/admin${path}`, {
    ...opts,
    headers: {
      Authorization: `Ghost ${token}`,
      'Content-Type': 'application/json',
      ...opts.headers,
    },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    console.error('ERROR:', data.errors?.[0]?.message || res.statusText);
    process.exit(1);
  }
  return res.status === 204 ? {} : await res.json();
}

const force = process.argv.includes('--force');

let ghostUrl = process.env.GHOST_URL || (await prompt('Ghost URL (e.g. https://yourblog.com): '));
if (!ghostUrl.includes('://')) ghostUrl = `https://${ghostUrl}`;
ghostUrl = ghostUrl.replace(/\/$/, '');

const apiKey =
  process.env.GHOST_ADMIN_API_KEY ||
  (await prompt('Admin API key (Ghost Admin → Integrations → Add custom integration): '));
let botEmail = process.env.GHOST_BOT_EMAIL || 'bot@giftlinks.net';
const emailInput = await prompt(`Bot email [${botEmail}]: `);
if (emailInput) botEmail = emailInput;
rl.close();

const token = makeJwt(apiKey);

console.log('==> Getting paid tier ID...');
const { tiers } = await api(ghostUrl, token, '/tiers/');
const paidTier = tiers.find((t) => t.type === 'paid');
if (!paidTier) {
  console.error(
    'ERROR: No paid tier found. Create one in Ghost Admin → Settings → Memberships → Connect Stripe',
  );
  process.exit(1);
}
console.log(`    Using tier: ${paidTier.id}`);

console.log(`==> Setting up bot member ${botEmail}...`);
const existing = await api(ghostUrl, token, `/members/?filter=email:'${botEmail}'&include=tiers`);

const tierPayload = { email: botEmail, tiers: [{ id: paidTier.id }] };

if (existing.members.length) {
  const member = existing.members[0];
  if (member.status === 'comped') {
    console.log(`    Already comped: ${botEmail}`);
  } else if (force) {
    // Ghost's update path doesn't reliably set status to 'comped', so delete and recreate
    await api(ghostUrl, token, `/members/${member.id}/`, { method: 'DELETE' });
    await api(ghostUrl, token, '/members/', {
      method: 'POST',
      body: JSON.stringify({ members: [tierPayload] }),
    });
    console.log(`    Upgraded: ${botEmail}`);
  } else {
    console.error(`ERROR: ${botEmail} exists but is not comped (status: ${member.status})`);
    console.error('  Run with --force to delete and recreate the member');
    process.exit(1);
  }
} else {
  await api(ghostUrl, token, '/members/', {
    method: 'POST',
    body: JSON.stringify({ members: [{ ...tierPayload, name: 'Gift Link Bot' }] }),
  });
  console.log(`    Created: ${botEmail}`);
}

console.log('\nDone. Add this to Code Injection (Site footer):');
console.log('  <script src="https://giftlinks.net/client.js" defer></script>');
