// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { verifyClerkJWT } from '../../functions/api/_shared/clerkAuth';

// Runs in the node environment (see directive above), where Web Crypto is a
// global — the same `crypto` clerkAuth uses on the Workers runtime.

const KID = 'test-kid';
const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlBytes = (bytes: Uint8Array) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return b64url(s);
};
const enc = (obj: unknown) => b64url(JSON.stringify(obj));
const env = { CLERK_DOMAIN: 'clerk.safesqlpro.dev' } as unknown as Parameters<typeof verifyClerkJWT>[1];

function reqWith(token?: string): Request {
  return {
    headers: { get: (k: string) => (k.toLowerCase() === 'authorization' && token ? `Bearer ${token}` : null) },
  } as unknown as Request;
}

async function genKeys() {
  return crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
}

async function sign(payload: object, privateKey: CryptoKey): Promise<string> {
  const head = enc({ alg: 'RS256', typ: 'JWT', kid: KID });
  const body = enc(payload);
  const data = new TextEncoder().encode(`${head}.${body}`);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, data);
  return `${head}.${body}.${b64urlBytes(new Uint8Array(sig))}`;
}

function mockJwks(publicJwk: JsonWebKey) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ keys: [{ ...publicJwk, kid: KID }] }) }) as unknown as Response),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('verifyClerkJWT', () => {
  it('returns null when the Authorization header is missing', async () => {
    expect(await verifyClerkJWT(reqWith(), env)).toBeNull();
  });

  it('returns null for an expired token', async () => {
    const { publicKey, privateKey } = await genKeys();
    mockJwks((await crypto.subtle.exportKey('jwk', publicKey)) as JsonWebKey);
    const token = await sign({ sub: 'user_x', exp: Math.floor(Date.now() / 1000) - 60 }, privateKey);
    expect(await verifyClerkJWT(reqWith(token), env)).toBeNull();
  });

  it('returns null for an invalid signature (JWKS holds a different key)', async () => {
    const signer = await genKeys();
    const other = await genKeys();
    mockJwks((await crypto.subtle.exportKey('jwk', other.publicKey)) as JsonWebKey);
    const token = await sign({ sub: 'user_x', exp: Math.floor(Date.now() / 1000) + 600 }, signer.privateKey);
    expect(await verifyClerkJWT(reqWith(token), env)).toBeNull();
  });

  it('returns the sub claim for a valid, signed, unexpired token', async () => {
    const { publicKey, privateKey } = await genKeys();
    mockJwks((await crypto.subtle.exportKey('jwk', publicKey)) as JsonWebKey);
    const token = await sign({ sub: 'user_abc', exp: Math.floor(Date.now() / 1000) + 600 }, privateKey);
    expect(await verifyClerkJWT(reqWith(token), env)).toBe('user_abc');
  });
});
