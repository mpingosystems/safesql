import { useCallback, useEffect, useState } from 'react';
import { useAppUser } from '../hooks/useAppUser';
import { useTeam } from '../hooks/useTeam';
import { getSupabase, isSupabaseConfigured } from '../services/supabaseClient';
import { approveRequest, getPendingRequests, rejectRequest, type ApprovalRow } from '../services/approvals';

// Sprint 8 Part 3 — manager approval inbox at /team/approvals (Team+).
// Sprint 9 — queries pending requests by the real team id (teams.id), falling
// back to the user's own id namespace when they have no team yet.
export function ApprovalInboxPage() {
  const { appUser } = useAppUser();
  const { team } = useTeam();
  const isTeam = !!appUser && ['team', 'business', 'enterprise'].includes(appUser.plan);
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [note, setNote] = useState('');

  const teamId = team?.id ?? appUser?.id ?? '';

  const refresh = useCallback(async () => {
    if (!isTeam || !isSupabaseConfigured || !teamId) return;
    const supabase = getSupabase();
    if (!supabase) return;
    setRows(await getPendingRequests(teamId, supabase));
  }, [isTeam, teamId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = async (id: string, approve: boolean) => {
    const supabase = getSupabase();
    if (!supabase) return;
    if (approve) await approveRequest(id, note, supabase);
    else await rejectRequest(id, note, supabase);
    setNote('');
    await refresh();
  };

  return (
    <div style={{ background: '#09090b', color: '#e4e4e7', minHeight: '100vh', padding: 32 }}>
      <a href="#/editor" style={{ color: '#a78bfa', textDecoration: 'none', fontSize: 13 }}>← Editor</a>
      <div style={{ maxWidth: 820, margin: '20px auto 0' }}>
        <h1 style={{ fontSize: 22 }}>Approval Inbox</h1>
        {!isTeam ? (
          <p style={{ color: '#a1a1aa' }}>
            Approval workflow is a Team feature. <a href="#/pricing" style={{ color: '#a78bfa' }}>Upgrade →</a>
          </p>
        ) : rows.length === 0 ? (
          <p style={{ color: '#71717a' }}>No pending approval requests.</p>
        ) : (
          <>
            <textarea
              placeholder="Optional note to include with your decision…"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              style={{ width: '100%', background: '#0a0a0a', color: '#e4e4e7', border: '1px solid #27272a', borderRadius: 6, padding: 8, fontSize: 12.5, marginBottom: 12 }}
            />
            {rows.map((r) => (
              <div key={r.id} style={{ border: '1px solid #27272a', borderRadius: 8, padding: 14, marginBottom: 10, background: '#18181b' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: r.risk_score < 50 ? '#ef4444' : '#eab308', fontWeight: 700 }}>Score {r.risk_score}</span>
                  <span style={{ color: '#71717a', fontSize: 12 }}>{r.created_at?.slice(0, 16).replace('T', ' ')}</span>
                </div>
                <pre style={{ background: '#0a0a0a', border: '1px solid #27272a', borderRadius: 6, padding: 10, fontSize: 12, color: '#d4d4d8', overflow: 'auto', margin: '8px 0' }}>{r.sql}</pre>
                {r.requester_note && <div style={{ fontSize: 12, color: '#a1a1aa', fontStyle: 'italic' }}>Note: {r.requester_note}</div>}
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button type="button" onClick={() => void act(r.id, true)} style={{ background: '#16a34a', color: 'white', border: 'none', borderRadius: 5, padding: '6px 14px', fontWeight: 600, fontSize: 12.5, cursor: 'pointer' }}>Approve</button>
                  <button type="button" onClick={() => void act(r.id, false)} style={{ background: 'transparent', color: '#ef4444', border: '1px solid #3f3f46', borderRadius: 5, padding: '6px 14px', fontSize: 12.5, cursor: 'pointer' }}>Reject</button>
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
