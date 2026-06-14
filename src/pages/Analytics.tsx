import { useEffect, useMemo, useState } from 'react';
import { useAppUser } from '../hooks/useAppUser';
import { getSupabase, isSupabaseConfigured } from '../services/supabaseClient';
import {
  computeOverview,
  computeScoreDistribution,
  computeSourceStats,
  computeTopIssueTypes,
  emptyAnalytics,
  type ValidationRecord,
} from '../services/analytics';

// Sprint 7 Part 2 — LLM source analytics dashboard (Pro+). Free tier sees the
// structure, blurred, with an upgrade overlay.
export function AnalyticsPage() {
  const { appUser } = useAppUser();
  const isPro = !!appUser && appUser.plan !== 'free';
  const [records, setRecords] = useState<ValidationRecord[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isPro || !appUser?.id || !isSupabaseConfigured) return;
    const supabase = getSupabase();
    if (!supabase) return;
    setLoading(true);
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    void supabase
      .from('validations')
      .select('risk_score, error_count, warning_count, report, created_at')
      .eq('user_id', appUser.id)
      .gte('created_at', since)
      .then(({ data }) => {
        setRecords((data as ValidationRecord[]) ?? []);
        setLoading(false);
      });
  }, [isPro, appUser?.id]);

  const data = useMemo(() => {
    if (!isPro) return emptyAnalytics();
    return {
      overview: computeOverview(records),
      sources: computeSourceStats(records),
      topIssues: computeTopIssueTypes(records),
      distribution: computeScoreDistribution(records),
    };
  }, [isPro, records]);

  return (
    <Shell>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>SQL Quality Analytics</h1>
        <span style={{ color: '#71717a', fontSize: 12 }}>Last 30 days</span>
      </div>

      {isPro && !loading && records.length === 0 && (
        <div style={{ marginTop: 16, border: '1px solid #27272a', borderRadius: 8, padding: 24, background: '#18181b', textAlign: 'center' }}>
          <div style={{ fontSize: 26 }}>📈</div>
          <h2 style={{ fontSize: 16, margin: '8px 0 4px' }}>No validations yet</h2>
          <p style={{ color: '#a1a1aa', fontSize: 13, margin: '0 auto', maxWidth: 420 }}>
            Validate some SQL in the editor and your quality trends — pass rate by source, the most
            common issues, and score distribution — will start showing up here.
          </p>
          <a href="#/editor" style={ctaBtn}>Open the editor →</a>
        </div>
      )}

      <div style={{ position: 'relative', marginTop: 16 }}>
        <div style={isPro ? undefined : blurred}>
          {/* Overview cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
            <Stat label="Total validations" value={data.overview.total} accent="#a78bfa" />
            <Stat label="Errors caught" value={data.overview.errorsCaught} accent="#ef4444" />
            <Stat label="Warnings caught" value={data.overview.warningsCaught} accent="#eab308" />
            <Stat label="Clean queries" value={data.overview.cleanQueries} accent="#22c55e" />
          </div>

          {/* Source breakdown */}
          <SectionTitle>Pass rate by source</SectionTitle>
          <table style={tableStyle}>
            <thead>
              <tr>
                {['Source', 'Validations', 'Errors', 'Warnings', 'Pass rate'].map((h) => (
                  <th key={h} style={thStyle}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.sources.length === 0 ? (
                <tr><td colSpan={5} style={tdMuted}>No validations yet.</td></tr>
              ) : (
                data.sources.map((s) => (
                  <tr key={s.source}>
                    <td style={tdStyle}>{s.label}</td>
                    <td style={tdStyle}>{s.validations}</td>
                    <td style={tdStyle}>{s.errors}</td>
                    <td style={tdStyle}>{s.warnings}</td>
                    <td style={{ ...tdStyle, color: s.passRate >= 70 ? '#22c55e' : s.passRate >= 50 ? '#eab308' : '#ef4444' }}>
                      {s.passRate}%
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>

          {/* Top issue types */}
          <SectionTitle>Most common issues</SectionTitle>
          {data.topIssues.length === 0 ? (
            <p style={tdMuted}>No issues recorded.</p>
          ) : (
            <ul style={{ paddingLeft: 18, color: '#d4d4d8', fontSize: 13, lineHeight: 1.8 }}>
              {data.topIssues.map((i) => (
                <li key={i.issueType}>
                  <code style={{ color: '#a78bfa' }}>{i.issueType}</code> — {i.count} occurrence(s) ({i.pct}% of validations)
                </li>
              ))}
            </ul>
          )}

          {/* Score distribution */}
          <SectionTitle>Score distribution</SectionTitle>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
            <Stat label="0–40 RISKY" value={data.distribution.RISKY} accent="#ef4444" />
            <Stat label="41–69 REVIEW" value={data.distribution.REVIEW} accent="#f59e0b" />
            <Stat label="70–84 CAUTION" value={data.distribution.CAUTION} accent="#eab308" />
            <Stat label="85–100 SAFE" value={data.distribution.SAFE} accent="#22c55e" />
          </div>
        </div>

        {!isPro && (
          <div style={overlay}>
            <div style={{ textAlign: 'center', maxWidth: 360 }}>
              <div style={{ fontSize: 28 }}>📊</div>
              <h2 style={{ fontSize: 18, margin: '8px 0' }}>Upgrade to Pro to see your SQL quality analytics</h2>
              <p style={{ color: '#a1a1aa', fontSize: 13 }}>
                Track pass rates by source (Cursor / Copilot / ChatGPT / hand-written), top error
                types, and score distribution.
              </p>
              <a href="#/pricing" style={ctaBtn}>Upgrade to Pro →</a>
            </div>
          </div>
        )}
      </div>
      {loading && <p style={{ color: '#71717a', fontSize: 12, marginTop: 12 }}>Loading…</p>}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ background: '#09090b', color: '#e4e4e7', minHeight: '100vh', padding: 32 }}>
      <div style={{ display: 'flex', gap: 16, fontSize: 13 }}>
        <a href="#/editor" style={{ color: '#a78bfa', textDecoration: 'none' }}>← Editor</a>
        <a href="#/pricing" style={{ color: '#71717a', textDecoration: 'none' }}>Pricing</a>
      </div>
      <div style={{ maxWidth: 900, margin: '20px auto 0' }}>{children}</div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div style={{ border: '1px solid #27272a', borderRadius: 8, padding: '12px 14px', background: '#18181b' }}>
      <div style={{ fontSize: 24, fontWeight: 700, color: accent, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      <div style={{ fontSize: 11, color: '#71717a', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 style={{ fontSize: 14, color: '#a1a1aa', margin: '22px 0 8px' }}>{children}</h2>;
}

const blurred: React.CSSProperties = { filter: 'blur(5px)', pointerEvents: 'none', userSelect: 'none' };
const overlay: React.CSSProperties = {
  position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'rgba(9,9,11,0.55)', borderRadius: 8,
};
const ctaBtn: React.CSSProperties = {
  display: 'inline-block', marginTop: 12, background: '#7c3aed', color: 'white',
  padding: '8px 16px', borderRadius: 6, textDecoration: 'none', fontWeight: 600, fontSize: 13,
};
const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 4 };
const thStyle: React.CSSProperties = {
  textAlign: 'left', padding: '8px 10px', color: '#a1a1aa', borderBottom: '1px solid #27272a', fontWeight: 600,
};
const tdStyle: React.CSSProperties = { padding: '8px 10px', borderBottom: '1px solid #18181b', color: '#d4d4d8' };
const tdMuted: React.CSSProperties = { padding: '12px 10px', color: '#52525b' };
