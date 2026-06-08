import { describe, expect, it } from 'vitest';
import { auditLogToCsv, writeAuditEvent, type AuditRow } from '../services/auditLog';

function fakeClient(onInsert: (row: Record<string, unknown>) => void) {
  return {
    from: () => ({ insert: (row: Record<string, unknown>) => { onInsert(row); return Promise.resolve({ error: null }); } }),
  } as never;
}

describe('writeAuditEvent', () => {
  it('stores the correct event_type and data', async () => {
    let inserted: Record<string, unknown> | null = null;
    await writeAuditEvent(
      'validation_run',
      { risk_score: 25, issue_types: ['HALLUCINATED_COLUMN'] },
      { user_id: 'u1', team_id: 't1', ip: '1.2.3.4' },
      fakeClient((r) => (inserted = r)),
    );
    expect(inserted!).toMatchObject({ user_id: 'u1', team_id: 't1', event_type: 'validation_run', ip_address: '1.2.3.4' });
    expect((inserted!.event_data as { risk_score: number }).risk_score).toBe(25);
  });

  it('is a no-op without a client or user_id', async () => {
    await expect(writeAuditEvent('validation_run', {}, { user_id: 'u1' }, null)).resolves.toBeUndefined();
    let called = false;
    await writeAuditEvent('validation_run', {}, { user_id: '' }, fakeClient(() => (called = true)));
    expect(called).toBe(false);
  });
});

describe('auditLogToCsv', () => {
  const rows: AuditRow[] = [
    { created_at: '2026-06-08T11:42:00Z', user_email: 'alice@co.com', event_type: 'validation_run', event_data: { risk_score: 25, issue_types: ['HALLUCINATED_COLUMN'], sql_hash: 'abc' } },
    { created_at: '2026-06-08T11:38:00Z', user_email: 'bob@co.com', event_type: 'query_executed_despite_warnings', event_data: { risk_score: 54, issue_types: ['LEFT_JOIN_FILTERED_IN_WHERE'], sql_hash: 'def' } },
  ];

  it('produces the correct header and rows', () => {
    const csv = auditLogToCsv(rows);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('timestamp,user_email,event_type,risk_score,issue_types,sql_hash');
    expect(lines[1]).toBe('2026-06-08T11:42:00Z,alice@co.com,validation_run,25,HALLUCINATED_COLUMN,abc');
    expect(lines.length).toBe(3);
  });

  it('escapes cells containing commas/quotes', () => {
    const csv = auditLogToCsv([{ created_at: 't', event_type: 'plan_changed', event_data: { issue_types: ['A', 'B'], sql_hash: 'a,b' } }]);
    expect(csv).toMatch(/"a,b"/);
    expect(csv).toMatch(/A\|B/);
  });
});
