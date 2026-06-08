import { useEffect, useRef, useState } from 'react';
import { useAppUser } from '../hooks/useAppUser';
import { useTeam } from '../hooks/useTeam';
import { getSupabase } from '../services/supabaseClient';
import { acceptInvitation } from '../services/teams';

// Sprint 9 Part 1 — invitation acceptance at /team/join?token=…. Reads the token
// from the hash query string, accepts it for the signed-in user, then routes to
// team analytics.
function tokenFromHash(): string | null {
  const m = /[?&]token=([^&]+)/.exec(window.location.hash);
  return m ? decodeURIComponent(m[1]) : null;
}

export function JoinTeamPage() {
  const { appUser } = useAppUser();
  const { refresh } = useTeam();
  const [status, setStatus] = useState<'idle' | 'joining' | 'done' | 'error'>('idle');
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    const token = tokenFromHash();
    if (!token) { setStatus('error'); return; }
    if (!appUser) return; // wait for sign-in
    ran.current = true;
    setStatus('joining');
    void (async () => {
      const res = await acceptInvitation(token, appUser.id, appUser.email, getSupabase());
      if (res) {
        await refresh();
        setStatus('done');
        window.location.hash = '#/team/analytics';
      } else {
        setStatus('error');
      }
    })();
  }, [appUser, refresh]);

  return (
    <div style={{ background: '#09090b', color: '#e4e4e7', minHeight: '100vh', padding: 32, textAlign: 'center' }}>
      <div style={{ maxWidth: 480, margin: '80px auto 0' }}>
        <div style={{ fontSize: 32 }}>👥</div>
        {!appUser && <p style={{ color: '#a1a1aa' }}>Sign in to accept your team invitation.</p>}
        {status === 'joining' && <p style={{ color: '#a1a1aa' }}>Joining team…</p>}
        {status === 'done' && <p style={{ color: '#22c55e' }}>You're in! Redirecting…</p>}
        {status === 'error' && (
          <p style={{ color: '#f59e0b' }}>
            That invitation is invalid or expired. <a href="#/team/setup" style={{ color: '#a78bfa' }}>Set up a team →</a>
          </p>
        )}
      </div>
    </div>
  );
}
