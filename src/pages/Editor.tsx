import { useCallback, useState } from 'react';
import type { SchemaDefinition, ValidationReport as Report } from '../types/validation';
import { SqlEditor } from '../components/SqlEditor';
import { SchemaPanel } from '../components/SchemaPanel';
import { ValidationReport } from '../components/ValidationReport';
import { SandboxPanel } from '../components/SandboxPanel';
import { validateSQL } from '../services/sqlValidator';
import { enrichWithAIExplanations } from '../services/aiExplainer';

type Dialect = 'postgresql' | 'mysql' | 'bigquery' | 'snowflake' | 'ansi';

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
  const [dialect, setDialect] = useState<Dialect>('postgresql');
  const [aiEnabled, setAiEnabled] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [lastValidatedAt, setLastValidatedAt] = useState<Date | null>(null);

  const runValidation = useCallback(async () => {
    let next = validateSQL({ sql, schema: schema ?? undefined, dialect });
    setReport(next);
    setLastValidatedAt(new Date());

    if (aiEnabled && (next.errors.length > 0 || next.warnings.length > 0)) {
      const enriched = await enrichWithAIExplanations(next, sql, schema ?? undefined);
      setReport({ ...enriched });
    }
  }, [sql, schema, dialect, aiEnabled]);

  const handleValidationFromEditor = (next: Report) => {
    setReport(next);
    setLastValidatedAt(new Date());
  };

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
          <span style={{ color: '#52525b', fontSize: 11 }}>v0.1.0</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <label style={{ fontSize: 12, color: '#a1a1aa' }}>
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
              <option value="ansi">ANSI</option>
            </select>
          </label>
          <span style={{ color: '#52525b', fontSize: 11 }}>Ctrl+S to validate</span>
          <button
            type="button"
            onClick={() => void runValidation()}
            style={{
              background: '#7c3aed',
              color: 'white',
              border: 'none',
              borderRadius: 5,
              padding: '6px 14px',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Validate
          </button>
        </div>
      </header>

      <aside style={{ gridArea: 'left', overflow: 'hidden' }}>
        <SchemaPanel
          schema={schema}
          onSchemaChange={setSchema}
          ddl={ddl}
          onDdlChange={setDdl}
        />
      </aside>

      <main style={{ gridArea: 'center', overflow: 'hidden', borderRight: '1px solid #27272a' }}>
        <SqlEditor
          value={sql}
          onChange={setSql}
          onValidate={handleValidationFromEditor}
          schema={schema ?? undefined}
          dialect={dialect}
          aiEnabled={aiEnabled}
        />
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
        <ValidationReport report={report} />
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
        <SandboxPanel sql={sql} schema={schema} ddl={ddl} />
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
