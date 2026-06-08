import { describe, expect, it, vi } from 'vitest';
import {
  buildShortUrl,
  createSharedValidation,
  daysUntilExpiry,
  fetchSharedValidation,
  rowToReport,
  shareIdFromPath,
  type SharedValidationRow,
} from '../services/sharedValidation';
import type { ValidationReport } from '../types/validation';

const report: ValidationReport = {
  riskScore: 25,
  executionSafe: false,
  errors: [{ id: 'HALLUCINATED_COLUMN', severity: 'error', title: 't', description: 'd', fix: 'f' }],
  warnings: [],
  suggestions: [],
  processingMs: 1,
  source: 'cursor',
};

// Minimal fake Supabase client (only the calls the service makes).
function fakeClient(opts: {
  onInsert?: (table: string, row: Record<string, unknown>) => void;
  insertError?: { message: string } | null;
  row?: SharedValidationRow | null;
  selectError?: { message: string } | null;
}) {
  return {
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        opts.onInsert?.('shared_validations', row);
        return Promise.resolve({ error: opts.insertError ?? null });
      },
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({ data: opts.row ?? null, error: opts.selectError ?? null }),
        }),
      }),
    }),
  } as never;
}

describe('shareIdFromPath', () => {
  it('extracts the id from /v/{id}', () => {
    expect(shareIdFromPath('/v/V1StGXR8Z5jd')).toBe('V1StGXR8Z5jd');
    expect(shareIdFromPath('/v/abc123/')).toBe('abc123');
  });
  it('returns null for non-share paths', () => {
    expect(shareIdFromPath('/editor')).toBeNull();
    expect(shareIdFromPath('/')).toBeNull();
    expect(shareIdFromPath('/v/')).toBeNull();
  });
});

describe('buildShortUrl', () => {
  it('produces a short /v/{id} URL (not a 300-char payload)', () => {
    const url = buildShortUrl('V1StGXR8Z5jd');
    expect(url).toMatch(/\/v\/V1StGXR8Z5jd$/);
    expect(url.length).toBeLessThan(60);
  });
});

describe('createSharedValidation', () => {
  it('generates a 12-char nanoid id and the correct URL, inserting the right shape', async () => {
    let inserted: Record<string, unknown> | null = null;
    const res = await createSharedValidation(
      { sql: 'SELECT id, lifetime_value FROM users', report, dialect: 'postgresql' },
      fakeClient({ onInsert: (_t, row) => (inserted = row) }),
    );
    expect(res).not.toBeNull();
    expect(res!.id).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(res!.url).toMatch(/\/v\/[A-Za-z0-9_-]{12}$/);
    expect(inserted!).toMatchObject({
      id: res!.id,
      sql: 'SELECT id, lifetime_value FROM users',
      score: 25,
      dialect: 'postgresql',
      source: 'cursor',
    });
    // issues = flattened errors+warnings+suggestions
    expect((inserted!.issues as unknown[]).length).toBe(1);
  });

  it('returns null when the client is missing or insert fails', async () => {
    expect(await createSharedValidation({ sql: 'SELECT 1', report }, null)).toBeNull();
    const res = await createSharedValidation(
      { sql: 'SELECT 1', report },
      fakeClient({ insertError: { message: 'relation does not exist' } }),
    );
    expect(res).toBeNull();
  });
});

describe('fetchSharedValidation', () => {
  const baseRow: SharedValidationRow = {
    id: 'abc123def456',
    sql: 'SELECT 1',
    issues: [{ id: 'SELECT_STAR_EXPENSIVE', severity: 'suggestion', title: 't', description: 'd' }],
    score: 95,
    dialect: 'postgresql',
    ddl: null,
    source: 'manual',
    created_at: '2026-06-08T00:00:00Z',
    expires_at: '2099-01-01T00:00:00Z',
  };

  it('returns the stored row when found and not expired', async () => {
    const row = await fetchSharedValidation('abc123def456', fakeClient({ row: baseRow }));
    expect(row?.id).toBe('abc123def456');
    expect(row?.score).toBe(95);
  });

  it('returns null for an expired row', async () => {
    const expired = { ...baseRow, expires_at: '2000-01-01T00:00:00Z' };
    expect(await fetchSharedValidation('abc123def456', fakeClient({ row: expired }))).toBeNull();
  });

  it('returns null when not found', async () => {
    expect(await fetchSharedValidation('missing', fakeClient({ row: null }))).toBeNull();
    expect(await fetchSharedValidation('x', null)).toBeNull();
  });
});

describe('rowToReport + daysUntilExpiry', () => {
  it('reconstructs a report from stored issues', () => {
    const r = rowToReport({
      id: 'x',
      sql: 'SELECT 1',
      issues: [
        { id: 'CARTESIAN_JOIN', severity: 'error', title: 't', description: 'd' },
        { id: 'SELECT_STAR_EXPENSIVE', severity: 'suggestion', title: 't', description: 'd' },
      ],
      score: 25,
      dialect: 'postgresql',
      ddl: null,
      source: null,
      created_at: '2026-06-08T00:00:00Z',
      expires_at: '2099-01-01T00:00:00Z',
    });
    expect(r.riskScore).toBe(25);
    expect(r.errors.length).toBe(1);
    expect(r.suggestions.length).toBe(1);
    expect(r.executionSafe).toBe(false);
  });

  it('computes whole days to expiry', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-08T00:00:00Z'));
    expect(daysUntilExpiry('2026-06-18T00:00:00Z')).toBe(10);
    expect(daysUntilExpiry('2026-06-08T00:00:00Z')).toBe(0);
    vi.useRealTimers();
  });
});
