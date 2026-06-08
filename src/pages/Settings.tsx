import { useCallback, useEffect, useState } from 'react';
import { useAppUser } from '../hooks/useAppUser';
import { getSupabase, isSupabaseConfigured } from '../services/supabaseClient';
import {
  apiKeyDisplayPrefix,
  generateApiKey,
  hashApiKey,
} from '../services/apiKeys';
import { computeBadgeCriteria } from '../services/badge';
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
  const [badgeStats, setBadgeStats] = useState({ count: 0, avg: 0, destructive: 0 });

  useEffect(() => {
    if (!appUser?.id || !isSupabaseConfigured) return;
    const supabase = getSupabase();
    if (!supabase) return;
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    void supabase
      .from('validations')
      .select('risk_score, report')
      .eq('user_id', appUser.id)
      .gte('created_at', since)
      .then(({ data }) => {
        const rows = (data as { risk_score: number; report?: { errors?: { id: string }[] } | null }[]) ?? [];
        const destructiveIds = ['MISSING_WHERE_DESTRUCTIVE', 'DESTRUCTIVE_DDL', 'DESTRUCTIVE_TRUNCATE'];
        setBadgeStats({
          count: rows.length,
          avg: rows.length ? Math.round(rows.reduce((s, r) => s + (r.risk_score ?? 0), 0) / rows.length) : 0,
          destructive: rows.filter((r) => (r.report?.errors ?? []).some((e) => destructiveIds.includes(e.id))).length,
        });
      });
  }, [appUser?.id]);

  const badge = computeBadgeCriteria({
    validationCount: badgeStats.count,
    averageScore: badgeStats.avg,
    destructiveExecuted: badgeStats.destructive,
  });
  const badgeMarkdown = appUser
    ? `![SafeSQL Certified](${SITE_URL}/api/badge/${appUser.id})`
    : '';

  // ── Notifications (Slack webhook) ──────────────────────────────────────────
  const [webhookUrl, setWebhookUrl] = useState('');
  const [trigger, setTrigger] = useState<'error' | 'warning' | 'all'>('error');
  const [webhookMsg, setWebhookMsg] = useState<string | null>(null);

  const testWebhook = async () => {
    if (!webhookUrl) return;
    setWebhookMsg('Sending…');
    try {
      const res = await fetch('/api/webhook/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhook_url: webhookUrl }),
      });
      const data = await res.json();
      setWebhookMsg(data.status === 'delivered' ? '✓ Test delivered' : `Failed (${data.http_status})`);
    } catch {
      setWebhookMsg('Network error');
    }
  };

  const saveWebhook = async () => {
    if (!appUser?.id || !webhookUrl) return;
    const supabase = getSupabase();
    if (!supabase) return;
    const triggerArr = trigger === 'all' ? ['all'] : trigger === 'warning' ? ['error', 'warning'] : ['error'];
    const { error } = await supabase.from('webhook_configs').insert({
      user_id: appUser.id,
      webhook_url: webhookUrl,
      webhook_type: 'slack',
      trigger_on: triggerArr,
      active: true,
    });
    setWebhookMsg(error ? 'Save failed (migration applied?)' : '✓ Webhook saved');
  };

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

      {/* Notifications */}
      <h2 style={{ fontSize: 15, color: '#a1a1aa', marginTop: 28 }}>Notifications</h2>
      <div style={card}>
        <p style={{ color: '#a1a1aa', fontSize: 12.5, marginTop: 0 }}>
          Get a Slack alert when SafeSQL catches a risky query.
        </p>
        <input
          type="url"
          placeholder="https://hooks.slack.com/services/…"
          value={webhookUrl}
          onChange={(e) => setWebhookUrl(e.target.value)}
          style={{ width: '100%', background: '#0a0a0a', color: '#e4e4e7', border: '1px solid #27272a', borderRadius: 5, padding: '7px 10px', fontSize: 12.5 }}
        />
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12, color: '#a1a1aa' }}>
            Trigger:{' '}
            <select value={trigger} onChange={(e) => setTrigger(e.target.value as 'error' | 'warning' | 'all')} style={{ background: '#18181b', color: '#e4e4e7', border: '1px solid #27272a', borderRadius: 4, padding: '4px 8px', fontSize: 12 }}>
              <option value="error">Errors only</option>
              <option value="warning">Errors + Warnings</option>
              <option value="all">All validations</option>
            </select>
          </label>
          <button type="button" onClick={() => void testWebhook()} disabled={!webhookUrl} style={{ ...revokeBtn, color: '#a78bfa' }}>Test</button>
          <button type="button" onClick={() => void saveWebhook()} disabled={!webhookUrl} style={primaryBtn}>Save</button>
          {webhookMsg && <span style={{ fontSize: 12, color: webhookMsg.startsWith('✓') ? '#22c55e' : '#f59e0b' }}>{webhookMsg}</span>}
        </div>
      </div>

      {/* Your Badge */}
      <h2 style={{ fontSize: 15, color: '#a1a1aa', marginTop: 28 }}>Your Badge</h2>
      <div style={card}>
        {appUser ? (
          <>
            <img src={`${SITE_URL}/api/badge/${appUser.id}`} alt="SafeSQL Certified badge" style={{ maxWidth: 320 }} />
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 12, color: '#a1a1aa', marginBottom: 4 }}>Embed in your README:</div>
              <code style={keyBox}>{badgeMarkdown}</code>
              <button
                type="button"
                onClick={() => void navigator.clipboard?.writeText(badgeMarkdown)}
                style={{ ...revokeBtn, color: '#a78bfa' }}
              >
                Copy markdown
              </button>
            </div>
            <ul style={{ marginTop: 12, paddingLeft: 18, fontSize: 13, lineHeight: 1.8 }}>
              {badge.checks.map((c) => (
                <li key={c.label} style={{ color: c.met ? '#22c55e' : '#71717a' }}>
                  {c.met ? '✓' : '○'} {c.label}
                </li>
              ))}
            </ul>
            <div style={{ fontSize: 12, color: badge.certified ? '#22c55e' : '#71717a' }}>
              {badge.certified ? 'Certified ✓' : 'Not yet certified — keep validating.'}
            </div>
          </>
        ) : (
          <p style={{ color: '#71717a', fontSize: 13 }}>Sign in to see your SafeSQL Certified badge.</p>
        )}
      </div>
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
