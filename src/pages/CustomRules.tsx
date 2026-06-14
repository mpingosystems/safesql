import { useState } from 'react';
import { useAppUser } from '../hooks/useAppUser';
import { validateSQL } from '../services/sqlValidator';
import { apiUrl } from '../config/api';
import type { SuggestedRule } from '../services/ruleSuggestion';
import type { CustomRule, CustomRuleType } from '../types/validation';

// Sprint 8 Part 5 — custom rules authoring at /team/rules (Business tier).
// v1: build a rule + test it live against a sample query (the engine runs
// client-side). Persistence to custom_rules is wired once the migration is
// applied; this page focuses on authoring + the "test rule" loop.
const RULE_TYPES: { value: CustomRuleType; label: string; fields: string[] }[] = [
  { value: 'required_filter', label: 'Required filter (table + column)', fields: ['table', 'column'] },
  { value: 'forbidden_table', label: 'Forbidden table', fields: ['table'] },
  { value: 'required_join_condition', label: 'Required join condition', fields: ['table', 'required_column'] },
  { value: 'forbidden_pattern', label: 'Forbidden pattern (regex)', fields: ['pattern'] },
  { value: 'required_column_qualification', label: 'Require column qualification', fields: ['table'] },
];

export function CustomRulesPage() {
  const { appUser } = useAppUser();
  const isBusiness = !!appUser && ['business', 'enterprise'].includes(appUser.plan);

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

  if (!isBusiness) {
    return (
      <Shell>
        <h1 style={{ fontSize: 22 }}>Custom Rules</h1>
        <p style={{ color: '#a1a1aa' }}>Custom rules are a Business feature. <a href="#/pricing" style={{ color: '#a78bfa' }}>Upgrade →</a></p>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 style={{ fontSize: 22 }}>Custom Rules</h1>
      <p style={{ color: '#a1a1aa', fontSize: 13 }}>Encode your team's SQL policy on top of the 33+ semantic detectors.</p>

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
        <div style={{ marginTop: 8, display: 'flex', gap: 10, alignItems: 'center' }}>
          <button type="button" onClick={testRule} style={btn}>Test rule</button>
          {result && <span style={{ color: result.startsWith('✓') ? '#22c55e' : '#71717a', fontSize: 13 }}>{result}</span>}
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
const btn: React.CSSProperties = { background: '#7c3aed', color: 'white', border: 'none', borderRadius: 6, padding: '7px 14px', fontWeight: 600, fontSize: 13, cursor: 'pointer' };
