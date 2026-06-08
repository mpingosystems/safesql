import { nanoid } from 'nanoid';

// Sprint 7 Part 3 — API key helpers shared by the REST API Function (server) and
// the Settings UI (client). Only the SHA-256 hash is ever stored; the raw key is
// shown to the user exactly once at generation time.

export const API_KEY_PREFIX = 'ssk_live_';

export function generateApiKey(): string {
  return API_KEY_PREFIX + nanoid(32);
}

// First 12 chars (e.g. `ssk_live_AbC`) for display in the keys list.
export function apiKeyDisplayPrefix(key: string): string {
  return key.slice(0, 12);
}

// SHA-256 hex. Web Crypto is available in the browser, Cloudflare Workers, and
// Node 18+ (vitest), so the same function works everywhere.
export async function hashApiKey(key: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export const PLAN_API_LIMITS: Record<string, number> = {
  free: 50,
  pro: 1_000,
  team: 10_000,
  business: 100_000,
};
