import { useCallback, useEffect, useState } from 'react';
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
import { validateSQL } from '../services/sqlValidator';
import { enrichWithAIExplanations } from '../services/aiExplainer';
import { persistValidation } from '../services/persistValidation';
import { applyFix } from '../services/applyFix';
import { AuthControls } from '../components/AuthControls';
import { useAppUser, isOverValidationLimit, FREE_LIMITS } from '../hooks/useAppUser';

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

const DEFAULT_SQL = `-- Paste your SQL here, then press Ctrl+S to validate
SELECT u.id, u.email, SUM(o.amount) AS total
FROM users u
JOIN orders o ON u.id = o.user_id
JOIN order_items oi ON o.id = oi.order_id;
`;

export function EditorPage() {
  const [sql, setSql] = useState(DEFAULT_SQL);
  const [ddl, setDdl] = useState('');
  const [schema, setSchema] = useState<SchemaDefinition | null>(null);
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

  const { appUser, refresh: refreshAppUser } = useAppUser();
  const overLimit = isOverValidationLimit(appUser);
  const isPro = !!appUser && appUser.plan !== 'free';

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
            SafeSQL
          </a>
          <span style={{ color: '#52525b', fontSize: 11 }}>v0.2.0</span>
          {appUser && (
            <UsageMeter
              count={appUser.validations_this_month}
              limit={FREE_LIMITS.validations}
              plan={appUser.plan}
            />
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
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
