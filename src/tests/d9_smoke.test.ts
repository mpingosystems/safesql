import { describe, expect, it } from 'vitest';
import { validateSQL } from '../services/sqlValidator';
import { parseDDL } from '../services/schemaParser';

describe('D9 smoke — user-reported case', () => {
  it('flags both bare columns: SELECT user_id, revenue FROM users', () => {
    const schema = parseDDL(
      'CREATE TABLE users (id UUID PRIMARY KEY, email TEXT NOT NULL, status TEXT, created_at TIMESTAMPTZ);',
    );
    const r = validateSQL({
      sql: 'SELECT user_id, revenue FROM users',
      schema,
      dialect: 'postgresql',
    });
    const halluc = r.errors.filter((e) => e.id === 'HALLUCINATED_COLUMN');
    const cols = halluc.map((e) => e.metadata?.column).sort();

    // eslint-disable-next-line no-console
    console.log('D9 smoke result:', {
      riskScore: r.riskScore,
      errorIds: r.errors.map((e) => e.id),
      hallucinatedColumns: cols,
      titles: halluc.map((e) => e.title),
    });

    expect(cols).toEqual(['revenue', 'user_id']);
    expect(r.riskScore).toBeLessThan(50);
  });
});
