import { useEffect, useMemo, useState } from 'react';
import { useAppUser } from '../hooks/useAppUser';
import { useTeam } from '../hooks/useTeam';
import { getSupabase, isSupabaseConfigured } from '../services/supabaseClient';
import {
  computeMemberLeaderboard,
  computeRiskyQueryLog,
  computeTeamOverview,
  computeTeamTopIssues,
  emptyTeamAnalytics,
  type TeamValidationRecord,
} from '../services/analytics';

// Sprint 8 Part 2 — team analytics (Team+).
// Sprint 9 — wired to the real team_members table: maps each member's
// clerk_user_id to their app users.id, then aggregates every member's
// validations into a genuine multi-user leaderboard. Falls back to the current
// user's own validations when they have no team yet.
export function TeamAnalyticsPage() {
  const { appUser } = useAppUser();
  const { team, members } = useTeam();
  const isTeam = !!appUser && ['team', 'business', 'enterprise'].includes(appUser.plan);
  const [records, setRecords] = useState<TeamValidationRecord[]>([]);

  useEffect(() => {
    if (!isTeam || !appUser?.id || !isSupabaseConfigured) return;
    const supabase = getSupabase();
    if (!supabase) return;
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();

    void (async () => {
      // No team yet → single-member view of the current user.
      if (!team || members.length === 0) {
        const { data } = await supabase
          .from('validations')
          .select('risk_score, error_count, warning_count, report, created_at')
          .eq('user_id', appUser.id)
          .gte('created_at', since);
        const member = appUser.email || 'you';
        setRecords(((data as Omit<TeamValidationRecord, 'member'>[]) ?? []).map((r) => ({ ...r, member })));
        return;
      }

      // Map team members (clerk_user_id) → app users.id + display email.
      const clerkIds = members.map((m) => m.clerk_user_id);
      const { data: userRows } = await supabase
        .from('users')
        .select('id, email, clerk_user_id')
        .in('clerk_user_id', clerkIds);
      const idToEmail = new Map<string, string>();
      const userIds: string[] = [];
      for (const u of (userRows as { id: string; email: string; clerk_user_id: string }[]) ?? []) {
        userIds.push(u.id);
        const member = members.find((m) => m.clerk_user_id === u.clerk_user_id);
        idToEmail.set(u.id, member?.email || u.email);
      }
      if (userIds.length === 0) {
        setRecords([]);
        return;
      }

      const { data } = await supabase
        .from('validations')
        .select('user_id, risk_score, error_count, warning_count, report, created_at')
        .in('user_id', userIds)
        .gte('created_at', since);
      setRecords(
        ((data as (Omit<TeamValidationRecord, 'member'> & { user_id: string })[]) ?? []).map((r) => ({
          ...r,
          member: idToEmail.get(r.user_id) || 'unknown',
        })),
      );
    })();
  }, [isTeam, appUser?.id, appUser?.email, team?.id, members]);

  const data = useMemo(() => {
    if (!isTeam) return emptyTeamAnalytics();
    return {
      overview: computeTeamOverview(records),
      leaderboard: computeMemberLeaderboard(records),
      topIssues: computeTeamTopIssues(records),
      risky: computeRiskyQueryLog(records),
      upgradeRequired: false as const,
    };
  }, [isTeam, records]);

  return (
    <Shell>
      <h1 style={{ fontSize: 22 }}>Team Analytics</h1>
      <div style={{ position: 'relative', marginTop: 14 }}>
        <div style={isTeam ? undefined : blurred}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
            <Stat label="Team validations" value={String(data.overview.total)} />
            <Stat label="Team avg score" value={String(data.overview.avgScore)} />
            <Stat label="Most common error" value={data.overview.mostCommonError ?? '—'} small />
            <Stat label="Coaching focus" value={data.overview.lowestPassRateMember ?? '—'} small />
          </div>

          <H2>Member leaderboard</H2>
          <table style={t}>
            <thead><tr>{['Member', 'Validations', 'Pass rate', 'Avg score'].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {data.leaderboard.length === 0 ? <tr><td colSpan={4} style={muted}>No data.</td></tr> :
                data.leaderboard.map((m) => (
                  <tr key={m.member}>
                    <td style={td}>{m.member}</td><td style={td}>{m.validations}</td>
                    <td style={{ ...td, color: m.passRate >= 70 ? '#22c55e' : m.passRate >= 50 ? '#eab308' : '#ef4444' }}>{m.passRate}%</td>
                    <td style={td}>{m.avgScore}</td>
                  </tr>
                ))}
            </tbody>
          </table>

          <H2>Most common issues</H2>
          <ul style={{ paddingLeft: 18, color: '#d4d4d8', fontSize: 13, lineHeight: 1.8 }}>
            {data.topIssues.length === 0 ? <li style={{ color: '#52525b' }}>No issues.</li> :
              data.topIssues.slice(0, 8).map((i) => <li key={i.issueType}><code style={{ color: '#a78bfa' }}>{i.issueType}</code> — {i.count} ({i.pct}%)</li>)}
          </ul>

          <H2>Recent risky queries (score &lt; 70)</H2>
          <table style={t}>
            <thead><tr>{['Author', 'Score', 'Top issue', 'Time'].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {data.risky.length === 0 ? <tr><td colSpan={4} style={muted}>None.</td></tr> :
                data.risky.map((q, i) => (
                  <tr key={i}><td style={td}>{q.member}</td><td style={{ ...td, color: '#ef4444' }}>{q.score}</td><td style={td}><code>{q.topIssue}</code></td><td style={td}>{q.createdAt?.slice(0, 10)}</td></tr>
                ))}
            </tbody>
          </table>
        </div>

        {!isTeam && (
          <div style={overlay}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 28 }}>👥</div>
              <h2 style={{ fontSize: 18 }}>Upgrade to Team for team analytics</h2>
              <a href="#/pricing" style={cta}>See Team plan →</a>
            </div>
          </div>
        )}
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ background: '#09090b', color: '#e4e4e7', minHeight: '100vh', padding: 32 }}>
      <div style={{ display: 'flex', gap: 16, fontSize: 13 }}>
        <a href="#/editor" style={{ color: '#a78bfa', textDecoration: 'none' }}>← Editor</a>
        <a href="#/team/approvals" style={{ color: '#71717a', textDecoration: 'none' }}>Approvals</a>
      </div>
      <div style={{ maxWidth: 920, margin: '20px auto 0' }}>{children}</div>
    </div>
  );
}
function Stat({ label, value, small }: { label: string; value: string; small?: boolean }) {
  return <div style={{ border: '1px solid #27272a', borderRadius: 8, padding: '12px 14px', background: '#18181b' }}>
    <div style={{ fontSize: small ? 14 : 24, fontWeight: 700, color: '#a78bfa' }}>{value}</div>
    <div style={{ fontSize: 11, color: '#71717a', textTransform: 'uppercase' }}>{label}</div>
  </div>;
}
function H2({ children }: { children: React.ReactNode }) { return <h2 style={{ fontSize: 14, color: '#a1a1aa', margin: '20px 0 8px' }}>{children}</h2>; }
const blurred: React.CSSProperties = { filter: 'blur(5px)', pointerEvents: 'none' };
const overlay: React.CSSProperties = { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(9,9,11,0.55)' };
const cta: React.CSSProperties = { display: 'inline-block', marginTop: 10, background: '#7c3aed', color: 'white', padding: '8px 16px', borderRadius: 6, textDecoration: 'none', fontWeight: 600, fontSize: 13 };
const t: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 13 };
const th: React.CSSProperties = { textAlign: 'left', padding: '8px 10px', color: '#a1a1aa', borderBottom: '1px solid #27272a' };
const td: React.CSSProperties = { padding: '8px 10px', borderBottom: '1px solid #18181b', color: '#d4d4d8' };
const muted: React.CSSProperties = { padding: 12, color: '#52525b' };
