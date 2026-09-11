import { useCallback, useEffect, useState } from 'react';
import { useAppUser } from '../hooks/useAppUser';
import { listApprovals, resolveApproval, type ApprovalInboxRow as ApprovalRow } from '../services/approvalsApi';
import { ValidationReport } from '../components/ValidationReport';

// Sprint 8 Part 3 / Sprint 10 depth — manager approval inbox at /team/approvals.
// Pending + History tabs, expandable full report, and a confirm dialog before
// approving/rejecting.
//
// Sprint 9 (compliance): reads and resolves through /api/teams/approvals. The
// server decides who may resolve each request (policy roles + separation of
// duties) and returns it per row as `can_resolve_this`; the Approve / Reject
// buttons render only when it is true. Every decision lands on the team's
// tamper-evident chain with the approver's identity and role.
export function ApprovalInboxPage() {
  const { appUser } = useAppUser();
  const isTeam = !!appUser && ['team', 'business', 'enterprise'].includes(appUser.plan);

  const [tab, setTab] = useState<'pending' | 'history'>('pending');
  const [pending, setPending] = useState<ApprovalRow[]>([]);
  const [history, setHistory] = useState<ApprovalRow[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [confirm, setConfirm] = useState<{ id: string; approve: boolean } | null>(null);
  const [myRole, setMyRole] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isTeam) return;
    const [p, h] = await Promise.all([listApprovals('pending'), listApprovals('all', {}, { limit: 100 })]);
    if ('error' in p) { setError(p.error); return; }
    setError(null);
    setMyRole(p.my_role);
    setPending(p.rows);
    setHistory('error' in h ? [] : h.rows.filter((r) => r.status !== 'pending'));
  }, [isTeam]);

  useEffect(() => {
    // Fetch on mount / when eligibility changes. Scheduled as a microtask so
    // the state updates happen in a callback, not synchronously in the effect.
    void Promise.resolve().then(refresh);
  }, [refresh]);

  const doConfirm = async () => {
    if (!confirm) return;
    const note = notes[confirm.id];
    const res = await resolveApproval(confirm.id, confirm.approve ? 'approved' : 'rejected', note);
    setConfirm(null);
    if (!res.ok) {
      setError(res.error);
    } else {
      setNotes((n) => ({ ...n, [confirm.id]: '' }));
    }
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
        ) : (
          <>
            <div style={{ display: 'flex', gap: 8, margin: '12px 0 16px', alignItems: 'center' }}>
              <Tab active={tab === 'pending'} onClick={() => setTab('pending')}>Pending ({pending.length})</Tab>
              <Tab active={tab === 'history'} onClick={() => setTab('history')}>History ({history.length})</Tab>
              {myRole && <span style={{ color: '#71717a', fontSize: 12, marginLeft: 'auto' }}>You are {myRole}{myRole === 'auditor' ? ' (read-only)' : ''}</span>}
            </div>
            {error && <p style={{ color: '#f87171', fontSize: 13 }}>{error}</p>}

            {tab === 'pending' ? (
              pending.length === 0 ? (
                <p style={{ color: '#71717a' }}>No pending approval requests.</p>
              ) : (
                pending.map((r) => (
                  <div key={r.id} style={cardStyle}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                      <div>
                        <ScoreBadge score={r.risk_score} />
                        <span style={{ color: '#a1a1aa', fontSize: 12, marginLeft: 10 }}>from {r.requester_email ?? r.requester_clerk_user_id ?? 'unknown'}</span>
                      </div>
                      <span style={{ color: '#71717a', fontSize: 12 }}>{fmt(r.created_at)}</span>
                    </div>
                    <div style={{ fontSize: 12, color: '#a1a1aa', marginTop: 6 }}>
                      Top issue: <code style={{ color: '#a78bfa' }}>{topIssue(r)}</code>
                      {r.trigger_reasons.length > 0 && (
                        <> · Requires approval: <code style={{ color: '#fbbf24' }}>{r.trigger_reasons.join(', ')}</code></>
                      )}
                    </div>
                    <pre style={preStyle}>{r.sql}</pre>
                    {r.requester_note && <div style={{ fontSize: 12, color: '#a1a1aa', fontStyle: 'italic' }}>Note: {r.requester_note}</div>}

                    <button type="button" onClick={() => setExpanded((e) => ({ ...e, [r.id]: !e[r.id] }))} style={linkBtn}>
                      {expanded[r.id] ? 'Hide full report' : 'View full report'}
                    </button>
                    {expanded[r.id] && r.validation_report && (
                      <div style={{ border: '1px solid #27272a', borderRadius: 8, overflow: 'hidden', marginTop: 8 }}>
                        <ValidationReport report={r.validation_report} />
                      </div>
                    )}

                    {r.can_resolve_this ? (
                      <>
                        <textarea
                          placeholder="Optional note to include with your decision…"
                          value={notes[r.id] ?? ''}
                          onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))}
                          style={noteStyle}
                        />
                        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                          <button type="button" onClick={() => setConfirm({ id: r.id, approve: true })} style={approveBtn}>Approve</button>
                          <button type="button" onClick={() => setConfirm({ id: r.id, approve: false })} style={rejectBtn}>Reject</button>
                        </div>
                      </>
                    ) : (
                      <div style={{ fontSize: 12, color: '#71717a', marginTop: 8 }}>
                        {r.requester_clerk_user_id === appUser?.clerkUserId
                          ? 'Your own request — an ' + r.approver_roles.join(' or ') + ' must resolve it (separation of duties).'
                          : 'Awaiting an ' + r.approver_roles.join(' or ') + '.'}
                      </div>
                    )}
                  </div>
                ))
              )
            ) : history.length === 0 ? (
              <p style={{ color: '#71717a' }}>No resolved requests yet.</p>
            ) : (
              history.map((r) => (
                <div key={r.id} style={cardStyle}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <div>
                      <StatusBadge status={r.status} />
                      <span style={{ color: '#a1a1aa', fontSize: 12, marginLeft: 10 }}>from {r.requester_email ?? r.requester_clerk_user_id ?? 'unknown'}</span>
                    </div>
                    <span style={{ color: '#71717a', fontSize: 12 }}>{fmt(r.resolved_at)}</span>
                  </div>
                  <pre style={preStyle}>{r.sql}</pre>
                  <div style={{ fontSize: 12, color: '#71717a' }}>
                    {r.status === 'approved' ? 'Approved' : 'Rejected'} by {r.approver_email ?? r.approver_clerk_user_id ?? 'unknown'}
                    {r.approver_role ? ` (${r.approver_role})` : ''}
                    {r.resolution_event_seq ? ` · chain #${r.resolution_event_seq}` : ''}
                  </div>
                  {r.approver_note && <div style={{ fontSize: 12, color: '#a1a1aa', fontStyle: 'italic', marginTop: 4 }}>Note: {r.approver_note}</div>}
                </div>
              ))
            )}
          </>
        )}
      </div>

      {confirm && (
        <div style={overlay} onClick={() => setConfirm(null)}>
          <div style={dialog} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
              {confirm.approve ? 'Approve this query?' : 'Reject this query?'}
            </div>
            <p style={{ color: '#a1a1aa', fontSize: 13, marginTop: 0 }}>
              {confirm.approve
                ? 'The requester will be cleared to run this query.'
                : 'The requester will be told this query was not approved.'}
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => setConfirm(null)} style={cancelBtn}>Cancel</button>
              <button type="button" onClick={() => void doConfirm()} style={confirm.approve ? approveBtn : rejectSolid}>
                {confirm.approve ? 'Approve' : 'Reject'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function topIssue(r: ApprovalRow): string {
  const rep = r.validation_report;
  return rep?.errors?.[0]?.id ?? rep?.warnings?.[0]?.id ?? '—';
}
function fmt(ts: string | null): string {
  return ts ? ts.slice(0, 16).replace('T', ' ') : '—';
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} style={{ background: active ? '#7c3aed' : 'transparent', color: active ? 'white' : '#a1a1aa', border: '1px solid ' + (active ? '#7c3aed' : '#3f3f46'), borderRadius: 6, padding: '6px 14px', fontSize: 13, cursor: 'pointer' }}>{children}</button>
  );
}
function ScoreBadge({ score }: { score: number }) {
  const color = score < 50 ? '#ef4444' : score < 70 ? '#eab308' : '#22c55e';
  return <span style={{ color, fontWeight: 700 }}>Score {score}</span>;
}
function StatusBadge({ status }: { status: string }) {
  const ok = status === 'approved';
  const color = ok ? '#22c55e' : '#ef4444';
  return <span style={{ display: 'inline-block', padding: '1px 8px', borderRadius: 999, border: `1px solid ${color}`, color, fontSize: 11, fontWeight: 600 }}>{ok ? 'Approved' : 'Rejected'}</span>;
}

