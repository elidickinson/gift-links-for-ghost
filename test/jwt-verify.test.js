import { describe, it, expect } from 'vitest';
import { verifyJwt } from '../src/jwt-verify.js';
import { generateRsaKeyPair, exportJwks, signJwt } from './test-jwt.js';

describe('verifyJwt', () => {
  const origin = 'https://ghost.example.com';
  const audience = `${origin}/members/api`;

  async function setup(modulusLength) {
    const keyPair = await generateRsaKeyPair(modulusLength);
    const jwks = await exportJwks(keyPair, 'key-1');
    const validPayload = {
      sub: 'member@example.com',
      iss: audience,
      aud: audience,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
    };
    return { keyPair, jwks, validPayload };
  }

  it('verifies JWT signed with 1024-bit RSA key', async () => {
    const { keyPair, jwks, validPayload } = await setup(1024);
    const token = await signJwt(keyPair.privateKey, 'key-1', validPayload);

    const result = await verifyJwt(token, jwks, { issuer: audience, audience });
    expect(result.sub).toBe('member@example.com');
  });

  it('verifies JWT signed with 2048-bit RSA key', async () => {
    const { keyPair, jwks, validPayload } = await setup(2048);
    const token = await signJwt(keyPair.privateKey, 'key-1', validPayload);

    const result = await verifyJwt(token, jwks, { issuer: audience, audience });
    expect(result.sub).toBe('member@example.com');
  });

  it('rejects tampered signature', async () => {
    const { keyPair, jwks, validPayload } = await setup(1024);
    const token = await signJwt(keyPair.privateKey, 'key-1', validPayload);
    const tampered = token.slice(0, -5) + 'XXXXX';

    await expect(verifyJwt(tampered, jwks, { issuer: audience, audience }))
      .rejects.toMatchObject({ code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' });
  });

  it('rejects expired JWT', async () => {
    const { keyPair, jwks, validPayload } = await setup(1024);
    const expired = { ...validPayload, exp: Math.floor(Date.now() / 1000) - 60 };
    const token = await signJwt(keyPair.privateKey, 'key-1', expired);

    await expect(verifyJwt(token, jwks, { issuer: audience, audience }))
      .rejects.toMatchObject({ code: 'ERR_JWT_EXPIRED' });
  });

  it('rejects wrong issuer', async () => {
    const { keyPair, jwks, validPayload } = await setup(1024);
    const wrongIss = { ...validPayload, iss: 'https://evil.com/members/api' };
    const token = await signJwt(keyPair.privateKey, 'key-1', wrongIss);

    await expect(verifyJwt(token, jwks, { issuer: audience, audience }))
      .rejects.toMatchObject({ code: 'ERR_JWT_CLAIM_VALIDATION_FAILED' });
  });

  it('rejects wrong audience', async () => {
    const { keyPair, jwks, validPayload } = await setup(1024);
    const wrongAud = { ...validPayload, aud: 'https://evil.com/members/api' };
    const token = await signJwt(keyPair.privateKey, 'key-1', wrongAud);

    await expect(verifyJwt(token, jwks, { issuer: audience, audience }))
      .rejects.toMatchObject({ code: 'ERR_JWT_CLAIM_VALIDATION_FAILED' });
  });

  it('rejects unknown kid', async () => {
    const { keyPair, jwks, validPayload } = await setup(1024);
    const wrongKidJwks = { keys: [{ ...jwks.keys[0], kid: 'wrong-kid' }] };
    const token = await signJwt(keyPair.privateKey, 'key-1', validPayload);

    await expect(verifyJwt(token, wrongKidJwks, { issuer: audience, audience }))
      .rejects.toThrow('No matching key for kid');
  });

  it('rejects signature from different key', async () => {
    const { jwks, validPayload } = await setup(1024);
    const otherKeyPair = await generateRsaKeyPair(1024);
    const token = await signJwt(otherKeyPair.privateKey, 'key-1', validPayload);

    await expect(verifyJwt(token, jwks, { issuer: audience, audience }))
      .rejects.toMatchObject({ code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' });
  });
});
