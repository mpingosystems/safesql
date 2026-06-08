import { useCallback, useEffect, useState } from 'react';
import { useAppUser } from '../hooks/useAppUser';
import { getSupabase, isSupabaseConfigured } from '../services/supabaseClient';
import {
  apiKeyDisplayPrefix,
  generateApiKey,
  hashApiKey,
} from '../services/apiKeys';
import { SITE_URL } from '../config/constants';

interface ApiKeyRow {
  id: string;
  key_prefix: string;
  plan: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

// Sprint 7 Part 3 — API key management (Pro+). The raw key is shown exactly once.
export function SettingsPage() {
  const { appUser } = useAppUser();
  const isPro = !!appUser && appUser.plan !== 'free';
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!appUser?.id || !isSupabaseConfigured) return;
    const supabase = getSupabase();
    if (!supabase) return;
    const { data } = await supabase
      .from('api_keys')
      .select('id, key_prefix, plan, created_at, last_used_at, revoked_at')
      .eq('user_id', appUser.id)
      .order('created_at', { ascending: false });
    setKeys((data as ApiKeyRow[]) ?? []);
  }, [appUser?.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const generate = async () => {
    if (!appUser?.id || !isPro || busy) return;
    setBusy(true);
    const supabase = getSupabase();
    const raw = generateApiKey();
    try {
      const key_hash = await hashApiKey(raw);
      const { error } = await supabase!.from('api_keys').insert({
        user_id: appUser.id,
        key_hash,
        key_prefix: apiKeyDisplayPrefix(raw),
        plan: appUser.plan,
      });
      if (!error) {
        setNewKey(raw);
        await refresh();
      }
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    const supabase = getSupabase();
    if (!supabase) return;
    await supabase.from('api_keys').update({ revoked_at: new Date().toISOString() }).eq('id', id);
    await refresh();
  };

  const curl = `curl -X POST ${SITE_URL}/api/validate \\\n  -H "Authorization: Bearer ssk_live_xxxx" \\\n  -H "Content-Type: application/json" \\\n  -d '{"sql":"SELECT * FROM users","dialect":"postgresql"}'`;

  return (
    <Shell>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Settings</h1>
      <h2 style={{ fontSize: 15, color: '#a1a1aa', marginTop: 20 }}>API Keys</h2>

      {!isPro ? (
        <div style={card}>
          <p style={{ color: '#a1a1aa', fontSize: 13 }}>
            The REST API is available on Pro and above.{' '}
            <a href="#/pricing" style={{ color: '#a78bfa' }}>Upgrade to generate a key →</a>
          </p>
        </div>
      ) : (
        <>
          <div style={card}>
            <button type="button" onClick={() => void generate()} disabled={busy} style={primaryBtn}>
              {busy ? 'Generating…' : 'Generate new key'}
            </button>
            {newKey && (
              <div style={{ marginTop: 12 }}>
                <div style={{ color: '#f59e0b', fontSize: 12, marginBottom: 4 }}>
                  Copy this key now — it won't be shown again.
                </div>
                <code style={keyBox}>{newKey}</code>
              </div>
            )}
          </div>

          <table style={tableStyle}>
            <thead>
              <tr>{['Key', 'Plan', 'Created', 'Last used', ''].map((h) => <th key={h} style={th}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {keys.length === 0 ? (
                <tr><td colSpan={5} style={tdMuted}>No keys yet.</td></tr>
              ) : (
                keys.map((k) => (
                  <tr key={k.id} style={{ opacity: k.revoked_at ? 0.5 : 1 }}>
                    <td style={td}><code>{k.key_prefix}…</code></td>
                    <td style={td}>{k.plan}</td>
                    <td style={td}>{k.created_at?.slice(0, 10)}</td>
                    <td style={td}>{k.last_used_at?.slice(0, 10) ?? '—'}</td>
                    <td style={td}>
                      {k.revoked_at ? (
                        <span style={{ color: '#71717a' }}>revoked</span>
                      ) : (
                        <button type="button" onClick={() => void revoke(k.id)} style={revokeBtn}>Revoke</button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>

          <h3 style={{ fontSize: 13, color: '#a1a1aa', marginTop: 22 }}>Example request</h3>
          <pre style={keyBox}>{curl}</pre>
          <p style={{ fontSize: 12, color: '#71717a' }}>
            Full API reference at <a href="/api-docs" style={{ color: '#a78bfa' }}>{SITE_URL}/api-docs</a>
          </p>
        </>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ background: '#09090b', color: '#e4e4e7', minHeight: '100vh', padding: 32 }}>
      <a href="#/editor" style={{ color: '#a78bfa', textDecoration: 'none', fontSize: 13 }}>← Editor</a>
      <div style={{ maxWidth: 760, margin: '20px auto 0' }}>{children}</div>
    </div>
  );
}

const card: React.CSSProperties = { border: '1px solid #27272a', borderRadius: 8, padding: 16, background: '#18181b', marginTop: 10 };
const primaryBtn: React.CSSProperties = { background: '#7c3aed', color: 'white', border: 'none', borderRadius: 6, padding: '8px 14px', fontWeight: 600, fontSize: 13, cursor: 'pointer' };
const revokeBtn: React.CSSProperties = { background: 'transparent', color: '#ef4444', border: '1px solid #3f3f46', borderRadius: 5, padding: '3px 10px', fontSize: 12, cursor: 'pointer' };
const keyBox: React.CSSProperties = { display: 'block', background: '#0a0a0a', border: '1px solid #27272a', borderRadius: 6, padding: 12, color: '#86efac', fontFamily: '"JetBrains Mono", monospace', fontSize: 12.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: '6px 0' };
const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 14 };
const th: React.CSSProperties = { textAlign: 'left', padding: '8px 10px', color: '#a1a1aa', borderBottom: '1px solid #27272a' };
const td: React.CSSProperties = { padding: '8px 10px', borderBottom: '1px solid #18181b', color: '#d4d4d8' };
const tdMuted: React.CSSProperties = { padding: 12, color: '#52525b' };
