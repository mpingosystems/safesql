import { describe, expect, it } from 'vitest';
import { handleValidate, corsHeaders, type ValidateDeps } from '../../functions/api/validate';

const okAuth: ValidateDeps = {
  authenticate: async () => ({ ok: true, userId: 'u1', plan: 'pro' }),
  checkUsage: async () => ({ ok: true }),
};

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://safesqlpro.dev/api/validate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ssk_live_x', ...headers },
    body: JSON.stringify(body),
  });
}

describe('POST /api/validate', () => {
  it('valid request returns a ValidationReport (200) with detectorVersion', async () => {
    const res = await handleValidate(req({ sql: 'DELETE FROM users' }), okAuth);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(typeof json.riskScore).toBe('number');
    expect(Array.isArray(json.errors)).toBe(true);
    expect(json.errors.map((e: { id: string }) => e.id)).toContain('MISSING_WHERE_DESTRUCTIVE');
    expect(json.detectorVersion).toBeTruthy();
  });

  // ── Sprint 5C — the plan on the API key decides the detector set ───────────
  it('pro key runs all 35 detectors and reports the tier', async () => {
    const res = await handleValidate(req({ sql: 'SELECT 1' }), okAuth);
    const json = await res.json();
    expect(json.tier).toBe('pro');
    expect(json.detectorsRun).toHaveLength(35);
  });

  it('free key runs only the 12 core detectors', async () => {
    const deps: ValidateDeps = {
      authenticate: async () => ({ ok: true, userId: 'u1', plan: 'free' }),
      checkUsage: async () => ({ ok: true }),
    };
    const res = await handleValidate(req({ sql: 'SELECT 1' }), deps);
    const json = await res.json();
    expect(json.tier).toBe('free');
    expect(json.detectorsRun).toHaveLength(12);
  });

  it('an unrecognised plan falls back to free rather than unlocking everything', async () => {
    const deps: ValidateDeps = {
      authenticate: async () => ({ ok: true, userId: 'u1', plan: 'legacy_grandfathered' }),
      checkUsage: async () => ({ ok: true }),
    };
    const res = await handleValidate(req({ sql: 'SELECT 1' }), deps);
    const json = await res.json();
    expect(json.tier).toBe('free');
    expect(json.detectorsRun).toHaveLength(12);
  });

  it('missing sql field → 400', async () => {
    const res = await handleValidate(req({ dialect: 'postgresql' }), okAuth);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/sql field is required/);
  });

  it('invalid / missing API key → 401', async () => {
    const deps: ValidateDeps = { authenticate: async () => ({ ok: false }), checkUsage: async () => ({ ok: true }) };
    const res = await handleValidate(req({ sql: 'SELECT 1' }), deps);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/Invalid API key/);
  });

  it('rate limit exceeded → 429', async () => {
    const deps: ValidateDeps = {
      authenticate: async () => ({ ok: true, userId: 'u1', plan: 'free' }),
      checkUsage: async () => ({ ok: false }),
    };
    const res = await handleValidate(req({ sql: 'SELECT 1' }), deps);
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/Rate limit exceeded/);
  });

  it('CORS headers present on the response', async () => {
    const res = await handleValidate(req({ sql: 'SELECT 1' }), okAuth);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(corsHeaders['Access-Control-Allow-Methods']).toMatch(/POST/);
  });

  it('ddl field is parsed and passed to the schema validator', async () => {
    const res = await handleValidate(
      req({ sql: 'SELECT id, lifetime_value FROM users', ddl: 'CREATE TABLE users (id UUID PRIMARY KEY, email TEXT)' }),
      okAuth,
    );
    const json = await res.json();
    expect(json.errors.map((e: { id: string }) => e.id)).toContain('HALLUCINATED_COLUMN');
  });
});
