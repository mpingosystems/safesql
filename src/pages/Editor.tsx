import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  SchemaDefinition,
  SqlSource,
  ValidationIssue,
  ValidationReport as Report,
} from '../types/validation';
import { SqlEditor } from '../components/SqlEditor';
import { SchemaPanel } from '../components/SchemaPanel';
import { ValidationReport } from '../components/ValidationReport';
import { SandboxPanel } from '../components/SandboxPanel';
import { UpgradeBanner } from '../components/UpgradeBanner';
import { SaveQueryButton } from '../components/SaveQueryButton';
import { validateSQL } from '../services/sqlValidator';
import { parseDDL } from '../services/schemaParser';
import { enrichWithAIExplanations } from '../services/aiExplainer';
import { persistValidation } from '../services/persistValidation';
import { applyFix, canApplyFix } from '../services/applyFix';
import { AuthControls } from '../components/AuthControls';
import { useAppUser, isOverValidationLimit, FREE_LIMITS } from '../hooks/useAppUser';
import { useTeam } from '../hooks/useTeam';
import { createApprovalRequest } from '../services/approvals';

type Dialect = 'postgresql' | 'mysql' | 'bigquery' | 'snowflake';

const SUPPORTED_DIALECTS: readonly Dialect[] = ['postgresql', 'mysql', 'bigquery', 'snowflake'];
const DIALECT_STORAGE_KEY = 'safesql.dialect';

function loadInitialDialect(): Dialect {
  if (typeof window === 'undefined') return 'postgresql';
  try {
    const stored = window.sessionStorage.getItem(DIALECT_STORAGE_KEY);
    if (stored && (SUPPORTED_DIALECTS as readonly string[]).includes(stored)) {
      return stored as Dialect;
    }
  } catch {
    // sessionStorage may be unavailable (private mode quotas, SSR-style stubs)
  }
  return 'postgresql';
}

const DEFAULT_SQL = `-- Monthly revenue by plan — for the board deck
-- Looks right. Ran without errors. Numbers are wrong by 3-10x.
SELECT
  c.plan,
  DATE_TRUNC('month', p.paid_at) AS month,
  SUM(p.amount) AS total_revenue,
  COUNT(DISTINCT c.id) AS paying_customers
FROM customers c
JOIN subscriptions s ON s.customer_id = c.id
JOIN payments p ON p.customer_id = c.id
WHERE p.status = 'succeeded'
  AND p.paid_at >= '2026-01-01'
GROUP BY c.plan, DATE_TRUNC('month', p.paid_at)
ORDER BY month DESC, total_revenue DESC;`;

const DEFAULT_DDL = `CREATE TABLE customers (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL,
  country TEXT,
  plan TEXT CHECK (plan IN ('free','pro','business')),
  created_at DATE
);

CREATE TABLE subscriptions (
  id UUID PRIMARY KEY,
  customer_id UUID REFERENCES customers(id),
  plan TEXT,
  amount NUMERIC(10,2),
  status TEXT CHECK (status IN ('active','cancelled','past_due')),
  started_at DATE,
  cancelled_at DATE
);

CREATE TABLE payments (
  id UUID PRIMARY KEY,
  subscription_id UUID REFERENCES subscriptions(id),
  customer_id UUID REFERENCES customers(id),
  amount NUMERIC(10,2),
  status TEXT CHECK (status IN ('succeeded','failed','refunded')),
  paid_at DATE
);`;

const navLink: React.CSSProperties = {
  color: '#a1a1aa',
  textDecoration: 'none',
  fontSize: 12,
  fontWeight: 600,
};

