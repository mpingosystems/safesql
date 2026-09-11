import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useAppUser } from '../hooks/useAppUser';
import { SiteNav } from '../components/SiteNav';
import {
  TeamHealthScore,
  TeamHealthScoreSkeleton,
  type HealthSummary,
} from '../components/team/TeamHealthScore';
import {
  IssueBreakdown,
  IssueBreakdownSkeleton,
  type IssueRow,
} from '../components/team/IssueBreakdown';
import { HealthTrendChartSkeleton, type DailyScore } from '../components/team/healthChartTypes';
import { EvidenceBundles } from '../components/team/EvidenceBundles';
import {
  AuditTrailFilters,
  AuditTrailTable,
  DEFAULT_FILTERS,
  ExportButton,
  ValidationDetailModal,
  useDetailModal,
  type AuditFilters,
  type AuditRow,
} from '../components/team/AuditTrail';

// recharts (~100 KB) is the single heaviest dependency in the app. Loading the
// chart lazily keeps it in its own chunk: only a signed-in team member viewing
// this page pays for it, and the landing and editor bundles are untouched.
const HealthTrendChart = lazy(() =>
  import('../components/team/HealthTrendChart').then((m) => ({ default: m.HealthTrendChart })),
);

interface Health extends HealthSummary {
  daily_scores: DailyScore[];
  top_issues: IssueRow[];
  member_scores: { clerk_user_id: string; name: string; avg_score: number | null; count: number; qualifies: boolean }[];
}

// Sprint 6B — #/team. One fetch of /api/teams/dashboard paints the whole page.
//
// NOTE: there is no SQL preview on a validation row. Only a SHA-256 hash of the
// query is stored — /compliance states that publicly — so the row shows the
// dialect, the finding counts and the most severe issue instead.

interface Member {
  clerk_user_id: string;
  role: 'owner' | 'manager' | 'member' | 'auditor';
  email: string;
  display_name: string | null;
  joined_at: string | null;
}

interface PendingInvite {
  id: string;
  email: string;
  role: string;
  created_at: string | null;
  expires_at: string | null;
}

interface RecentRow {
  id: string | null;
  clerk_user_id: string | null;
  member: string;
  risk_score: number | null;
  error_count: number;
  warning_count: number;
  topIssue: string | null;
  dialect: string | null;
  created_at: string | null;
}

interface Dashboard {
  team: { id: string; name: string; slug: string; plan: string };
  role: 'owner' | 'manager' | 'member' | 'auditor';
  seats: { members: number; pendingInvites: number; used: number; limit: number | null; full: boolean };
  members: Member[];
  pendingInvites: PendingInvite[];
  recent: RecentRow[];
  topIssues: { issueType: string; count: number; pct: number }[];
  validationsAnalysed: number;
}

// ── presentation helpers ────────────────────────────────────────────────────

const card: React.CSSProperties = {
  background: '#18181b',
  border: '1px solid #27272a',
  borderRadius: 10,
  padding: 18,
};

