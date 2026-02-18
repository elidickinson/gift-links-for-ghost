// Verify RS512 JWTs using Web Crypto directly.
// jose enforces a 2048-bit minimum for RSA keys, but Ghost 6 generates
// 1024-bit keys. Web Crypto in workerd accepts 1024-bit keys fine.

function base64urlDecode(str) {
  const padded = str + '='.repeat((4 - str.length % 4) % 4);
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

export async function verifyJwt(token, jwks, { issuer, audience }) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT format');

  if (!jwks?.keys || !Array.isArray(jwks.keys)) {
    throw new Error('Invalid JWKS: missing or invalid "keys" array');
  }

  const header = JSON.parse(new TextDecoder().decode(base64urlDecode(parts[0])));
  if (header.alg !== 'RS512') throw new Error(`Unsupported algorithm: ${header.alg}`);

  const jwk = jwks.keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error(`No matching key for kid: ${header.kid}`);

  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' },
    false,
    ['verify'],
  );

  const signatureInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const signature = base64urlDecode(parts[2]);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, signature, signatureInput);
  if (!valid) throw Object.assign(new Error('signature verification failed'), { code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' });

  const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(parts[1])));

  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw Object.assign(new Error('"exp" claim timestamp check failed'), { code: 'ERR_JWT_EXPIRED' });
  }
  if (issuer && payload.iss !== issuer) {
    throw Object.assign(new Error('unexpected "iss" claim value'), { code: 'ERR_JWT_CLAIM_VALIDATION_FAILED' });
  }
  if (audience && payload.aud !== audience) {
    throw Object.assign(new Error('unexpected "aud" claim value'), { code: 'ERR_JWT_CLAIM_VALIDATION_FAILED' });
  }

  return payload;
}
