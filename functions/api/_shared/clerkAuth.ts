import type { Env } from '../../_shared';

// Decode a base64url segment (JWT parts are base64url, not standard base64).
function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  return atob(b64 + pad);
}

interface Jwk {
  kid?: string;
  [k: string]: unknown;
}

// Verify a Clerk-issued session JWT (RS256) against the instance JWKS and return
// the `sub` claim (the Clerk user id), or null if the token is missing, malformed,
// untrusted, or expired. No SDK — runs on the Workers runtime via Web Crypto.
//
// This is deterministic auth, not detection; it gates the billing portal so a
// caller can't spoof another user's clerkUserId in the request body.
export async function verifyClerkJWT(request: Request, env: Env): Promise<string | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();

  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  if (!env.CLERK_DOMAIN) return null;

  try {
    let header: { kid?: string };
    try {
      header = JSON.parse(b64urlDecode(headerB64));
    } catch {
      return null;
    }
    if (!header.kid) return null;

    const jwksRes = await fetch(`https://${env.CLERK_DOMAIN}/.well-known/jwks.json`);
    if (!jwksRes.ok) return null;
    const jwks = (await jwksRes.json()) as { keys?: Jwk[] };
    const key = jwks.keys?.find((k) => k.kid === header.kid);
    if (!key) return null;

    const cryptoKey = await crypto.subtle.importKey(
      'jwk',
      key as unknown as JsonWebKey,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );

    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const sig = Uint8Array.from(b64urlDecode(sigB64), (c) => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, sig, data);
    if (!valid) return null;

    const payload = JSON.parse(b64urlDecode(payloadB64)) as { sub?: string; exp?: number; nbf?: number };
    const now = Date.now() / 1000;
    if (typeof payload.exp === 'number' && payload.exp < now) return null;
    if (typeof payload.nbf === 'number' && payload.nbf > now + 60) return null;
    return payload.sub ?? null;
  } catch {
    return null;
  }
}
