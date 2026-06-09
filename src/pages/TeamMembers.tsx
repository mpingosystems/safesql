import { useState } from 'react';
import { useAppUser } from '../hooks/useAppUser';
import { useTeam } from '../hooks/useTeam';
import { getSupabase } from '../services/supabaseClient';
import { inviteMember, removeMember, updateMemberRole, type TeamRole } from '../services/teams';
import { SITE_URL } from '../config/constants';

// Sprint 9 Part 1 — team member management at /team/members. Managers invite by
// email (token-based; the accept link is {SITE_URL}/team/join?token=…), change
// roles (owner only), and remove members.
export function TeamMembersPage() {
  const { appUser } = useAppUser();
  const { team, members, role, isManager, refresh } = useTeam();

  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<TeamRole>('member');
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [inviteMsg, setInviteMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [pendingRemove, setPendingRemove] = useState<{ id: string; email: string } | null>(null);
  const [busy, setBusy] = useState(false);

  if (!team) {
    return (
      <Shell>
        <h1 style={{ fontSize: 22 }}>Team Members</h1>
        <p style={{ color: '#a1a1aa' }}>You're not on a team yet. <a href="#/team/setup" style={{ color: '#a78bfa' }}>Create or join a team →</a></p>
      </Shell>
    );
  }

  const invite = async () => {
    if (!appUser || !email.trim() || busy) return;
    const target = email.trim().toLowerCase();
    // Guard: already a member.
    if (members.some((m) => m.email.toLowerCase() === target)) {
      setInviteMsg({ text: 'User is already a member of this team.', ok: false });
      return;
    }
    setBusy(true);
    setInviteLink(null);
    setInviteMsg(null);
    try {
      const token = await inviteMember(team.id, email, inviteRole, appUser.id, getSupabase());
      if (token) {
        setInviteLink(`${SITE_URL}/team/join?token=${token}`);
        setInviteMsg({ text: `Invitation sent to ${target}. Share the link below to let them join.`, ok: true });
        setEmail('');
        // Email delivery (Resend) is best-effort and wired separately; the link
        // above is sufficient to join in the meantime.
      } else {
        setInviteMsg({ text: 'Could not create the invitation. Is the teams migration applied?', ok: false });
      }
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (clerkUserId: string, newRole: TeamRole) => {
    await updateMemberRole(team.id, clerkUserId, newRole, getSupabase());
    await refresh();
  };

  const confirmRemove = async () => {
    if (!pendingRemove) return;
    await removeMember(team.id, pendingRemove.id, getSupabase());
    setPendingRemove(null);
    await refresh();
  };

  return (
    <Shell>
      <h1 style={{ fontSize: 22 }}>{team.name}</h1>
      <p style={{ color: '#71717a', fontSize: 12 }}>Plan: {team.plan} · {members.length} member{members.length === 1 ? '' : 's'}</p>

      <table style={t}>
        <thead><tr>{['Member', 'Role', ''].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.id}>
              <td style={td}>{m.email}{m.clerk_user_id === appUser?.id && <span style={{ color: '#52525b' }}> (you)</span>}</td>
              <td style={td}>
                {role === 'owner' && m.clerk_user_id !== appUser?.id ? (
                  <select value={m.role} onChange={(e) => void changeRole(m.clerk_user_id, e.target.value as TeamRole)} style={sel}>
                    <option value="member">member</option>
                    <option value="manager">manager</option>
                    <option value="owner">owner</option>
                  </select>
                ) : (
                  <RoleBadge role={m.role} />
                )}
              </td>
              <td style={td}>
                {isManager && m.clerk_user_id !== appUser?.id && m.role !== 'owner' && (
                  <button type="button" onClick={() => setPendingRemove({ id: m.clerk_user_id, email: m.email })} style={rm}>Remove</button>
                )}
              </td>
            </tr>
          ))}
          {members.length <= 1 && (
            <tr>
              <td colSpan={3} style={{ ...td, color: '#52525b' }}>
                No other members yet.{isManager && ' Invite your team using the form below →'}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {pendingRemove && (
        <div style={overlay} onClick={() => setPendingRemove(null)}>
          <div style={dialog} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Remove member?</div>
            <p style={{ color: '#a1a1aa', fontSize: 13, marginTop: 0 }}>
              Remove <strong>{pendingRemove.email}</strong> from {team.name}? They'll lose access to team data.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => setPendingRemove(null)} style={sel}>Cancel</button>
              <button type="button" onClick={() => void confirmRemove()} style={rmSolid}>Remove</button>
            </div>
          </div>
        </div>
      )}

      {isManager && (
        <div style={card}>
          <h2 style={{ fontSize: 14, color: '#a1a1aa', marginTop: 0 }}>Invite a member</h2>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@acme.com" style={{ ...inp, flex: 1, minWidth: 200 }} />
            <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as TeamRole)} style={sel}>
              <option value="member">member</option>
              <option value="manager">manager</option>
            </select>
            <button type="button" onClick={() => void invite()} disabled={busy || !email.trim()} style={btn}>Invite</button>
          </div>
          {inviteMsg && (
            <div style={{ marginTop: 10, fontSize: 12.5, color: inviteMsg.ok ? '#22c55e' : '#f59e0b' }}>{inviteMsg.text}</div>
          )}
          {inviteLink && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 12, color: '#a1a1aa', marginBottom: 4 }}>Share this invitation link:</div>
              <code style={linkBox}>{inviteLink}</code>
            </div>
          )}
        </div>
      )}
    </Shell>
  );
}

