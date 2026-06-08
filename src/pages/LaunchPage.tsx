import { useEffect, useState } from 'react';
import { getSupabase } from '../services/supabaseClient';

// Sprint 9 Part 4 — pre-launch page at /launch. Countdown to launch
// (VITE_LAUNCH_DATE), email capture into launch_subscribers, and a "try it now"
// CTA into the editor.
const LAUNCH_DATE = (import.meta.env.VITE_LAUNCH_DATE as string | undefined) ?? '2026-07-01T07:00:00Z';

function useCountdown(target: string) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const ms = Math.max(0, new Date(target).getTime() - now);
  const s = Math.floor(ms / 1000);
  return {
    days: Math.floor(s / 86400),
    hours: Math.floor((s % 86400) / 3600),
    minutes: Math.floor((s % 3600) / 60),
    seconds: s % 60,
    live: ms === 0,
  };
}

export function LaunchPage() {
  const c = useCountdown(LAUNCH_DATE);
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'done' | 'error'>('idle');

  const subscribe = async () => {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      setStatus('error');
      return;
    }
    setStatus('saving');
    const supabase = getSupabase();
    if (!supabase) {
      // No DB configured — still acknowledge so the page is usable in previews.
      setStatus('done');
      return;
    }
    const { error } = await supabase
      .from('launch_subscribers')
      .insert({ email: email.trim().toLowerCase(), source: 'launch_page' });
    // A duplicate email (unique violation) is still a success from the user's POV.
    setStatus(error && !/duplicate|unique/i.test(error.message) ? 'error' : 'done');
  };

  return (
    <div style={{ background: '#09090b', color: '#e4e4e7', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ maxWidth: 560, textAlign: 'center' }}>
        <div style={{ fontSize: 13, color: '#a78bfa', letterSpacing: 1, textTransform: 'uppercase' }}>Coming soon to Product Hunt</div>
        <h1 style={{ fontSize: 38, margin: '14px 0 8px', lineHeight: 1.15 }}>
          SafeSQL Pro is launching{c.live ? ' — now live!' : ' soon'}
        </h1>
        <p style={{ color: '#a1a1aa', fontSize: 15 }}>
          Pre-execution SQL validation that catches logic errors — wrong JOINs, hallucinated
          columns, fan-out aggregates — before they reach production.
        </p>

        {!c.live && (
          <div style={{ display: 'flex', justifyContent: 'center', gap: 18, margin: '28px 0' }}>
            <Unit n={c.days} label="days" />
            <Unit n={c.hours} label="hours" />
            <Unit n={c.minutes} label="min" />
            <Unit n={c.seconds} label="sec" />
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap', marginTop: 20 }}>
          <input
            type="email"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setStatus('idle'); }}
            placeholder="you@company.com"
            style={{ background: '#0a0a0a', color: '#e4e4e7', border: '1px solid #27272a', borderRadius: 8, padding: '11px 14px', fontSize: 14, minWidth: 240 }}
          />
          <button type="button" onClick={() => void subscribe()} disabled={status === 'saving'} style={{ background: '#7c3aed', color: 'white', border: 'none', borderRadius: 8, padding: '11px 20px', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}>
            {status === 'done' ? '✓ You’re on the list' : status === 'saving' ? 'Adding…' : 'Notify me'}
          </button>
        </div>
        {status === 'error' && <div style={{ color: '#f59e0b', fontSize: 13, marginTop: 8 }}>Enter a valid email address.</div>}

        <div style={{ marginTop: 30 }}>
          <a href="#/editor" style={{ color: '#a78bfa', fontSize: 14, textDecoration: 'none' }}>or try it now, free →</a>
        </div>
      </div>
    </div>
  );
}

function Unit({ n, label }: { n: number; label: string }) {
  return (
    <div>
      <div style={{ fontSize: 34, fontWeight: 800, color: '#e4e4e7', fontVariantNumeric: 'tabular-nums' }}>{String(n).padStart(2, '0')}</div>
      <div style={{ fontSize: 11, color: '#71717a', textTransform: 'uppercase', letterSpacing: 1 }}>{label}</div>
    </div>
  );
}
