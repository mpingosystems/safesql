import { useEffect, useState } from 'react';
import { useAppUser } from '../hooks/useAppUser';
import { getSupabase, isSupabaseConfigured } from '../services/supabaseClient';
import { auditLogToCsv, type AuditRow } from '../services/auditLog';

// Sprint 8 Part 4 — audit log viewer at /team/audit (Business tier).
export function AuditLogPage() {
  const { appUser } = useAppUser();
  const isBusiness = !!appUser && ['business', 'enterprise'].includes(appUser.plan);
  const [rows, setRows] = useState<AuditRow[]>([]);

  useEffect(() => {
    if (!isBusiness || !appUser?.id || !isSupabaseConfigured) return;
    const supabase = getSupabase();
    if (!supabase) return;
    void supabase
      .from('audit_log')
      .select('created_at, event_type, event_data')
      .eq('user_id', appUser.id)
      .order('created_at', { ascending: false })
      .limit(200)
      .then(({ data }) => setRows((data as AuditRow[]) ?? []));
  }, [isBusiness, appUser?.id]);

  const exportCsv = () => {
    const blob = new Blob([auditLogToCsv(rows)], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'safesql-audit-log.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ background: '#09090b', color: '#e4e4e7', minHeight: '100vh', padding: 32 }}>
      <a href="#/editor" style={{ color: '#a78bfa', textDecoration: 'none', fontSize: 13 }}>← Editor</a>
      <div style={{ maxWidth: 900, margin: '20px auto 0' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h1 style={{ fontSize: 22 }}>Audit Log</h1>
          {isBusiness && <button type="button" onClick={exportCsv} style={{ background: '#7c3aed', color: 'white', border: 'none', borderRadius: 6, padding: '7px 14px', fontWeight: 600, fontSize: 12.5, cursor: 'pointer' }}>Export CSV</button>}
        </div>
        {!isBusiness ? (
          <p style={{ color: '#a1a1aa' }}>The audit log is a Business feature. <a href="#/pricing" style={{ color: '#a78bfa' }}>Upgrade →</a></p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, marginTop: 12 }}>
            <thead><tr>{['Time', 'Event', 'Score', 'Issues'].map((h) => <th key={h} style={{ textAlign: 'left', padding: '8px 10px', color: '#a1a1aa', borderBottom: '1px solid #27272a' }}>{h}</th>)}</tr></thead>
            <tbody>
              {rows.length === 0 ? <tr><td colSpan={4} style={{ padding: 12, color: '#52525b' }}>No audit events.</td></tr> :
                rows.map((r, i) => (
                  <tr key={i}>
                    <td style={tdc}>{r.created_at?.slice(0, 16).replace('T', ' ')}</td>
                    <td style={tdc}><code>{r.event_type}</code></td>
                    <td style={tdc}>{r.event_data?.risk_score ?? '—'}</td>
                    <td style={tdc}>{(r.event_data?.issue_types ?? []).join(', ') || '—'}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
const tdc: React.CSSProperties = { padding: '7px 10px', borderBottom: '1px solid #18181b', color: '#d4d4d8' };