function RoleBadge({ role }: { role: TeamRole }) {
  const color = role === 'owner' ? '#a78bfa' : role === 'manager' ? '#22c55e' : '#a1a1aa';
  const label = role.charAt(0).toUpperCase() + role.slice(1);
  return (
    <span style={{ display: 'inline-block', padding: '1px 8px', borderRadius: 999, border: `1px solid ${color}`, color, fontSize: 11, fontWeight: 600 }}>
      {label}
    </span>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ background: '#09090b', color: '#e4e4e7', minHeight: '100vh', padding: 32 }}>
      <div style={{ display: 'flex', gap: 16, fontSize: 13 }}>
        <a href="#/editor" style={{ color: '#a78bfa', textDecoration: 'none' }}>← Editor</a>
        <a href="#/team/analytics" style={{ color: '#71717a', textDecoration: 'none' }}>Analytics</a>
      </div>
      <div style={{ maxWidth: 720, margin: '20px auto 0' }}>{children}</div>
    </div>
  );
}
const card: React.CSSProperties = { border: '1px solid #27272a', borderRadius: 8, padding: 16, background: '#18181b', marginTop: 18 };
const t: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 14 };
const th: React.CSSProperties = { textAlign: 'left', padding: '8px 10px', color: '#a1a1aa', borderBottom: '1px solid #27272a' };
const td: React.CSSProperties = { padding: '8px 10px', borderBottom: '1px solid #18181b', color: '#d4d4d8' };
const inp: React.CSSProperties = { background: '#0a0a0a', color: '#e4e4e7', border: '1px solid #27272a', borderRadius: 5, padding: '7px 10px', fontSize: 13 };
const sel: React.CSSProperties = { background: '#18181b', color: '#e4e4e7', border: '1px solid #27272a', borderRadius: 5, padding: '6px 8px', fontSize: 12.5 };
const btn: React.CSSProperties = { background: '#7c3aed', color: 'white', border: 'none', borderRadius: 6, padding: '7px 14px', fontWeight: 600, fontSize: 13, cursor: 'pointer' };
const rm: React.CSSProperties = { background: 'transparent', color: '#ef4444', border: '1px solid #3f3f46', borderRadius: 5, padding: '3px 10px', fontSize: 12, cursor: 'pointer' };
const rmSolid: React.CSSProperties = { background: '#dc2626', color: 'white', border: 'none', borderRadius: 5, padding: '5px 14px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' };
const linkBox: React.CSSProperties = { display: 'block', background: '#0a0a0a', border: '1px solid #27272a', borderRadius: 6, padding: 10, color: '#86efac', fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' };
const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 };
const dialog: React.CSSProperties = { background: '#18181b', border: '1px solid #3f3f46', borderRadius: 10, padding: 18, width: 360, maxWidth: '90vw' };
