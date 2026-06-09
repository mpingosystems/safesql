import { useState } from 'react';
import { useAppUser } from '../hooks/useAppUser';
import { useTeam } from '../hooks/useTeam';
import { getSupabase } from '../services/supabaseClient';
import { acceptInvitation, createTeam } from '../services/teams';

// Sprint 9 Part 1 — team onboarding at /team/setup. Shown when a Team+ user has
// no team yet. Two paths: create a new team, or join with an invitation token.
export function TeamSetupPage() {
  const { appUser } = useAppUser();
  const { team, refresh } = useTeam();
  const isTeam = !!appUser && ['team', 'business', 'enterprise'].includes(appUser.plan);

  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const create = async () => {
    if (!appUser || !name.trim() || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const t = await createTeam(name, appUser.id, appUser.email, getSupabase());
      if (!t) { setMsg('That team name may be taken, or the teams migration isn’t applied yet. Try another name.'); return; }
      await refresh();
      window.location.hash = '#/team/members';
    } finally {
      setBusy(false);
    }
  };

  const join = async () => {
    if (!appUser || !token.trim() || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await acceptInvitation(token.trim(), appUser.id, appUser.email, getSupabase());
      if (!res) { setMsg('That invitation token is invalid or has expired. Ask your team manager for a new invite.'); return; }
      await refresh();
      window.location.hash = '#/team/analytics';
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell>
      <h1 style={{ fontSize: 22 }}>Set up your team</h1>
      {appUser && (
        <p style={{ color: '#71717a', fontSize: 12.5, marginTop: 2 }}>
          Signed in as <span style={{ color: '#a1a1aa' }}>{appUser.email}</span>
        </p>
      )}
      {!isTeam ? (
        <p style={{ color: '#a1a1aa' }}>Teams are a Team-plan feature. <a href="#/pricing" style={{ color: '#a78bfa' }}>Upgrade →</a></p>
      ) : team ? (
        <p style={{ color: '#a1a1aa' }}>You're already on <strong>{team.name}</strong>. <a href="#/team/members" style={{ color: '#a78bfa' }}>Manage members →</a></p>
      ) : (
        <>
          <div style={card}>
            <h2 style={h2}>Create a new team</h2>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Data Team" style={inp} />
            <button type="button" onClick={() => void create()} disabled={busy || !name.trim()} style={btn}>Create team</button>
          </div>
          <div style={{ textAlign: 'center', color: '#52525b', margin: '14px 0', fontSize: 12 }}>— or —</div>
          <div style={card}>
            <h2 style={h2}>Join with an invitation</h2>
            <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="Invitation token" style={inp} />
            <button type="button" onClick={() => void join()} disabled={busy || !token.trim()} style={btn}>Join team</button>
          </div>
          {msg && <p style={{ color: '#f59e0b', fontSize: 13, marginTop: 12 }}>{msg}</p>}
        </>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ background: '#09090b', color: '#e4e4e7', minHeight: '100vh', padding: 32 }}>
      <a href="#/editor" style={{ color: '#a78bfa', textDecoration: 'none', fontSize: 13 }}>← Editor</a>
      <div style={{ maxWidth: 560, margin: '20px auto 0' }}>{children}</div>
    </div>
  );
}
const card: React.CSSProperties = { border: '1px solid #27272a', borderRadius: 8, padding: 18, background: '#18181b', marginTop: 12 };
const h2: React.CSSProperties = { fontSize: 14, color: '#a1a1aa', marginTop: 0, marginBottom: 10 };
const inp: React.CSSProperties = { width: '100%', background: '#0a0a0a', color: '#e4e4e7', border: '1px solid #27272a', borderRadius: 5, padding: '8px 10px', fontSize: 13, marginBottom: 10 };
const btn: React.CSSProperties = { background: '#7c3aed', color: 'white', border: 'none', borderRadius: 6, padding: '8px 16px', fontWeight: 600, fontSize: 13, cursor: 'pointer' };
