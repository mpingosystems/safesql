import { useState } from 'react';
import { useAppUser } from '../hooks/useAppUser';
import { useCustomRules } from '../hooks/useCustomRules';
import { createRule, deleteRule, updateRule, type TeamRule } from '../services/rulesApi';
import { validateSQL } from '../services/sqlValidator';
import { apiUrl } from '../config/api';
import type { SuggestedRule } from '../services/ruleSuggestion';
import type { CustomRule, CustomRuleType } from '../types/validation';
import { TOTAL_DETECTORS } from '../config/detectorTiers';

// Sprint 8 Part 5 — custom rules authoring at /team/rules.
// v1 built a rule + tested it live against a sample query (engine client-side).
//
// Sprint 9 (compliance): rules are now team POLICY, saved through
// /api/teams/rules (owner / manager), listed for every seat, toggled
// (soft delete) or deleted (owner, hard delete) — every change lands on the
// team's tamper-evident chain. Authoring is Team+; the API/CI enforce the
// rules on Business+ and this page says which is the case.
const RULE_TYPES: { value: CustomRuleType; label: string; fields: string[] }[] = [
  { value: 'required_filter', label: 'Required filter (table + column)', fields: ['table', 'column'] },
  { value: 'forbidden_table', label: 'Forbidden table', fields: ['table'] },
  { value: 'required_join_condition', label: 'Required join condition', fields: ['table', 'required_column'] },
  { value: 'forbidden_pattern', label: 'Forbidden pattern (regex)', fields: ['pattern'] },
  { value: 'required_column_qualification', label: 'Require column qualification', fields: ['table'] },
];