const cardStyle: React.CSSProperties = { border: '1px solid #27272a', borderRadius: 8, padding: 14, marginBottom: 10, background: '#18181b' };
const preStyle: React.CSSProperties = { background: '#0a0a0a', border: '1px solid #27272a', borderRadius: 6, padding: 10, fontSize: 12, color: '#d4d4d8', overflow: 'auto', margin: '8px 0' };
const noteStyle: React.CSSProperties = { width: '100%', background: '#0a0a0a', color: '#e4e4e7', border: '1px solid #27272a', borderRadius: 6, padding: 8, fontSize: 12.5, marginTop: 8 };
const linkBtn: React.CSSProperties = { background: 'transparent', border: 'none', color: '#a78bfa', cursor: 'pointer', fontSize: 12.5, padding: '4px 0' };
const approveBtn: React.CSSProperties = { background: '#16a34a', color: 'white', border: 'none', borderRadius: 5, padding: '6px 14px', fontWeight: 600, fontSize: 12.5, cursor: 'pointer' };
const rejectBtn: React.CSSProperties = { background: 'transparent', color: '#ef4444', border: '1px solid #3f3f46', borderRadius: 5, padding: '6px 14px', fontSize: 12.5, cursor: 'pointer' };
const rejectSolid: React.CSSProperties = { background: '#dc2626', color: 'white', border: 'none', borderRadius: 5, padding: '6px 14px', fontWeight: 600, fontSize: 12.5, cursor: 'pointer' };
const cancelBtn: React.CSSProperties = { background: 'transparent', color: '#a1a1aa', border: '1px solid #3f3f46', borderRadius: 5, padding: '6px 14px', fontSize: 12.5, cursor: 'pointer' };
const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 };
const dialog: React.CSSProperties = { background: '#18181b', border: '1px solid #3f3f46', borderRadius: 10, padding: 18, width: 380, maxWidth: '90vw' };
