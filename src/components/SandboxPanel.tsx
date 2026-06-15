import { useState } from 'react';
import type { SandboxResult, SchemaDefinition } from '../types/validation';
import { runSandbox } from '../services/sandboxRunner';
import { persistSandboxRun } from '../services/persistSandboxRun';
import { FREE_LIMITS, isOverSandboxLimit, useAppUser } from '../hooks/useAppUser';
import { AtelierCrossSell } from './AtelierCrossSell';
import { formatCell } from './formatCell';

interface SandboxPanelProps {
  sql: string;
  schema: SchemaDefinition | null;
  ddl: string;
  activeSchemaId?: string | null;
}

export function SandboxPanel({ sql, schema, ddl, activeSchemaId }: SandboxPanelProps) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SandboxResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expectedRows, setExpectedRows] = useState<string>('');

  const { appUser, refresh: refreshAppUser } = useAppUser();
  const overLimit = isOverSandboxLimit(appUser);

  const canRun =
    !!schema && schema.tables.length > 0 && !!sql.trim() && !!ddl.trim() && !overLimit;

  const handleRun = async () => {
    if (!canRun || !schema) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const expectedNum = expectedRows.trim() ? Number(expectedRows) : undefined;
      const r = await runSandbox({
        ddl,
        sql,
        schema,
        expectedRows: Number.isFinite(expectedNum) ? expectedNum : undefined,
        seed: 42,
      });
      setResult(r);

      // Fire-and-forget usage tracking. The trigger bumps the user's counter.
      if (appUser?.id) {
        void persistSandboxRun({
          appUserId: appUser.id,
          schemaId: activeSchemaId ?? undefined,
        }).then((ok) => {
          if (ok) void refreshAppUser();
        });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={panel}>
      <div style={header}>
        <span style={{ fontWeight: 600, color: '#e4e4e7', fontSize: 13 }}>Sandbox execution</span>
        <span style={{ fontSize: 10, color: '#71717a', textTransform: 'uppercase', letterSpacing: 0.5 }}>
          PGlite · in-browser
        </span>
      </div>

      {overLimit ? (
        <div style={{ padding: 14, fontSize: 12, color: '#fca5a5' }}>
          Free-tier sandbox limit reached ({appUser?.sandbox_runs_this_month}/{FREE_LIMITS.sandbox_runs} this month).
          Upgrade to Pro for 100 runs/mo.
        </div>
      ) : !canRun ? (
        <div style={{ padding: 14, fontSize: 12, color: '#71717a' }}>
          Paste DDL into the Schema panel and write SQL above to enable sandbox execution.
        </div>
      ) : (
        <>
          <div style={{ padding: '10px 14px', display: 'flex', gap: 10, alignItems: 'center' }}>
            <label style={{ fontSize: 11, color: '#a1a1aa', display: 'flex', alignItems: 'center', gap: 6 }}>
              Expected rows:
              <input
                type="number"
                placeholder="optional"
                value={expectedRows}
                onChange={(e) => setExpectedRows(e.target.value)}
                style={{
                  width: 90,
                  background: '#0a0a0a',
                  color: '#e4e4e7',
                  border: '1px solid #27272a',
                  borderRadius: 4,
                  padding: '4px 8px',
                  fontSize: 12,
                }}
              />
            </label>
            <button
              type="button"
              onClick={() => void handleRun()}
              disabled={busy}
              style={{
                background: busy ? '#27272a' : '#16a34a',
                color: 'white',
                border: 'none',
                borderRadius: 5,
                padding: '6px 14px',
                fontSize: 12,
                fontWeight: 600,
                cursor: busy ? 'wait' : 'pointer',
              }}
            >
              {busy ? 'Running…' : 'Run on synthetic data'}
            </button>
            <span style={{ fontSize: 10, color: '#52525b' }}>
              {busy ? 'Hydrating Postgres WASM…' : '~100 rows/table · seeded'}
            </span>
          </div>

          {error && (
            <div style={errorBox}>{error}</div>
          )}

          {result && <SandboxResultView result={result} />}
          <AtelierCrossSell
            show={!!result && !result.executionError && result.totalRows > 0}
          />
        </>
      )}
    </div>
  );
}