export function CustomRulesPage() {
  const { appUser } = useAppUser();
  const isBusiness = !!appUser && ['team', 'business', 'enterprise'].includes(appUser.plan);
  const { all: savedRules, enforcedInApi, canWrite, myRole, refresh, error: rulesError } = useCustomRules();
  const isOwner = myRole === 'owner';
  const [severity, setSeverity] = useState<'error' | 'warning' | 'suggestion'>('warning');
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyRule, setBusyRule] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [ruleType, setRuleType] = useState<CustomRuleType>('required_filter');
  const [cfg, setCfg] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [testSql, setTestSql] = useState("SELECT id FROM orders WHERE status = 'x'");
  const [result, setResult] = useState<string | null>(null);

  // NL rule authoring (Sprint 11 P4) — Claude drafts the rule config; deterministic
  // engine still does all detection.
  const [nlDesc, setNlDesc] = useState('');
  const [nlKey, setNlKey] = useState('');
  const [nlBusy, setNlBusy] = useState(false);
  const [nlMsg, setNlMsg] = useState<string | null>(null);

  const applyRule = (rule: SuggestedRule) => {
    setName(rule.name || rule.description || '');
    setRuleType(rule.rule_type);
    const cfgObj = rule.config as Record<string, unknown>;
    const rest: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfgObj)) {
      if (k !== 'message' && typeof v === 'string') rest[k] = v;
    }
    setCfg(rest);
    setMessage(typeof cfgObj.message === 'string' ? cfgObj.message : rule.description || '');
  };

  const generateRule = async () => {
    if (!nlDesc.trim() || !nlKey.trim()) {
      setNlMsg('Enter a description and your API key.');
      return;
    }
    setNlBusy(true);
    setNlMsg(null);
    try {
      const res = await fetch(apiUrl('/api/rules/suggest'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${nlKey.trim()}` },
        body: JSON.stringify({ description: nlDesc }),
      });
      const data = (await res.json()) as { rule?: SuggestedRule; error?: string };
      if (res.ok && data.rule) {
        applyRule(data.rule);
        setNlMsg('✓ Rule drafted below — review and save.');
      } else {
        setNlMsg(data.error ?? 'Could not generate a rule.');
      }
    } catch {
      setNlMsg('Network error.');
    } finally {
      setNlBusy(false);
    }
  };

  const fields = RULE_TYPES.find((r) => r.value === ruleType)!.fields;

  const testRule = () => {
    const rule: CustomRule = {
      id: 'test', name: name || 'Test rule', rule_type: ruleType,
      config: { ...cfg, message }, severity: 'warning', active: true,
    };
    const report = validateSQL({ sql: testSql, dialect: 'postgresql', customRules: [rule] });
    const fired = [...report.errors, ...report.warnings, ...report.suggestions].some((i) => i.id === 'CUSTOM_RULE');
    setResult(fired ? '✓ Rule fires on this query' : '○ Rule does not fire');
  };

  const saveRule = async () => {
    setSaving(true);
    setSaveMsg(null);
    const res = await createRule({ name, rule_type: ruleType, config: { ...cfg, ...(message ? { message } : {}) }, severity });
    setSaving(false);
    if (!res.ok) {
      setSaveMsg(`Could not save: ${res.error}`);
      return;
    }
    setSaveMsg(`✓ Saved "${res.rule.name}"${res.event_seq ? ` — chain #${res.event_seq}` : ''}`);
    setName('');
    setCfg({});
    setMessage('');
    await refresh();
  };

  const toggleRule = async (r: TeamRule) => {
    setBusyRule(r.id);
    const res = await updateRule(r.id, { active: !(r.active !== false) });
    if (!res.ok) setSaveMsg(`Could not update: ${res.error}`);
    setBusyRule(null);
    await refresh();
  };

  const removeRule = async (r: TeamRule) => {
    if (!window.confirm(`Delete "${r.name}" permanently? The rule's full definition is retained on the audit chain.`)) return;
    setBusyRule(r.id);
    const res = await deleteRule(r.id);
    if (!res.ok) setSaveMsg(`Could not delete: ${res.error}`);
    setBusyRule(null);
    await refresh();
  };

  if (!isBusiness) {
    return (
      <Shell>
        <h1 style={{ fontSize: 22 }}>Custom Rules</h1>
        <p style={{ color: '#a1a1aa' }}>Custom rules are a Team feature (enforced in CI and the API on Business). <a href="#/pricing" style={{ color: '#a78bfa' }}>Upgrade →</a></p>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 style={{ fontSize: 22 }}>Custom Rules</h1>
      <p style={{ color: '#a1a1aa', fontSize: 13 }}>Encode your team's SQL policy on top of the {TOTAL_DETECTORS} semantic detectors.</p>
      <div style={{ ...card, borderColor: enforcedInApi ? '#166534' : '#78350f', fontSize: 12.5, color: '#d4d4d8' }}>
        {enforcedInApi
          ? '✓ Enforced everywhere: these rules run in the editor and in every API, CI and dbt validation for your team.'
          : 'Rules run in the editor for your team. Enforcement in the API, GitHub Action and dbt-safesql requires the Business plan.'}
        {' '}<a href="#/pricing" style={{ color: '#a78bfa' }}>{enforcedInApi ? '' : 'Upgrade →'}</a>
      </div>

      <h2 style={{ fontSize: 14, color: '#a1a1aa', marginTop: 16 }}>Team rules ({savedRules.length})</h2>
      <div style={card}>
        {rulesError && <p style={{ color: '#f87171', fontSize: 12.5, marginTop: 0 }}>{rulesError}</p>}
        {savedRules.length === 0 ? (
          <p style={{ color: '#71717a', fontSize: 13, margin: 0 }}>No rules saved yet. Build one below and save it.</p>
        ) : (
          savedRules.map((r) => (
            <div key={r.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #27272a', opacity: r.active === false ? 0.55 : 1 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5 }}>
                  {r.name}{' '}
                  <span style={{ color: '#71717a', fontSize: 11.5 }}>· {r.rule_type} · {r.severity ?? 'warning'}{r.active === false ? ' · inactive' : ''}</span>
                </div>
                <div style={{ fontSize: 11.5, color: '#71717a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {Object.entries(r.config).filter(([k]) => k !== 'message').map(([k, v]) => `${k}=${String(v)}`).join('  ')}
                  {r.created_by_email ? ` · by ${r.created_by_email}` : ''}{r.last_event_seq ? ` · chain #${r.last_event_seq}` : ''}
                </div>
              </div>
              {canWrite && (
                <button type="button" onClick={() => void toggleRule(r)} disabled={busyRule === r.id} style={ghostBtn}>
                  {r.active === false ? 'Activate' : 'Deactivate'}
                </button>
              )}
              {isOwner && (
                <button type="button" onClick={() => void removeRule(r)} disabled={busyRule === r.id} style={{ ...ghostBtn, color: '#f87171', borderColor: '#7f1d1d' }}>
                  Delete
                </button>
              )}
            </div>
          ))
        )}
        {saveMsg && <div style={{ marginTop: 8, fontSize: 12.5, color: saveMsg.startsWith('✓') ? '#22c55e' : '#f59e0b' }}>{saveMsg}</div>}
      </div>

      <h2 style={{ fontSize: 14, color: '#a1a1aa', marginTop: 16 }}>Describe a rule</h2>
      <div style={card}>
        <p style={{ color: '#a1a1aa', fontSize: 12.5, marginTop: 0 }}>
          Describe your SQL policy in plain English — Claude drafts the rule config below
          for you to review. AI assists authoring only; detection stays deterministic.
        </p>
        <textarea
          value={nlDesc}
          onChange={(e) => setNlDesc(e.target.value)}
          placeholder="Never query the payments table without filtering by tenant_id"
          style={{ ...inp, minHeight: 56 }}
        />
        <input
          type="password"
          value={nlKey}
          onChange={(e) => setNlKey(e.target.value)}
          placeholder="Your API key (ssk_live_…)"
          autoComplete="new-password"
          style={{ ...inp, marginTop: 8 }}
        />
        <div style={{ marginTop: 8, display: 'flex', gap: 10, alignItems: 'center' }}>
          <button type="button" onClick={() => void generateRule()} disabled={nlBusy} style={btn}>
            {nlBusy ? 'Generating…' : 'Generate rule →'}
          </button>
          {nlMsg && <span style={{ fontSize: 12, color: nlMsg.startsWith('✓') ? '#22c55e' : '#f59e0b' }}>{nlMsg}</span>}
        </div>
      </div>

      <h2 style={{ fontSize: 14, color: '#a1a1aa', marginTop: 16 }}>Rule</h2>
      <div style={card}>
        <Row label="Name"><input value={name} onChange={(e) => setName(e.target.value)} style={inp} placeholder="Tenant filter" /></Row>
        <Row label="Type">
          <select value={ruleType} onChange={(e) => { setRuleType(e.target.value as CustomRuleType); setCfg({}); }} style={inp}>
            {RULE_TYPES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </Row>
        {fields.map((f) => (
          <Row key={f} label={f}><input value={cfg[f] ?? ''} onChange={(e) => setCfg({ ...cfg, [f]: e.target.value })} style={inp} placeholder={f} /></Row>
        ))}
        <Row label="Message"><input value={message} onChange={(e) => setMessage(e.target.value)} style={inp} placeholder="Always filter orders by tenant_id" /></Row>
      </div>

      <h2 style={{ fontSize: 14, color: '#a1a1aa', marginTop: 20 }}>Test rule</h2>
      <div style={card}>
        <textarea value={testSql} onChange={(e) => setTestSql(e.target.value)} style={{ ...inp, minHeight: 70, fontFamily: 'monospace' }} />
        <div style={{ marginTop: 8, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" onClick={testRule} style={btn}>Test rule</button>
          {result && <span style={{ color: result.startsWith('✓') ? '#22c55e' : '#71717a', fontSize: 13 }}>{result}</span>}
          {canWrite && (
            <>
              <select value={severity} onChange={(e) => setSeverity(e.target.value as 'error' | 'warning' | 'suggestion')} style={{ ...inp, width: 'auto' }}>
                <option value="error">error</option>
                <option value="warning">warning</option>
                <option value="suggestion">suggestion</option>
              </select>
              <button type="button" onClick={() => void saveRule()} disabled={saving || !name.trim()} style={btn}>
                {saving ? 'Saving…' : 'Save rule'}
              </button>
            </>
          )}
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ background: '#09090b', color: '#e4e4e7', minHeight: '100vh', padding: 32 }}>
      <a href="#/editor" style={{ color: '#a78bfa', textDecoration: 'none', fontSize: 13 }}>← Editor</a>
      <div style={{ maxWidth: 700, margin: '20px auto 0' }}>{children}</div>
    </div>
  );
}
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={{ display: 'block', marginBottom: 10 }}><div style={{ fontSize: 11, color: '#71717a', textTransform: 'uppercase', marginBottom: 3 }}>{label}</div>{children}</label>;
}
const card: React.CSSProperties = { border: '1px solid #27272a', borderRadius: 8, padding: 16, background: '#18181b', marginTop: 10 };
const inp: React.CSSProperties = { width: '100%', background: '#0a0a0a', color: '#e4e4e7', border: '1px solid #27272a', borderRadius: 5, padding: '7px 10px', fontSize: 13 };
const ghostBtn: React.CSSProperties = { background: 'transparent', color: '#a1a1aa', border: '1px solid #3f3f46', borderRadius: 6, padding: '5px 10px', fontSize: 12, cursor: 'pointer' };
const btn: React.CSSProperties = { background: '#7c3aed', color: 'white', border: 'none', borderRadius: 6, padding: '7px 14px', fontWeight: 600, fontSize: 13, cursor: 'pointer' };