// Team dropdown — only rendered for Team+ plans (see nav). Custom Rules is
// Business-only. Click to toggle, closes on outside-click or item select.
function TeamMenu({ plan }: { plan: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const items = [
    { label: 'Members', href: '#/team/members' },
    { label: 'Analytics', href: '#/team/analytics' },
    { label: 'Approvals', href: '#/team/approvals' },
    { label: 'Audit Log', href: '#/team/audit' },
    ...(plan === 'business' ? [{ label: 'Custom Rules', href: '#/team/rules' }] : []),
  ];

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{ ...navLink, background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}
      >
        Team ▾
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: 8,
            minWidth: 150,
            background: '#18181b',
            border: '1px solid #27272a',
            borderRadius: 8,
            padding: 6,
            zIndex: 20,
            display: 'flex',
            flexDirection: 'column',
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
          }}
        >
          {items.map((it) => (
            <a
              key={it.href}
              href={it.href}
              role="menuitem"
              onClick={() => setOpen(false)}
              style={{ color: '#d4d4d8', textDecoration: 'none', fontSize: 12.5, padding: '6px 10px', borderRadius: 5 }}
            >
              {it.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// "Open in SafeSQL" (from a shared link) and legacy hash permalinks stash the
// SQL here, then bounce to the editor; we pick it up once on mount.
function loadInitialSql(): string {
  if (typeof window === 'undefined') return DEFAULT_SQL;
  try {
    const preload = window.sessionStorage.getItem('safesql.preloadSql');
    if (preload) {
      window.sessionStorage.removeItem('safesql.preloadSql');
      return preload;
    }
  } catch {
    // sessionStorage may be unavailable
  }
  return DEFAULT_SQL;
}

// Query Library "open in editor" stashes the schema DDL here alongside the SQL.
function loadInitialDdl(): string {
  if (typeof window === 'undefined') return DEFAULT_DDL;
  try {
    const preload = window.sessionStorage.getItem('safesql.preloadDdl');
    if (preload) {
      window.sessionStorage.removeItem('safesql.preloadDdl');
      return preload;
    }
  } catch {
    // sessionStorage may be unavailable
  }
  return DEFAULT_DDL;
}

export function EditorPage() {
  const [sql, setSql] = useState(loadInitialSql);
  const [ddl, setDdl] = useState(loadInitialDdl);
  // Parse the initial DDL (the pre-loaded demo, or a Query Library preload) so
  // the schema panel is populated and the auto-validate below has cardinality.
  const [schema, setSchema] = useState<SchemaDefinition | null>(() => {
    try {
      return ddl.trim() ? parseDDL(ddl) : null;
    } catch {
      return null;
    }
  });
  const [activeSchemaId, setActiveSchemaId] = useState<string | null>(null);
  const [dialect, setDialect] = useState<Dialect>(loadInitialDialect);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(DIALECT_STORAGE_KEY, dialect);
    } catch {
      // ignore storage failures
    }
  }, [dialect]);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [source, setSource] = useState<SqlSource>('manual');
  const [report, setReport] = useState<Report | null>(null);
  const [lastValidatedAt, setLastValidatedAt] = useState<Date | null>(null);
  const [clearSignal, setClearSignal] = useState(0);

  // Auto-validate the pre-loaded demo on first mount so a visitor immediately
  // sees the fan-out detection. Local + deterministic — not persisted, doesn't
  // count against the user's monthly quota.
  useEffect(() => {
    if (sql.trim()) {
      setReport(validateSQL({ sql, schema: schema ?? undefined, dialect, source }));
      setLastValidatedAt(new Date());
    }
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { appUser, refresh: refreshAppUser } = useAppUser();
  const { team } = useTeam();
  const overLimit = isOverValidationLimit(appUser);
  const isPro = !!appUser && appUser.plan !== 'free';

  // Sprint 10 — request approval for a risky query (team users only).
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [approvalNote, setApprovalNote] = useState('');
  const [approvalMsg, setApprovalMsg] = useState<string | null>(null);

  const submitApproval = useCallback(async () => {
    if (!appUser?.id || !report) return;
    const res = await createApprovalRequest({
      teamId: team?.id ?? appUser.id,
      requesterId: appUser.email || appUser.id,
      sql,
      ddl,
      dialect,
      report,
      note: approvalNote.trim() || undefined,
    });
    setApprovalMsg(res ? '✓ Approval request sent to your team.' : 'Could not send request (is the migration applied?).');
    if (res) {
      setApprovalNote('');
      setTimeout(() => { setApprovalOpen(false); setApprovalMsg(null); }, 1200);
    }
  }, [appUser, report, team?.id, sql, ddl, dialect, approvalNote]);

  const runValidation = useCallback(async () => {
    if (overLimit) return; // hard block when free-tier limit reached

    // Clear stale results BEFORE running the new pass so the panel doesn't
    // briefly show last validation's errors against this validation's SQL.
    setReport(null);

    let next = validateSQL({ sql, schema: schema ?? undefined, dialect, source });
    setReport(next);
    setLastValidatedAt(new Date());

    if (aiEnabled && (next.errors.length > 0 || next.warnings.length > 0)) {
      const enriched = await enrichWithAIExplanations(next, sql, schema ?? undefined);
      setReport({ ...enriched });
      next = enriched;
    }

    // Fire-and-forget persistence (no await on the validate path).
    if (appUser?.id) {
      void persistValidation({
        appUserId: appUser.id,
        sql,
        report: next,
        schemaId: activeSchemaId ?? undefined,
        dialect,
      }).then((ok) => {
        if (ok) void refreshAppUser(); // pull updated count
      });
    }
  }, [sql, schema, dialect, source, aiEnabled, appUser, activeSchemaId, refreshAppUser, overLimit]);

  // PQ4 — apply a mechanical fix, rewrite the editor, and re-validate.
  const handleApplyFix = useCallback(
    (issue: ValidationIssue) => {
      const next = applyFix(sql, issue);
      if (!next || next === sql) return;
      setSql(next);
      const nextReport = validateSQL({ sql: next, schema: schema ?? undefined, dialect, source });
      setReport(nextReport);
      setLastValidatedAt(new Date());
      if (appUser?.id && !overLimit) {
        void persistValidation({
          appUserId: appUser.id,
          sql: next,
          report: nextReport,
          schemaId: activeSchemaId ?? undefined,
          dialect,
        }).then((ok) => {
          if (ok) void refreshAppUser();
        });
      }
    },
    [sql, schema, dialect, source, appUser, overLimit, activeSchemaId, refreshAppUser],
  );

  // "Fix Issues First" — apply every auto-fixable error in one pass, then
  // re-validate. canApplyFix gates which errors have a deterministic rewrite
  // (only those are applied; the rest still need a manual fix).
  const handleFixIssues = useCallback(() => {
    if (!report) return;
    let next = sql;
    for (const issue of report.errors.filter(canApplyFix)) {
      const fixed = applyFix(next, issue);
      if (fixed && fixed !== next) next = fixed;
    }
    if (next === sql) return;
    setSql(next);
    const nextReport = validateSQL({ sql: next, schema: schema ?? undefined, dialect, source });
    setReport(nextReport);
    setLastValidatedAt(new Date());
    if (appUser?.id && !overLimit) {
      void persistValidation({
        appUserId: appUser.id,
        sql: next,
        report: nextReport,
        schemaId: activeSchemaId ?? undefined,
        dialect,
      }).then((ok) => {
        if (ok) void refreshAppUser();
      });
    }
  }, [report, sql, schema, dialect, source, appUser, overLimit, activeSchemaId, refreshAppUser]);

  const handleValidationFromEditor = (next: Report) => {
    setReport(next);
    setLastValidatedAt(new Date());
    if (appUser?.id && !overLimit) {
      void persistValidation({
        appUserId: appUser.id,
        sql,
        report: next,
        schemaId: activeSchemaId ?? undefined,
        dialect,
      }).then((ok) => {
        if (ok) void refreshAppUser();
      });
    }
  };

  const handleClear = useCallback(() => {
    setSql('');
    setReport(null);
    setLastValidatedAt(null);
    setClearSignal((n) => n + 1);
  }, []);

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '280px 1fr 360px',
        gridTemplateRows: 'auto minmax(0, 1fr) auto auto',
        gridTemplateAreas: `
          "header header header"
          "left   center right"
          "left   sandbox right"
          "footer footer footer"
        `,
        height: '100vh',
        background: '#09090b',
        color: '#e4e4e7',
      }}
    >
      <header
        style={{
          gridArea: 'header',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 16px',
          borderBottom: '1px solid #27272a',
          background: '#0f0f10',
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <a
            href="#/"
            style={{
              fontWeight: 700,
              color: '#a78bfa',
              textDecoration: 'none',
              fontSize: 15,
              letterSpacing: -0.3,
            }}
          >
            SafeSQL Pro
          </a>
          <span style={{ color: '#52525b', fontSize: 11 }}>v0.8.0</span>
          {appUser && (
            <UsageMeter
              count={appUser.validations_this_month}
              limit={FREE_LIMITS.validations}
              plan={appUser.plan}
            />
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          {report && appUser?.id && (
            <SaveQueryButton
              userId={appUser.id}
              sql={sql}
              ddl={ddl || undefined}
              dialect={dialect}
              riskScore={report.riskScore}
            />
          )}
          <a href="#/library" style={navLink}>Library</a>
          <a href="#/analytics" style={navLink}>Analytics</a>
          {appUser && (appUser.plan === 'team' || appUser.plan === 'business') && (
            <TeamMenu plan={appUser.plan} />
          )}
          <a href="#/settings" style={navLink}>Settings</a>
          <a href="#/blog" style={navLink}>Blog</a>
          <a href="#/pricing" style={navLink}>Pricing</a>
          <AuthControls />
        </div>
      </header>

      <aside style={{ gridArea: 'left', overflow: 'hidden' }}>
        <SchemaPanel
          schema={schema}
          onSchemaChange={setSchema}
          ddl={ddl}
          onDdlChange={setDdl}
          appUserId={appUser?.id ?? null}
          activeSchemaId={activeSchemaId}
          onActiveSchemaChange={setActiveSchemaId}
        />
      </aside>

      <main
        style={{
          gridArea: 'center',
          overflow: 'hidden',
          borderRight: '1px solid #27272a',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {overLimit && (
          <div style={{ padding: 14, borderBottom: '1px solid #27272a', background: '#1e1b4b' }}>
            <UpgradeBanner
              plan="pro"
              cadence="monthly"
              reason={`You've used ${appUser?.validations_this_month}/${FREE_LIMITS.validations} validations this month.`}
            />
          </div>
        )}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '8px 12px',
            borderBottom: '1px solid #27272a',
            background: '#0f0f10',
          }}
        >
          <button
            type="button"
            onClick={() => void runValidation()}
            disabled={overLimit}
            title={overLimit ? `Free tier limit (${FREE_LIMITS.validations}/mo) reached` : undefined}
            style={{
              background: overLimit ? '#3f3f46' : '#7c3aed',
              color: 'white',
              border: 'none',
              borderRadius: 5,
              padding: '6px 14px',
              fontSize: 12,
              fontWeight: 600,
              cursor: overLimit ? 'not-allowed' : 'pointer',
              opacity: overLimit ? 0.6 : 1,
            }}
          >
            Validate
          </button>
          <button
            type="button"
            onClick={handleClear}
            style={{
              background: 'transparent',
              color: '#a1a1aa',
              border: '1px solid #27272a',
              borderRadius: 5,
              padding: '6px 12px',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Clear
          </button>
          <label style={{ fontSize: 12, color: '#a1a1aa', marginLeft: 16 }}>
            Dialect:{' '}
            <select
              value={dialect}
              onChange={(e) => setDialect(e.target.value as Dialect)}
              style={{
                background: '#18181b',
                color: '#e4e4e7',
                border: '1px solid #27272a',
                padding: '4px 8px',
                borderRadius: 4,
                fontSize: 12,
              }}
            >
              <option value="postgresql">PostgreSQL</option>
              <option value="mysql">MySQL</option>
              <option value="bigquery">BigQuery</option>
              <option value="snowflake">Snowflake</option>
            </select>
          </label>
          <label style={{ fontSize: 12, color: '#a1a1aa' }}>
            Source:{' '}
            <select
              value={source}
              onChange={(e) => setSource(e.target.value as SqlSource)}
              title="Tag where this SQL came from (PQ1 — tracks AI vs human quality)"
              style={{
                background: '#18181b',
                color: '#e4e4e7',
                border: '1px solid #27272a',
                padding: '4px 8px',
                borderRadius: 4,
                fontSize: 12,
              }}
            >
              <option value="manual">Hand-written</option>
              <option value="cursor">Cursor</option>
              <option value="copilot">Copilot</option>
              <option value="chatgpt">ChatGPT</option>
              <option value="unknown">Unknown</option>
            </select>
          </label>
          <span style={{ color: '#52525b', fontSize: 11, marginLeft: 'auto' }}>
            Ctrl+S to validate
          </span>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <SqlEditor
            value={sql}
            onChange={setSql}
            onValidate={handleValidationFromEditor}
            onValidateStart={() => setReport(null)}
            schema={schema ?? undefined}
            dialect={dialect}
            source={source}
            aiEnabled={aiEnabled}
            clearSignal={clearSignal}
          />
        </div>
      </main>

      <aside
        style={{
          gridArea: 'right',
          background: '#0f0f10',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <ValidationReport
          report={report}
          sql={sql}
          ddl={ddl}
          schema={schema}
          dialect={dialect}
          isPro={isPro}
          onApplyFix={handleApplyFix}
          onFixIssues={handleFixIssues}
          onRequestApproval={team ? () => { setApprovalMsg(null); setApprovalOpen(true); } : undefined}
        />
      </aside>

      <section
        style={{
          gridArea: 'sandbox',
          maxHeight: 360,
          overflowY: 'auto',
          borderTop: '1px solid #27272a',
          borderRight: '1px solid #27272a',
        }}
      >
        <SandboxPanel sql={sql} schema={schema} ddl={ddl} activeSchemaId={activeSchemaId} />
      </section>

      <footer
        style={{
          gridArea: 'footer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 16px',
          borderTop: '1px solid #27272a',
          background: '#0a0a0a',
          fontSize: 11,
          color: '#71717a',
        }}
      >
        <div>
          {lastValidatedAt
            ? `Validated ${lastValidatedAt.toLocaleTimeString()}`
            : 'Not yet validated'}
          {report && ` · ${report.processingMs.toFixed(0)}ms`}
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={aiEnabled}
            onChange={(e) => setAiEnabled(e.target.checked)}
          />
          AI explanations: {aiEnabled ? 'on' : 'off'}
        </label>
      </footer>

      {approvalOpen && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 }}
          onClick={() => setApprovalOpen(false)}
        >
          <div
            style={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 10, padding: 18, width: 420, maxWidth: '92vw' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Request approval</div>
            <p style={{ color: '#a1a1aa', fontSize: 12.5, marginTop: 0 }}>
              This query scored {report?.riskScore}. Send it to your team's approval inbox with an optional note.
            </p>
            <textarea
              value={approvalNote}
              onChange={(e) => setApprovalNote(e.target.value)}
              placeholder="Why this query needs to run despite the warnings…"
              style={{ width: '100%', minHeight: 70, background: '#0a0a0a', color: '#e4e4e7', border: '1px solid #27272a', borderRadius: 6, padding: 8, fontSize: 12.5 }}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', marginTop: 10 }}>
              {approvalMsg && <span style={{ fontSize: 12, color: approvalMsg.startsWith('✓') ? '#22c55e' : '#f59e0b', marginRight: 'auto' }}>{approvalMsg}</span>}
              <button type="button" onClick={() => setApprovalOpen(false)} style={{ background: 'transparent', color: '#a1a1aa', border: '1px solid #3f3f46', borderRadius: 5, padding: '6px 14px', fontSize: 12.5, cursor: 'pointer' }}>Cancel</button>
              <button type="button" onClick={() => void submitApproval()} style={{ background: '#7c3aed', color: 'white', border: 'none', borderRadius: 5, padding: '6px 14px', fontWeight: 600, fontSize: 12.5, cursor: 'pointer' }}>Submit request</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function UsageMeter({ count, limit, plan }: { count: number; limit: number; plan: string }) {
  if (plan !== 'free') {
    return (
      <span
        style={{
          fontSize: 10,
          padding: '2px 8px',
          borderRadius: 999,
          background: '#7c3aed',
          color: 'white',
          fontWeight: 600,
          letterSpacing: 0.5,
          textTransform: 'uppercase',
        }}
      >
        {plan}
      </span>
    );
  }
  const ratio = count / limit;
  const color = ratio >= 1 ? '#ef4444' : ratio >= 0.8 ? '#f59e0b' : '#52525b';
  return (
    <span style={{ fontSize: 11, color, fontVariantNumeric: 'tabular-nums' }}>
      {count}/{limit} validations
    </span>
  );
}
