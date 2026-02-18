#!/usr/bin/env node
import { createHmac } from 'crypto';
import { createInterface } from 'readline';

const rl = createInterface({ input: process.stdin, output: process.stdout });
const prompt = (q) => new Promise((r) => rl.question(q, r));

function makeJwt(apiKey) {
  const [id, secret] = apiKey.split(':');
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: 'HS256', kid: id, typ: 'JWT' });
  const payload = b64url({ iat: now, exp: now + 300, aud: '/admin/' });
  const sig = createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${sig}`;
}

const remove = process.argv.includes('--remove');

let ghostUrl = process.env.GHOST_URL || (await prompt('Ghost URL (e.g. https://yourblog.com): '));
if (!ghostUrl.includes('://')) ghostUrl = `https://${ghostUrl}`;
ghostUrl = ghostUrl.replace(/\/$/, '');

const apiKey =
  process.env.GHOST_ADMIN_API_KEY ||
  (await prompt('Admin API key (Ghost Admin → Integrations → Add custom integration): '));
rl.close();

const token = makeJwt(apiKey);
const settings = remove
  ? [
      { key: 'stripe_secret_key', value: '' },
      { key: 'stripe_publishable_key', value: '' },
    ]
  : [
      { key: 'stripe_secret_key', value: 'sk_test_fake_for_dev' },
      { key: 'stripe_publishable_key', value: 'pk_test_fake_for_dev' },
    ];

const res = await fetch(`${ghostUrl}/ghost/api/admin/settings/`, {
  method: 'PUT',
  headers: {
    Authorization: `Ghost ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ settings }),
});

if (!res.ok) {
  const data = await res.json().catch(() => ({}));
  console.error('ERROR:', data.errors?.[0]?.message || res.statusText);
  process.exit(1);
}

console.log(remove ? 'Removed dummy Stripe keys' : 'Set dummy Stripe keys (paid members now enabled)');
