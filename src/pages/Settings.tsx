import { useCallback, useEffect, useState } from 'react';
import { useAppUser } from '../hooks/useAppUser';
import { getSupabase, isSupabaseConfigured } from '../services/supabaseClient';
import {
  apiKeyDisplayPrefix,
  generateApiKey,
  hashApiKey,
} from '../services/apiKeys';
import { computeBadgeCriteria } from '../services/badge';
import { listSchemaConnections, type SchemaConnectionSummary } from '../services/schemaConnections';
import { SUPPORTED_DIALECTS } from '../services/schemaConnector';
import { getEmailPreference, saveEmailPreference, type DigestFrequency } from '../services/digest';
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

  // Sprint 10 — post-checkout success banner + billing portal.
  const [showCheckoutSuccess, setShowCheckoutSuccess] = useState(false);
  const [portalBusy, setPortalBusy] = useState(false);

  useEffect(() => {
    // ?checkout=success may arrive in the hash query (#/settings?checkout=success)
    // or the search string. Show the banner, strip the param, auto-dismiss in 5s.
    const inHash = /[?&]checkout=success/.test(window.location.hash);
    const inSearch = /[?&]checkout=success/.test(window.location.search);
    if (!inHash && !inSearch) return;
    setShowCheckoutSuccess(true);
    try {
      window.history.replaceState(null, '', '#/settings');
    } catch {
      /* ignore */
    }
    const id = setTimeout(() => setShowCheckoutSuccess(false), 5000);
    return () => clearTimeout(id);
  }, []);

  const openPortal = async () => {
    if (!appUser?.clerkUserId || portalBusy) return;
    setPortalBusy(true);
    try {
      const res = await fetch('/api/stripe/portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clerkUserId: appUser.clerkUserId }),
      });
      const data = (await res.json()) as { url?: string };
      if (data.url) window.location.href = data.url;
      else setPortalBusy(false);
    } catch {
      setPortalBusy(false);
    }
  };

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
    ? `![SafeSQL Pro Certified](${SITE_URL}/api/badge/${appUser.id})`
    : '';

  // ── Schema Connections (Sprint 9) ──────────────────────────────────────────
  const [connections, setConnections] = useState<SchemaConnectionSummary[]>([]);
  const [connName, setConnName] = useState('');
  const [connDialect, setConnDialect] = useState('postgresql');
  const [connString, setConnString] = useState('');
  const [connApiKey, setConnApiKey] = useState('');
  const [connMsg, setConnMsg] = useState<string | null>(null);
  const [connTested, setConnTested] = useState(false);
  // Sprint 10 — dialect-specific config fields (BigQuery / Snowflake).
  const [bq, setBq] = useState({ project_id: '', dataset_id: '', credentials_json: '' });
  const [sf, setSf] = useState({ account: '', username: '', password: '', warehouse: '', database: '', schema: 'PUBLIC' });

  const onDialectChange = (d: string) => {
    setConnDialect(d);
    setConnTested(false);
    setConnMsg(null);
  };

  // Build the `connection_string` payload for the chosen dialect. PostgreSQL is a
  // raw connection string; BigQuery/Snowflake are JSON config blobs (encrypted
  // whole, server-side).
  const buildConnConfig = (): string | null => {
    if (connDialect === 'postgresql') return connString.trim() || null;
    if (connDialect === 'bigquery') {
      if (!bq.project_id || !bq.dataset_id || !bq.credentials_json) return null;
      return JSON.stringify({ type: 'bigquery', ...bq });
    }
    if (connDialect === 'snowflake') {
      if (!sf.account || !sf.username || !sf.password || !sf.database) return null;
      return JSON.stringify({ type: 'snowflake', ...sf });
    }
    return null;
  };

  // Test before save. Real connectivity happens server-side on Save/Sync; this
  // validates that the dialect-specific fields are well-formed and gates Save.
  const testConnection = () => {
    let ok = false;
    if (connDialect === 'postgresql') ok = /^postgres(ql)?:\/\/.+@.+\/.+/.test(connString.trim());
    else if (connDialect === 'bigquery') {
      ok = !!bq.project_id && !!bq.dataset_id && isJson(bq.credentials_json);
    } else if (connDialect === 'snowflake') {
      ok = !!sf.account && !!sf.username && !!sf.password && !!sf.database;
    }
    setConnTested(ok);
    setConnMsg(ok ? '✅ Config looks valid — Save to encrypt & sync.' : '❌ Failed — fill in all required fields (valid JSON for BigQuery credentials).');
  };

  const refreshConnections = useCallback(async () => {
    if (!appUser?.id) return;
    setConnections(await listSchemaConnections(appUser.id));
  }, [appUser?.id]);

  const deleteConnection = async (id: string) => {
    const supabase = getSupabase();
    if (!supabase) return;
    await supabase.from('schema_connections').delete().eq('id', id);
    await refreshConnections();
  };

  useEffect(() => {
    void refreshConnections();
  }, [refreshConnections]);

  const addConnection = async () => {
    const config = buildConnConfig();
    if (!connName.trim() || !config || !connApiKey.trim()) {
      setConnMsg('Name, connection config and an API key are all required.');
      return;
    }
    setConnMsg('Saving…');
    try {
      const res = await fetch('/api/schema/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connApiKey.trim()}` },
        body: JSON.stringify({ name: connName, dialect: connDialect, connection_string: config }),
      });
      const data = await res.json();
      if (res.ok) {
        setConnMsg('✓ Connection saved');
        setConnName('');
        setConnString('');
        setConnTested(false);
        await refreshConnections();
      } else {
        setConnMsg(data.error ?? 'Save failed');
      }
    } catch {
      setConnMsg('Network error');
    }
  };

  const syncConnection = async (id: string) => {
    if (!connApiKey.trim()) {
      setConnMsg('Paste an API key above to sync.');
      return;
    }
    setConnMsg('Syncing…');
    try {
      const res = await fetch('/api/schema/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connApiKey.trim()}` },
        body: JSON.stringify({ connection_id: id }),
      });
      const data = await res.json();
      setConnMsg(res.ok ? `✓ Synced ${data.tableCount} tables` : data.error ?? 'Sync failed');
      await refreshConnections();
    } catch {
      setConnMsg('Network error');
    }
  };

  // ── Email digest (Sprint 10) ───────────────────────────────────────────────
  const [digestFreq, setDigestFreq] = useState<DigestFrequency>('weekly');
  const [digestDay, setDigestDay] = useState(1);
  const [lastSent, setLastSent] = useState<string | null>(null);
  const [digestMsg, setDigestMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!appUser?.clerkUserId) return;
    void getEmailPreference(appUser.clerkUserId).then((p) => {
      if (p) {
        setDigestFreq(p.digest_frequency);
        setDigestDay(p.digest_day ?? 1);
        setLastSent(p.last_sent_at);
      }
    });
  }, [appUser?.clerkUserId]);

  const saveDigest = async (freq: DigestFrequency, day: number) => {
    if (!appUser?.clerkUserId) return;
    setDigestFreq(freq);
    setDigestDay(day);
    const ok = await saveEmailPreference({ user_id: appUser.clerkUserId, digest_frequency: freq, digest_day: day });
    setDigestMsg(ok ? '✓ Saved' : 'Save failed (migration applied?)');
  };

  const sendTestDigest = async () => {
    if (!appUser?.clerkUserId) return;
    setDigestMsg('Sending…');
    try {
      const res = await fetch('/api/digest/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test: true, clerkUserId: appUser.clerkUserId }),
      });
      const data = (await res.json()) as { sent?: boolean; reason?: string };
      setDigestMsg(data.sent ? '✓ Test digest sent' : `Computed, not emailed (${data.reason ?? 'no RESEND key'})`);
    } catch {
      setDigestMsg('Network error');
    }
  };

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
      {showCheckoutSuccess && (
        <div
          role="status"
          onClick={() => setShowCheckoutSuccess(false)}
          style={{ background: '#052e16', border: '1px solid #16a34a', color: '#bbf7d0', borderRadius: 8, padding: '12px 14px', marginBottom: 16, cursor: 'pointer', fontSize: 13.5 }}
        >
          🎉 Welcome to SafeSQL Pro {appUser ? cap(appUser.plan) : ''}! Your account has been upgraded. (click to dismiss)
        </div>
      )}
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Settings</h1>

      {/* Billing */}
      <h2 style={{ fontSize: 15, color: '#a1a1aa', marginTop: 20 }}>Billing</h2>
      <div style={card}>
        <p style={{ color: '#a1a1aa', fontSize: 13, marginTop: 0 }}>
          Current plan: <strong style={{ color: '#e4e4e7' }}>{appUser ? cap(appUser.plan) : '—'}</strong>
        </p>
        {isPro ? (
          <button type="button" onClick={() => void openPortal()} disabled={portalBusy} style={primaryBtn}>
            {portalBusy ? 'Opening…' : 'Manage subscription'}
          </button>
        ) : (
          <a href="#/pricing" style={{ ...primaryBtn, textDecoration: 'none', display: 'inline-block' }}>Upgrade →</a>
        )}
      </div>

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

      {/* Schema Connections */}
      <h2 style={{ fontSize: 15, color: '#a1a1aa', marginTop: 28 }}>Schema Connections</h2>
      {!isPro ? (
        <div style={card}>
          <p style={{ color: '#a1a1aa', fontSize: 13 }}>
            Connect a read-only database to auto-import your schema (no more DDL paste).
            Available on Pro and above. <a href="#/pricing" style={{ color: '#a78bfa' }}>Upgrade →</a>
          </p>
        </div>
      ) : (
        <div style={card}>
          <p style={{ color: '#a1a1aa', fontSize: 12.5, marginTop: 0 }}>
            Auto-import your schema from a read-only connection. Credentials are AES-256 encrypted
            server-side — never stored in plaintext.{' '}
            <strong style={{ color: '#d4d4d8' }}>PostgreSQL, BigQuery and Snowflake</strong> are
            supported; MySQL is coming soon.
          </p>

          {connections.length > 0 && (
            <table style={tableStyle}>
              <thead><tr>{['Name', 'Dialect', 'Last synced', ''].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {connections.map((c) => (
                  <tr key={c.id}>
                    <td style={td}>{c.name}</td>
                    <td style={td}><span style={dialectBadge}>{c.dialect}</span></td>
                    <td style={td}>{c.last_synced_at?.slice(0, 16).replace('T', ' ') ?? 'never'}</td>
                    <td style={td}>
                      <button type="button" onClick={() => void syncConnection(c.id)} style={{ ...revokeBtn, color: '#a78bfa' }}>Sync now</button>
                      <a href="#/editor" style={{ color: '#71717a', fontSize: 12, margin: '0 8px' }}>Use in editor →</a>
                      <button type="button" onClick={() => void deleteConnection(c.id)} style={revokeBtn}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div style={{ marginTop: 14, display: 'grid', gap: 8 }}>
            <input value={connName} onChange={(e) => setConnName(e.target.value)} placeholder="Display name (e.g. Production DB)" style={inputStyle} />
            <select value={connDialect} onChange={(e) => onDialectChange(e.target.value)} style={{ ...inputStyle, flex: '0 0 160px' }}>
              {SUPPORTED_DIALECTS.map((d) => <option key={d} value={d}>{d}</option>)}
              <option value="mysql" disabled>mysql (coming soon)</option>
            </select>

            {connDialect === 'postgresql' && (
              <input type="password" value={connString} onChange={(e) => { setConnString(e.target.value); setConnTested(false); }} placeholder="postgresql://user:pw@host:5432/db" style={inputStyle} />
            )}
            {connDialect === 'bigquery' && (
              <>
                <input value={bq.project_id} onChange={(e) => { setBq({ ...bq, project_id: e.target.value }); setConnTested(false); }} placeholder="GCP project id" style={inputStyle} />
                <input value={bq.dataset_id} onChange={(e) => { setBq({ ...bq, dataset_id: e.target.value }); setConnTested(false); }} placeholder="Dataset id (e.g. analytics)" style={inputStyle} />
                <textarea value={bq.credentials_json} onChange={(e) => { setBq({ ...bq, credentials_json: e.target.value }); setConnTested(false); }} placeholder='Service-account credentials JSON {"client_email": "...", "private_key": "..."}' style={{ ...inputStyle, minHeight: 70, fontFamily: 'monospace' }} />
              </>
            )}
            {connDialect === 'snowflake' && (
              <>
                <input value={sf.account} onChange={(e) => { setSf({ ...sf, account: e.target.value }); setConnTested(false); }} placeholder="Account (e.g. xy12345.us-east-1)" style={inputStyle} />
                <div style={{ display: 'flex', gap: 8 }}>
                  <input value={sf.username} onChange={(e) => { setSf({ ...sf, username: e.target.value }); setConnTested(false); }} placeholder="Username" style={{ ...inputStyle, flex: 1 }} />
                  <input type="password" value={sf.password} onChange={(e) => { setSf({ ...sf, password: e.target.value }); setConnTested(false); }} placeholder="Password" style={{ ...inputStyle, flex: 1 }} />
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input value={sf.warehouse} onChange={(e) => { setSf({ ...sf, warehouse: e.target.value }); setConnTested(false); }} placeholder="Warehouse" style={{ ...inputStyle, flex: 1 }} />
                  <input value={sf.database} onChange={(e) => { setSf({ ...sf, database: e.target.value }); setConnTested(false); }} placeholder="Database" style={{ ...inputStyle, flex: 1 }} />
                  <input value={sf.schema} onChange={(e) => { setSf({ ...sf, schema: e.target.value }); setConnTested(false); }} placeholder="Schema" style={{ ...inputStyle, flex: 1 }} />
                </div>
              </>
            )}

            <input type="password" value={connApiKey} onChange={(e) => setConnApiKey(e.target.value)} placeholder="Your API key (ssk_live_…) — used to encrypt + sync" style={inputStyle} />
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <button type="button" onClick={testConnection} style={{ ...revokeBtn, color: '#a78bfa' }}>Test connection</button>
              <button type="button" onClick={() => void addConnection()} disabled={!connTested} style={{ ...primaryBtn, opacity: connTested ? 1 : 0.5, cursor: connTested ? 'pointer' : 'not-allowed' }}>Save</button>
              {connMsg && <span style={{ fontSize: 12, color: /^(✓|✅)/.test(connMsg) ? '#22c55e' : '#f59e0b' }}>{connMsg}</span>}
            </div>
            <div style={{ fontSize: 11.5, color: '#71717a', display: 'flex', alignItems: 'center', gap: 6 }}>
              🔒 Your connection string is encrypted with AES-256 before storage. We never read your table contents.
            </div>
          </div>
        </div>
      )}

      {/* Email notifications (digest) */}
      <h2 style={{ fontSize: 15, color: '#a1a1aa', marginTop: 28 }}>Email notifications</h2>
      <div style={card}>
        <p style={{ color: '#a1a1aa', fontSize: 12.5, marginTop: 0 }}>
          Get a SQL health digest by email — validations, errors caught, top issues, and your score trend.
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12, color: '#a1a1aa' }}>
            Frequency:{' '}
            <select value={digestFreq} onChange={(e) => void saveDigest(e.target.value as DigestFrequency, digestDay)} style={{ background: '#18181b', color: '#e4e4e7', border: '1px solid #27272a', borderRadius: 4, padding: '4px 8px', fontSize: 12 }}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="never">Never</option>
            </select>
          </label>
          {digestFreq === 'weekly' && (
            <label style={{ fontSize: 12, color: '#a1a1aa' }}>
              Day:{' '}
              <select value={digestDay} onChange={(e) => void saveDigest(digestFreq, Number(e.target.value))} style={{ background: '#18181b', color: '#e4e4e7', border: '1px solid #27272a', borderRadius: 4, padding: '4px 8px', fontSize: 12 }}>
                {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => (
                  <option key={d} value={i}>{d}</option>
                ))}
              </select>
            </label>
          )}
          <button type="button" onClick={() => void sendTestDigest()} disabled={digestFreq === 'never'} style={{ ...revokeBtn, color: '#a78bfa' }}>Send test digest</button>
          {digestMsg && <span style={{ fontSize: 12, color: digestMsg.startsWith('✓') ? '#22c55e' : '#f59e0b' }}>{digestMsg}</span>}
        </div>
        <div style={{ fontSize: 11.5, color: '#71717a', marginTop: 8 }}>
          Last sent: {lastSent ? new Date(lastSent).toLocaleString() : 'Never sent yet'}
        </div>
      </div>

      {/* Notifications */}
      <h2 style={{ fontSize: 15, color: '#a1a1aa', marginTop: 28 }}>Notifications</h2>
      <div style={card}>
        <p style={{ color: '#a1a1aa', fontSize: 12.5, marginTop: 0 }}>
          Get a Slack alert when SafeSQL Pro catches a risky query.
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
            <img src={`${SITE_URL}/api/badge/${appUser.id}`} alt="SafeSQL Pro Certified badge" style={{ maxWidth: 320 }} />
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
          <p style={{ color: '#71717a', fontSize: 13 }}>Sign in to see your SafeSQL Pro Certified badge.</p>
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
const inputStyle: React.CSSProperties = { width: '100%', background: '#0a0a0a', color: '#e4e4e7', border: '1px solid #27272a', borderRadius: 5, padding: '7px 10px', fontSize: 12.5 };
const dialectBadge: React.CSSProperties = { display: 'inline-block', padding: '1px 8px', borderRadius: 999, border: '1px solid #3f3f46', color: '#a1a1aa', fontSize: 11 };

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function isJson(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}
