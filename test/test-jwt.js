// Shared JWT test helpers using Web Crypto (no jose dependency)

function base64urlEncode(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function generateRsaKeyPair(modulusLength = 2048) {
  return crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-512' },
    true,
    ['sign', 'verify'],
  );
}

export async function exportJwks(keyPair, kid) {
  const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  jwk.kid = kid;
  return { keys: [jwk] };
}

export async function signJwt(privateKey, kid, payload) {
  const header = { alg: 'RS512', typ: 'JWT', kid };
  const headerB64 = base64urlEncode(JSON.stringify(header));
  const payloadB64 = base64urlEncode(JSON.stringify(payload));
  const input = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, input));
  return `${headerB64}.${payloadB64}.${base64urlEncode(signature)}`;
}
