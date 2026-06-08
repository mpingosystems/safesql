import { describe, expect, it } from 'vitest';
import {
  approveRequest,
  createApprovalRequest,
  getPendingRequests,
  needsApproval,
  rejectRequest,
  type ApprovalRow,
} from '../services/approvals';
import type { ValidationReport } from '../types/validation';

const report: ValidationReport = {
  riskScore: 54,
  executionSafe: true,
  errors: [],
  warnings: [{ id: 'LEFT_JOIN_FILTERED_IN_WHERE', severity: 'warning', title: 't', description: 'd' }] as never,
  suggestions: [],
  processingMs: 1,
};

// Fake Supabase client capturing insert/update payloads.
function fakeClient(opts: {
  onInsert?: (row: Record<string, unknown>) => void;
  onUpdate?: (payload: Record<string, unknown>, id: string) => void;
  pending?: ApprovalRow[];
}) {
  return {
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        opts.onInsert?.(row);
        return { select: () => ({ single: () => Promise.resolve({ data: { id: 'req_1' }, error: null }) }) };
      },
      update: (payload: Record<string, unknown>) => ({
        eq: (_col: string, id: string) => {
          opts.onUpdate?.(payload, id);
          return Promise.resolve({ error: null });
        },
      }),
      select: () => ({
        eq: () => ({
          eq: () => ({
            order: () => Promise.resolve({ data: opts.pending ?? [], error: null }),
          }),
        }),
      }),
    }),
  } as never;
}

describe('needsApproval', () => {
  it('score below threshold needs approval', () => {
    expect(needsApproval(54, 70)).toBe(true);
  });
  it('score at/above threshold does not (75 vs 70)', () => {
    expect(needsApproval(75, 70)).toBe(false);
  });
});

describe('createApprovalRequest', () => {
  it('stores the request with status pending + report', async () => {
    let inserted: Record<string, unknown> | null = null;
    const res = await createApprovalRequest(
      { teamId: 'team1', requesterId: 'u1', sql: 'SELECT 1', report, note: 'please review' },
      fakeClient({ onInsert: (r) => (inserted = r) }),
    );
    expect(res?.id).toBe('req_1');
    expect(inserted!).toMatchObject({ team_id: 'team1', requester_id: 'u1', status: 'pending', risk_score: 54, requester_note: 'please review' });
  });
});

describe('approve / reject', () => {
  it('approveRequest sets status=approved + resolved_at', async () => {
    let payload: Record<string, unknown> | null = null;
    const ok = await approveRequest('req_1', 'ok', fakeClient({ onUpdate: (p) => (payload = p) }));
    expect(ok).toBe(true);
    expect(payload!).toMatchObject({ status: 'approved', approver_note: 'ok' });
    expect(payload!.resolved_at).toBeTruthy();
  });
  it('rejectRequest sets status=rejected', async () => {
    let payload: Record<string, unknown> | null = null;
    await rejectRequest('req_1', 'no', fakeClient({ onUpdate: (p) => (payload = p) }));
    expect(payload!).toMatchObject({ status: 'rejected' });
  });
});

describe('getPendingRequests', () => {
  it('returns the pending list for a team', async () => {
    const rows = [{ id: 'a', status: 'pending' } as ApprovalRow];
    const got = await getPendingRequests('team1', fakeClient({ pending: rows }));
    expect(got.length).toBe(1);
    expect(got[0].id).toBe('a');
  });
});