function SandboxResultView({ result }: { result: SandboxResult }) {
  if (result.executionError) {
    return (
      <div style={{ padding: '6px 14px 14px 14px' }}>
        <div style={{ fontSize: 11, color: '#fca5a5', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
          Postgres rejected this query
        </div>
        <pre style={errorPre}>{result.executionError}</pre>
        <div style={{ marginTop: 8, fontSize: 11, color: '#71717a', fontStyle: 'italic' }}>
          The sandbox caught a real Postgres semantic error. Even if static rules pass, the engine doesn't lie.
        </div>
      </div>
    );
  }

  const flag = result.rowCountFlag;
  const flagColor =
    !flag ? '#71717a' :
    flag.ratio > 1.5 ? '#f87171' :
    flag.ratio < 0.5 ? '#fbbf24' :
    '#4ade80';

  return (
    <div style={{ padding: '6px 14px 14px 14px' }}>
      <div style={{ display: 'flex', gap: 16, alignItems: 'baseline', marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 10, color: '#71717a', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Rows returned
          </div>
          <div style={{ fontSize: 24, fontWeight: 700, color: flagColor }}>
            {result.totalRows.toLocaleString()}
          </div>
        </div>
        {flag && (
          <div>
            <div style={{ fontSize: 10, color: '#71717a', textTransform: 'uppercase', letterSpacing: 0.5 }}>
              vs expected
            </div>
            <div style={{ fontSize: 18, fontWeight: 600, color: '#a1a1aa' }}>
              {flag.expected.toLocaleString()}
              <span style={{ fontSize: 12, color: flagColor, marginLeft: 6 }}>
                ({flag.ratio.toFixed(2)}×)
              </span>
            </div>
          </div>
        )}
        <div style={{ marginLeft: 'auto' }}>
          <div style={{ fontSize: 10, color: '#71717a', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Time
          </div>
          <div style={{ fontSize: 14, color: '#a1a1aa', fontFamily: 'monospace' }}>
            {result.executionMs.toFixed(0)}ms
          </div>
        </div>
      </div>

      {flag && (
        <div
          style={{
            padding: 10,
            background: flag.ratio > 1.5 ? '#450a0a' : flag.ratio < 0.5 ? '#451a03' : '#052e16',
            border: `1px solid ${flagColor}`,
            borderRadius: 6,
            fontSize: 12,
            color: '#e4e4e7',
            marginBottom: 10,
          }}
        >
          {flag.message}
        </div>
      )}

      {result.rows.length > 0 && (
        <div>
          <div style={{ fontSize: 10, color: '#71717a', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
            Sample rows ({Math.min(result.rows.length, 10)} of {result.totalRows})
          </div>
          <SampleTable rows={result.rows.slice(0, 10)} />
        </div>
      )}
    </div>
  );
}

function SampleTable({ rows }: { rows: Record<string, unknown>[] }) {
  if (rows.length === 0) return null;
  const cols = Object.keys(rows[0]);
  return (
    <div style={{ overflowX: 'auto', border: '1px solid #27272a', borderRadius: 6 }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 11, width: '100%' }}>
        <thead>
          <tr>
            {cols.map((c) => (
              <th
                key={c}
                style={{
                  textAlign: 'left',
                  padding: '6px 10px',
                  background: '#18181b',
                  color: '#a1a1aa',
                  borderBottom: '1px solid #27272a',
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                }}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td
                  key={c}
                  style={{
                    padding: '6px 10px',
                    color: '#d4d4d8',
                    borderBottom: i === rows.length - 1 ? 'none' : '1px solid #18181b',
                    fontFamily: 'monospace',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {formatCell(row[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const panel: React.CSSProperties = {
  background: '#0f0f10',
  border: '1px solid #27272a',
  borderTop: '1px solid #27272a',
};

const header: React.CSSProperties = {
  padding: '10px 14px',
  borderBottom: '1px solid #27272a',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
};

const errorBox: React.CSSProperties = {
  margin: '0 14px 14px 14px',
  padding: 10,
  background: '#450a0a',
  border: '1px solid #7f1d1d',
  borderRadius: 6,
  color: '#fecaca',
  fontSize: 12,
};

const errorPre: React.CSSProperties = {
  background: '#0a0a0a',
  border: '1px solid #27272a',
  borderRadius: 6,
  padding: 10,
  fontSize: 12,
  color: '#fca5a5',
  fontFamily: '"JetBrains Mono", Menlo, Consolas, monospace',
  margin: 0,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};
