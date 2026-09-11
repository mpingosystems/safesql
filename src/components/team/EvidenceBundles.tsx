import { useCallback, useEffect, useState } from 'react';
import {
  downloadBundle,
  generateBundle,
  listBundles,
  saveBytes,
  verifyBundle,
  type BundleList,
  type BundleVerification,
  type EvidenceBundleRow,
} from '../../services/evidenceApi';

// Sprint 9 (compliance tier) — the Evidence Bundles section of /team.
//
// Business+ only (the API gates it; this component just renders the locked
// state otherwise). Owners, managers and auditors generate; every seat can
// download and verify. Bundles are regenerated from the immutable chain on
// each download, so "Download" is also an integrity check.

const EVIDENCE_PLANS = new Set(['business', 'enterprise']);

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function fmt(ts: string): string {
  return ts.slice(0, 16).replace('T', ' ');
}

export function EvidenceBundles({ teamPlan }: { teamPlan: string }) {
  const locked = !EVIDENCE_PLANS.has(teamPlan);
  const [list, setList] = useState<BundleList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const today = new Date();
  const monthAgo = new Date(today.getTime() - 30 * 86_400_000);
  const [from, setFrom] = useState(isoDay(monthAgo));
  const [to, setTo] = useState(isoDay(today));
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [verification, setVerification] = useState<Record<string, BundleVerification>>({});

  const refresh = useCallback(async () => {
    if (locked) return;
    const res = await listBundles();
    if ('ok' in res && res.ok === false) {
      setError(res.status === 402 ? null : res.error);
      setList(null);
      return;
    }
    setError(null);
    setList(res as BundleList);
  }, [locked]);

  useEffect(() => {
    void Promise.resolve().then(refresh);
  }, [refresh]);

  const generate = async () => {
    setBusy('generate');
    setNotice(null);
    const res = await generateBundle(`${from}T00:00:00.000Z`, `${to}T23:59:59.999Z`);
    setBusy(null);
    if (!res.ok) {
      setNotice(res.status === 409 ? `Nothing to bundle: ${res.error}` : `Could not generate: ${res.error}`);
      return;
    }
    setNotice(`✓ Bundle generated — ${res.bundle.event_count} events, signed with key v${res.bundle.signing_key_version}${res.event_seq ? `, chain #${res.event_seq}` : ''}.`);
    await refresh();
  };

  const download = async (b: EvidenceBundleRow) => {
    setBusy(`dl:${b.id}`);
    setNotice(null);
    const res = await downloadBundle(b.id);
    setBusy(null);
    if (!res.ok) {
      setNotice(res.status === 409 ? `Integrity failure: ${res.error}` : `Could not download: ${res.error}`);
      return;
    }
    saveBytes(res.bytes, res.filename);
  };

  const verify = async (b: EvidenceBundleRow) => {
    setBusy(`vf:${b.id}`);
    const res = await verifyBundle(b.id);
    setBusy(null);
    if ('ok' in res && res.ok === false && 'status' in res) {
      setNotice(`Could not verify: ${res.error}`);
      return;
    }
    setVerification((v) => ({ ...v, [b.id]: res as BundleVerification }));
  };

  if (locked) {
    return (
      <div style={card}>
        <div style={{ color: '#a1a1aa', fontSize: 13 }}>
          🔒 <strong style={{ color: '#e4e4e7' }}>Evidence bundles — Business plan required.</strong> Signed, tamper-evident exports of the team's
          audit chain for any reporting period: every validation, approval and policy change, verifiable offline.{' '}
          <a href="#/pricing" style={{ color: '#a78bfa' }}>Upgrade →</a>
        </div>
      </div>
    );
  }

  return (
    <div style={card}>
      <p style={{ color: '#a1a1aa', fontSize: 12.5, marginTop: 0 }}>
        A bundle is a signed snapshot of the audit chain for a period — validations, approvals, rule and membership changes — with a
        standalone verifier. Regenerated from the chain on every download, so a download that fails is itself a finding.
        {list?.signing_key && (
          <> Signing key v{list.signing_key.version} · fingerprint <code style={{ color: '#a78bfa' }}>{list.signing_key.fingerprint.slice(0, 16)}…</code></>
        )}
      </p>
      {error && <p style={{ color: '#f87171', fontSize: 12.5 }}>{error}</p>}

      {list?.can_generate && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
          <label style={lbl}>From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={inp} /></label>
          <label style={lbl}>To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={inp} /></label>
          <button type="button" onClick={() => void generate()} disabled={busy === 'generate' || !from || !to || to < from} style={btn}>
            {busy === 'generate' ? 'Generating…' : 'Generate bundle'}
          </button>
        </div>
      )}
      {notice && <div style={{ fontSize: 12.5, color: notice.startsWith('✓') ? '#22c55e' : '#f59e0b', marginBottom: 8 }}>{notice}</div>}

      {list && list.rows.length === 0 && <p style={{ color: '#71717a', fontSize: 13, margin: 0 }}>No bundles yet.</p>}
      {list?.rows.map((b) => {
        const v = verification[b.id];
        return (
          <div key={b.id} style={{ padding: '10px 0', borderTop: '1px solid #27272a' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={{ fontSize: 13.5 }}>
                  {b.period_from.slice(0, 10)} → {b.period_to.slice(0, 10)}
                  <span style={{ color: '#71717a', fontSize: 11.5 }}> · {b.event_count} events · {b.validation_count} validations · {b.approval_count} approvals · seq {b.chain_from_seq}–{b.chain_to_seq}</span>
                </div>
                <div style={{ fontSize: 11.5, color: '#71717a' }}>
                  Generated {fmt(b.created_at)} by {b.generated_by_email ?? b.generated_by} ({b.generated_by_role}) · key v{b.signing_key_version} · hash{' '}
                  <code>{b.bundle_hash.slice(0, 12)}…</code>
                </div>
              </div>
              <button type="button" onClick={() => void download(b)} disabled={busy === `dl:${b.id}`} style={btn}>
                {busy === `dl:${b.id}` ? 'Preparing…' : 'Download .zip'}
              </button>
              <button type="button" onClick={() => void verify(b)} disabled={busy === `vf:${b.id}`} style={ghost}>
                {busy === `vf:${b.id}` ? 'Verifying…' : 'Verify'}
              </button>
            </div>
            {v && (
              <div style={{ marginTop: 6, fontSize: 12, color: v.ok ? '#22c55e' : '#f87171' }}>
                {v.ok ? '✓ Verified' : '✗ Verification failed'} — hash {v.bundle_hash.matches ? 'matches' : 'MISMATCH'} · signature{' '}
                {v.signature.valid === true ? 'valid' : v.signature.valid === false ? 'INVALID' : 'unavailable'} (key v{v.signature.key_version}
                {v.signature.key_active === false ? ', rotated' : ''}) · chain {v.chain.local.ok && v.chain.db.ok ? 'intact' : 'BROKEN'}
                {v.chain.agree ? '' : ' · db/local DISAGREE'} · {v.event_count.recomputed}/{v.event_count.stored} events · {fmt(v.checked_at)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const card: React.CSSProperties = { border: '1px solid #27272a', borderRadius: 8, padding: 16, background: '#18181b', marginTop: 10 };
const inp: React.CSSProperties = { background: '#0f0f11', color: '#e4e4e7', border: '1px solid #27272a', borderRadius: 6, padding: '6px 8px', fontSize: 12.5, marginLeft: 6 };
const lbl: React.CSSProperties = { fontSize: 12.5, color: '#a1a1aa' };
const btn: React.CSSProperties = { background: '#7c3aed', color: 'white', border: 'none', borderRadius: 6, padding: '7px 12px', fontWeight: 600, fontSize: 12.5, cursor: 'pointer' };
const ghost: React.CSSProperties = { background: 'transparent', color: '#a1a1aa', border: '1px solid #3f3f46', borderRadius: 6, padding: '6px 10px', fontSize: 12, cursor: 'pointer' };
