import { describe, expect, it, vi } from 'vitest';
import { enrichWithAIExplanations, buildExplainBody } from '../services/aiExplainer';
import { validateSQL } from '../services/sqlValidator';
import { parseDDL } from '../services/schemaParser';

// 9.6-SEC Step 3: the browser calls /api/explain with the Clerk session token
// and never calls an AI provider directly.
const schema = parseDDL('CREATE TABLE users (id INT PRIMARY KEY, email TEXT);');
const sql = 'SELECT id FROM ghost';
const report = () => validateSQL({ sql, schema, dialect: 'postgresql' });

const token = async () => 'session-token';

function okFetch(explanations: unknown) {
  return vi.fn(async () => new Response(JSON.stringify({ explanations }), { status: 200 })) as unknown as typeof fetch;
}

describe('enrichWithAIExplanations (client)', () => {
  it('posts to /api/explain with the session token, never to an AI provider', async () => {
    const r = report();
    const id = r.errors[0].id;
    const f = okFetch([{ id, explanation: 'Because.', fix: 'Use users.' }]);
    const out = await enrichWithAIExplanations(r, sql, schema, token, f);
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toMatch(/\/api\/explain$/);
    expect(String(url)).not.toMatch(/anthropic|openai/);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer session-token');
    expect(out.status).toBe('ok');
    expect(out.report.errors[0].explanation).toBe('Because.');
    expect(out.report.errors[0].fix).toBe('Use users.');
  });

  it('does not mutate the deterministic report it was given', async () => {
    const r = report();
    const id = r.errors[0].id;
    await enrichWithAIExplanations(r, sql, schema, token, okFetch([{ id, explanation: 'Because.', fix: 'x' }]));
    expect(r.errors[0].explanation).toBeUndefined();
  });

  it('signed out: unavailable, unchanged, and no request is made', async () => {
    const f = okFetch([]);
    const r = report();
    const out = await enrichWithAIExplanations(r, sql, schema, async () => null, f);
    expect(out).toEqual({ report: r, status: 'unavailable' });
    expect(f).not.toHaveBeenCalled();
  });

  it.each([401, 403, 503])('HTTP %i degrades to the deterministic report', async (status) => {
    const r = report();
    const f = vi.fn(async () => new Response('{}', { status })) as unknown as typeof fetch;
    const out = await enrichWithAIExplanations(r, sql, schema, token, f);
    expect(out).toEqual({ report: r, status: 'unavailable' });
  });

  it('network failure degrades gracefully', async () => {
    const r = report();
    const f = vi.fn(async () => { throw new TypeError('offline'); }) as unknown as typeof fetch;
    expect((await enrichWithAIExplanations(r, sql, schema, token, f)).status).toBe('unavailable');
  });

  it('a clean report needs no request', async () => {
    const clean = validateSQL({ sql: 'SELECT id FROM users', schema, dialect: 'postgresql' });
    const f = okFetch([]);
    if (clean.errors.length + clean.warnings.length === 0) {
      expect((await enrichWithAIExplanations(clean, 'SELECT id FROM users', schema, token, f)).status).toBe('ok');
      expect(f).not.toHaveBeenCalled();
    }
  });

  it('request body carries issues and a column-name-only schema summary', () => {
    const body = buildExplainBody(report(), sql, schema);
    expect(body.sql).toBe(sql);
    expect(body.issues.length).toBeGreaterThan(0);
    expect(body.schema).toEqual([{ name: 'users', columns: ['id', 'email'] }]);
  });
});