function initials(nameOrEmail: string): string {
  const s = (nameOrEmail || '?').trim();
  const parts = s.split(/[\s.@_-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

function Avatar({ label }: { label: string }) {
  return (
    <div
      aria-hidden
      style={{
        width: 30,
        height: 30,
        borderRadius: 999,
        background: '#1e1b31',
        border: '1px solid #3f3f46',
        color: '#a78bfa',
        fontSize: 11.5,
        fontWeight: 700,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      {initials(label)}
    </div>
  );
}

function Badge({ text, tone }: { text: string; tone: 'violet' | 'grey' | 'amber' | 'green' | 'red' }) {
  const tones: Record<string, { bg: string; fg: string }> = {
    violet: { bg: '#1e1b31', fg: '#a78bfa' },
    grey: { bg: '#1f1f23', fg: '#a1a1aa' },
    amber: { bg: '#2a2113', fg: '#fbbf24' },
    green: { bg: '#0f2417', fg: '#4ade80' },
    red: { bg: '#2a1215', fg: '#f87171' },
  };
  const t = tones[tone];
  return (
    <span
      style={{
        background: t.bg,
        color: t.fg,
        fontSize: 10.5,
        fontWeight: 700,
        padding: '2px 7px',
        borderRadius: 4,
        whiteSpace: 'nowrap',
      }}
    >
      {text}
    </span>
  );
}

/** Score bands follow the shipped score policy: 0-40 / 41-69 / 70-84 / 85-100. */
function scoreTone(score: number | null): 'red' | 'amber' | 'grey' | 'green' {
  if (score === null) return 'grey';
  if (score < 41) return 'red';
  if (score < 70) return 'amber';
  if (score < 85) return 'grey';
  return 'green';
}

function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function shortDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : '—';
}

function Section({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 26 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <h2 style={{ fontSize: 16, margin: '0 0 10px' }}>{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}


// ── page ────────────────────────────────────────────────────────────────────

export function TeamPage() {
  const { appUser } = useAppUser();
  const { getToken, isLoaded } = useAuth();

  const [data, setData] = useState<Dashboard | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);

  const [auditFilters, setAuditFilters] = useState<AuditFilters>(DEFAULT_FILTERS);
  const [audit, setAudit] = useState<{
    rows: AuditRow[];
    total: number;
    truncated: boolean;
    can_export: boolean;
    export_requires_upgrade: boolean;
    members: { clerk_user_id: string; name: string }[];
    issue_types: string[];
  } | null>(null);
  const [auditLoading, setAuditLoading] = useState(true);
  const detail = useDetailModal();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState('');
  // Sprint 9 (compliance): invite as member / manager / auditor (read-only seat).
  const [inviteRole, setInviteRole] = useState<'member' | 'manager' | 'auditor'>('member');
  const [changingRole, setChangingRole] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const isPaid = !!appUser && appUser.plan !== 'free';

  const authedFetch = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const jwt = await getToken();
      if (!jwt) throw new Error('Not signed in');
      return fetch(path, {
        ...init,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${jwt}`,
          ...(init.headers ?? {}),
        },
      });
    },
    [getToken],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authedFetch('/api/teams/dashboard');
      const json = (await res.json()) as Dashboard & { error?: string };
      if (!res.ok) {
        setError(json.error ?? 'Could not load your team.');
        setData(null);
      } else {
        setData(json);
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setLoading(false);
    }
  }, [authedFetch]);

  // Fetched separately so a slow health query never delays the members list.
  const loadHealth = useCallback(async () => {
    setHealthLoading(true);
    try {
      const res = await authedFetch('/api/teams/health?days=30');
      if (res.ok) setHealth((await res.json()) as Health);
    } catch {
      // Health is supplementary; the rest of the page still renders.
    } finally {
      setHealthLoading(false);
    }
  }, [authedFetch]);

  const loadAudit = useCallback(
    async (f: AuditFilters) => {
      setAuditLoading(true);
      try {
        const qs = new URLSearchParams({ days: String(f.days), limit: '100' });
        if (f.member) qs.set('member', f.member);
        if (f.verdict) qs.set('verdict', f.verdict);
        if (f.issue) qs.set('issue', f.issue);
        const res = await authedFetch(`/api/teams/audit?${qs.toString()}`);
        if (res.ok) setAudit(await res.json());
      } catch {
        // Audit is supplementary; the rest of the page still renders.
      } finally {
        setAuditLoading(false);
      }
    },
    [authedFetch],
  );

  useEffect(() => {
    if (!isLoaded) return;
    if (!isPaid) {
      setLoading(false);
      return;
    }
    void load();
    void loadHealth();
    void loadAudit(auditFilters);
    // auditFilters is intentionally omitted: filter changes refetch through
    // onChange below, not by re-running this mount effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded, isPaid, load, loadHealth, loadAudit]);

  // Sprint 9 (compliance): role changes go through PATCH /api/teams/member/role
  // so they are authorised server-side and recorded on the chain.
  const changeRole = async (clerkUserId: string, newRole: string) => {
    setChangingRole(clerkUserId);
    setNotice(null);
    try {
      const res = await authedFetch('/api/teams/member/role', {
        method: 'PATCH',
        body: JSON.stringify({ clerk_user_id: clerkUserId, role: newRole }),
      });
      const json = (await res.json()) as { error?: string; plan_changed?: string | null };
      if (!res.ok) setNotice(json.error ?? 'Could not change role.');
      else if (json.plan_changed === 'revoked') setNotice('Role changed to auditor — read-only access, paid plan released.');
      else if (json.plan_changed === 'granted') setNotice('Role changed — the team plan now applies to this seat.');
      await load();
    } finally {
      setChangingRole(null);
    }
  };

  const invite = async () => {
    const email = inviteEmail.trim().toLowerCase();
    if (!email) return;
    setInviting(true);
    setNotice(null);
    try {
      const res = await authedFetch('/api/teams/invite', {
        method: 'POST',
        body: JSON.stringify({ email, role: inviteRole }),
      });
      const json = (await res.json()) as { error?: string; emailed?: boolean; alreadyPending?: boolean };
      if (!res.ok) {
        setNotice(json.error ?? 'Could not send the invitation.');
      } else if (json.alreadyPending) {
        setNotice(`${email} already has a pending invitation.`);
      } else {
        // Say plainly when the invitation exists but no mail went out, rather
        // than implying an email was delivered.
        setNotice(
          json.emailed
            ? `Invitation sent to ${email}.`
            : `Invitation created for ${email}, but the email could not be sent. Share the link from your invitations list.`,
        );
        setInviteEmail('');
      }
      await load();
    } catch {
      setNotice('Could not reach the server.');
    } finally {
      setInviting(false);
    }
  };

  const remove = async (clerkUserId: string, label: string) => {
    if (!window.confirm(`Remove ${label} from the team? They will return to the Free plan.`)) return;
    setRemoving(clerkUserId);
    setNotice(null);
    try {
      const res = await authedFetch('/api/teams/member', {
        method: 'DELETE',
        body: JSON.stringify({ clerk_user_id: clerkUserId }),
      });
      const json = (await res.json()) as { error?: string };
      setNotice(res.ok ? `${label} removed.` : (json.error ?? 'Could not remove that member.'));
      await load();
    } catch {
      setNotice('Could not reach the server.');
    } finally {
      setRemoving(null);
    }
  };

  // ── gates ────────────────────────────────────────────────────────────────

  if (isLoaded && !isPaid) {
    return (
      <Shell>
        <div style={{ ...card, textAlign: 'center', padding: 32 }}>
          <div style={{ fontSize: 30, marginBottom: 10 }}>👥</div>
          <h1 style={{ fontSize: 20, margin: '0 0 8px' }}>
            Team features require a Pro subscription.
          </h1>
          <p style={{ color: '#a1a1aa', fontSize: 13.5, lineHeight: 1.65, margin: '0 0 18px' }}>
            Share validation history, invite up to 5 teammates, and see the issues your team hits most.
          </p>
          <a
            href="#/pricing"
            style={{
              background: '#7c3aed',
              color: 'white',
              textDecoration: 'none',
              padding: '10px 18px',
              borderRadius: 5,
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            See pricing →
          </a>
        </div>
      </Shell>
    );
  }

  if (loading) {
    return (
      <Shell>
        <div style={{ ...card, color: '#71717a', fontSize: 13 }}>Loading your team…</div>
      </Shell>
    );
  }

  if (error || !data) {
    return (
      <Shell>
        <div style={{ ...card }}>
          <h1 style={{ fontSize: 18, margin: '0 0 8px' }}>No team yet</h1>
          <p style={{ color: '#a1a1aa', fontSize: 13.5, lineHeight: 1.65, margin: '0 0 14px' }}>
            {error ?? 'You do not belong to a team.'}
          </p>
          <a href="#/team/setup" style={{ color: '#a78bfa', fontSize: 13.5, fontWeight: 600 }}>
            Create a team →
          </a>
        </div>
      </Shell>
    );
  }

  const { team, role, seats, members, pendingInvites, recent } = data;
  const isOwner = role === 'owner';
  const canInvite = (role === 'owner' || role === 'manager') && !seats.full;
  const limitLabel = seats.limit ?? '∞';

  return (
    <Shell>
      {/* 1. HEADER */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 26, margin: 0 }}>{team.name}</h1>
        {isOwner && (
          <a href="#/team/members" title="Team settings" style={{ color: '#71717a', fontSize: 16 }}>
            ⚙
          </a>
        )}
      </div>
      <p style={{ color: '#a1a1aa', fontSize: 13, margin: '6px 0 0' }}>
        Team · <strong style={{ color: '#e4e4e7' }}>{seats.used}</strong> of {limitLabel} seats used
        {seats.pendingInvites > 0 && (
          <span style={{ color: '#71717a' }}>
            {' '}
            ({seats.members} member{seats.members === 1 ? '' : 's'}, {seats.pendingInvites} pending)
          </span>
        )}
      </p>

      {notice && (
        <div
          role="status"
          style={{
            ...card,
            marginTop: 14,
            padding: '10px 14px',
            fontSize: 13,
            color: '#d4d4d8',
            borderLeft: '3px solid #7c3aed',
          }}
        >
          {notice}
        </div>
      )}

      {/* 2. HEALTH SCORE + TREND — side by side on desktop, stacked on mobile.
             minmax(260px, …) makes the columns collapse without a media query. */}
      <Section title="Team Health">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
            gap: 12,
            alignItems: 'start',
          }}
        >
          {healthLoading ? <TeamHealthScoreSkeleton /> : health ? <TeamHealthScore data={health} /> : null}
          {healthLoading ? (
            <HealthTrendChartSkeleton />
          ) : health ? (
            <Suspense fallback={<HealthTrendChartSkeleton />}>
              <HealthTrendChart data={health.daily_scores} />
            </Suspense>
          ) : null}
        </div>
      </Section>

      {/* 4. ISSUE BREAKDOWN */}
      <Section title="Most Common Issues This Month">
        {healthLoading ? (
          <IssueBreakdownSkeleton />
        ) : health ? (
          <IssueBreakdown issues={health.top_issues} />
        ) : null}
      </Section>

      {/* 4. MEMBERS */}
      <Section title="Team Members">
        <div style={card}>
          {members.map((m) => {
            const label = m.display_name || m.email;
            const self = m.clerk_user_id === appUser?.clerkUserId;
            return (
              <Row key={m.clerk_user_id}>
                <Avatar label={label} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13.5, color: '#e4e4e7', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {label} {self && <span style={{ color: '#52525b', fontSize: 11.5 }}>(you)</span>}
                  </div>
                  <div style={{ fontSize: 11.5, color: '#71717a' }}>Joined {shortDate(m.joined_at)}</div>
                </div>
                <Badge text={m.role === 'owner' ? 'Owner' : m.role === 'manager' ? 'Manager' : m.role === 'auditor' ? 'Auditor' : 'Member'} tone={m.role === 'owner' ? 'violet' : m.role === 'auditor' ? 'amber' : 'grey'} />
                <Badge text="Active" tone="green" />
                {(isOwner || role === 'manager') && !self && m.role !== 'owner' && !(role === 'manager' && m.role === 'manager') && (
                  <select
                    aria-label={`Change role for ${label}`}
                    value={m.role}
                    disabled={changingRole === m.clerk_user_id}
                    onChange={(e) => void changeRole(m.clerk_user_id, e.target.value)}
                    style={roleSelect}
                  >
                    <option value="member">Member</option>
                    {isOwner && <option value="manager">Manager</option>}
                    <option value="auditor">Auditor (read-only)</option>
                  </select>
                )}
                {isOwner && !self && m.role !== 'owner' && (
                  <button
                    type="button"
                    onClick={() => void remove(m.clerk_user_id, label)}
                    disabled={removing === m.clerk_user_id}
                    style={removeBtn}
                  >
                    {removing === m.clerk_user_id ? '…' : 'Remove'}
                  </button>
                )}
              </Row>
            );
          })}

          {pendingInvites.map((i) => (
            <Row key={i.id}>
              <Avatar label={i.email} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13.5, color: '#a1a1aa', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {i.email}
                </div>
                <div style={{ fontSize: 11.5, color: '#71717a' }}>Invited {shortDate(i.created_at)}</div>
              </div>
              <Badge text={i.role === 'manager' ? 'Manager' : i.role === 'auditor' ? 'Auditor' : 'Member'} tone={i.role === 'auditor' ? 'amber' : 'grey'} />
              <Badge text="Pending" tone="amber" />
            </Row>
          ))}
        </div>

        {/* Invite form — owner/manager only, hidden at the cap */}
        {(role === 'owner' || role === 'manager') && (
          <div style={{ ...card, marginTop: 10 }}>
            {seats.full ? (
              <div style={{ fontSize: 13, color: '#fbbf24' }}>
                Team is full ({seats.used}/{limitLabel} seats). Remove a member or let an invitation
                expire to free a seat.
              </div>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void invite();
                }}
                style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
              >
                <input
                  type="email"
                  required
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="teammate@company.com"
                  aria-label="Email address to invite"
                  style={{
                    flex: '1 1 220px',
                    background: '#0f0f11',
                    border: '1px solid #27272a',
                    borderRadius: 6,
                    color: '#e4e4e7',
                    padding: '9px 11px',
                    fontSize: 13.5,
                  }}
                />
                <select
                  aria-label="Role for the invitee"
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as 'member' | 'manager' | 'auditor')}
                  style={roleSelect}
                >
                  <option value="member">Member</option>
                  {isOwner && <option value="manager">Manager</option>}
                  <option value="auditor">Auditor (read-only)</option>
                </select>
                <button type="submit" disabled={inviting || !canInvite} style={primaryBtn}>
                  {inviting ? 'Sending…' : 'Send Invite'}
                </button>
              </form>
            )}
          </div>
        )}
      </Section>

      {/* 3. RECENT VALIDATIONS */}
      <Section
        title="Recent Validations"
        right={
          <span style={{ fontSize: 12, color: '#71717a' }}>
            {data.validationsAnalysed} in the last 200
          </span>
        }
      >
        {recent.length === 0 ? (
          <div style={{ ...card, textAlign: 'center', padding: '28px 18px' }}>
            <p style={{ color: '#a1a1aa', fontSize: 13.5, lineHeight: 1.65, margin: '0 0 16px' }}>
              No validations yet. Start validating SQL with your team to see results here.
            </p>
            <a href="#/editor" style={{ ...primaryBtn, textDecoration: 'none', display: 'inline-block' }}>
              Open Editor →
            </a>
          </div>
        ) : (
          <div style={card}>
            {recent.map((r, i) => (
              <Row key={r.id ?? i}>
                <Avatar label={r.member} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13, color: '#e4e4e7', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {r.topIssue ? (
                      <code style={{ fontSize: 12 }}>{r.topIssue}</code>
                    ) : (
                      <span style={{ color: '#4ade80' }}>No findings</span>
                    )}
                  </div>
                  <div style={{ fontSize: 11.5, color: '#71717a' }}>
                    {r.member} · {r.dialect ?? 'postgresql'} · {r.error_count} error
                    {r.error_count === 1 ? '' : 's'}, {r.warning_count} warning
                    {r.warning_count === 1 ? '' : 's'}
                  </div>
                </div>
                <Badge text={r.risk_score === null ? '—' : `${r.risk_score}`} tone={scoreTone(r.risk_score)} />
                <span style={{ fontSize: 11.5, color: '#71717a', whiteSpace: 'nowrap', minWidth: 62, textAlign: 'right' }}>
                  {timeAgo(r.created_at)}
                </span>
              </Row>
            ))}
          </div>
        )}
      </Section>

      {/* 5. AUDIT TRAIL */}
      <Section
        title="Audit Trail"
        right={
          audit ? (
            <ExportButton
              rows={audit.rows}
              teamSlug={team.slug}
              disabled={auditLoading}
              locked={audit.export_requires_upgrade}
            />
          ) : null
        }
      >
        <AuditTrailFilters
          filters={auditFilters}
          members={audit?.members ?? []}
          issueTypes={audit?.issue_types ?? []}
          disabled={auditLoading}
          onChange={(next) => {
            setAuditFilters(next);
            void loadAudit(next);
          }}
        />
        <AuditTrailTable rows={audit?.rows ?? []} loading={auditLoading} onView={detail.open} />
        {audit && audit.total > audit.rows.length && (
          <p style={{ fontSize: 12, color: '#71717a', marginTop: 8 }}>
            Showing {audit.rows.length} of {audit.total} matching validations
            {audit.truncated && ' (scan limit reached — counts are a lower bound)'}.
          </p>
        )}
      </Section>

      {/* 6. EVIDENCE BUNDLES — Sprint 9 (compliance). Business+; locked state otherwise. */}
      <Section title="Evidence Bundles">
        <EvidenceBundles teamPlan={team.plan} />
      </Section>

      <ValidationDetailModal row={detail.row} onClose={detail.close} />
    </Shell>
  );
}

// ── layout primitives ───────────────────────────────────────────────────────

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ background: '#09090b', color: '#e4e4e7', minHeight: '100vh' }}>
      <SiteNav current="landing" />
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '28px 24px 56px' }}>{children}</div>
    </div>
  );
}

/** Flex row that wraps rather than overflowing on a narrow viewport. */
function Row({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
        padding: '9px 0',
        borderBottom: '1px solid #1f1f23',
      }}
    >
      {children}
    </div>
  );
}

const primaryBtn: React.CSSProperties = {
  background: '#7c3aed',
  color: 'white',
  border: 'none',
  borderRadius: 6,
  padding: '9px 16px',
  fontSize: 13.5,
  fontWeight: 600,
  cursor: 'pointer',
};

const roleSelect: React.CSSProperties = {
  background: '#0f0f11',
  border: '1px solid #27272a',
  borderRadius: 6,
  color: '#e4e4e7',
  padding: '7px 9px',
  fontSize: 12.5,
};

const removeBtn: React.CSSProperties = {
  background: 'transparent',
  color: '#a1a1aa',
  border: '1px solid #27272a',
  borderRadius: 5,
  padding: '4px 10px',
  fontSize: 11.5,
  fontWeight: 600,
  cursor: 'pointer',
};
