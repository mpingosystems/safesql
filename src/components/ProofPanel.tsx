import { useState } from 'react';
import type { SandboxResult, SchemaDefinition, ValidationReport } from '../types/validation';
import { runSandbox } from '../services/sandboxRunner';

// PQ2 — RealityDB synthetic proof panel. When a fan-out / grain issue is
// detected, developers are skeptical until they see the inflated row count on
// realistic data. This runs the query against schema-matched synthetic rows and
// surfaces the ground-truth inflation, turning an abstract warning into proof.
const FANOUT_IDS = new Set([
  'AGGREGATE_OVER_FANOUT_JOIN',
  'MULTIPLE_ONE_TO_MANY_JOINS',
  'COUNT_PARENT_AFTER_CHILD_JOIN',
  'JOIN_MULTIPLICATION',
  'AGGREGATION_GRAIN_MISMATCH',
]);

interface ProofPanelProps {
  report: ValidationReport | null;
  sql: string;
  ddl: string;
  schema: SchemaDefinition | null;
}

export function ProofPanel({ report, sql, ddl, schema }: ProofPanelProps) {
  const [result, setResult] = useState<SandboxResult | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!report) return null;
  const fanoutIssue = [...report.warnings, ...report.errors].find((i) => FANOUT_IDS.has(i.id));
  if (!fanoutIssue) return null;

  const canRun = !!schema && schema.tables.length > 0 && !!ddl.trim();

  const run = async () => {
    if (!schema) return;
    setRunning(true);
    setErr(null);
    setResult(null);
    try {
      // Small, fixed synthetic dataset: a parent with several children per row
      // is enough to make fan-out visible without a heavy generation.
      const res = await runSandbox({
        ddl,
        sql,
        schema,
        rowsPerTable: 12,
        seed: 7,
      });
      setResult(res);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const flag = result?.rowCountFlag;

  return (
    <div
      style={{
        margin: '0 12px 12px',
        border: '1px solid #3f3f46',
        borderRadius: 8,
        background: '#0f0f10',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '8px 10px',
          background: '#1e1b4b',
          fontSize: 11,
          fontWeight: 700,
          color: '#c4b5fd',
          letterSpacing: 0.4,
          textTransform: 'uppercase',
        }}
      >
        ⚡ Synthetic proof — {fanoutIssue.id.replace(/_/g, ' ').toLowerCase()}
      </div>
      <div style={{ padding: 10, fontSize: 12, color: '#a1a1aa', lineHeight: 1.5 }}>
        Run this query on RealityDB synthetic rows to see the actual inflation, not just a warning.
        {!canRun && (
          <div style={{ color: '#f59e0b', marginTop: 6 }}>
            Add a schema (DDL) on the left to enable the proof run.
          </div>
        )}
        <div style={{ marginTop: 8 }}>
          <button
            type="button"
            onClick={() => void run()}
            disabled={!canRun || running}
            style={{
              background: canRun ? '#7c3aed' : '#3f3f46',
              color: 'white',
              border: 'none',
              borderRadius: 5,
              padding: '6px 12px',
              fontSize: 12,
              fontWeight: 600,
              cursor: canRun && !running ? 'pointer' : 'not-allowed',
              opacity: canRun ? 1 : 0.6,
            }}
          >
            {running ? 'Generating + running…' : 'Run synthetic proof'}
          </button>
        </div>

        {err && <div style={{ color: '#ef4444', marginTop: 8 }}>Sandbox error: {err}</div>}

        {result && !err && (
          <div style={{ marginTop: 10 }}>
            {result.executionError ? (
              <div style={{ color: '#ef4444' }}>
                Postgres refused the query: {result.executionError}
              </div>
            ) : (
              <>
                <div
                  style={{
                    display: 'flex',
                    gap: 8,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  <Stat label="Rows returned" value={String(result.totalRows)} accent="#ef4444" />
                  {result.expectedRows !== undefined && (
                    <Stat label="Expected" value={String(result.expectedRows)} accent="#22c55e" />
                  )}
                  {flag && (
                    <Stat label="Inflation" value={`${flag.ratio.toFixed(1)}×`} accent="#f59e0b" />
                  )}
                </div>
                {flag && <div style={{ marginTop: 8, color: '#d4d4d8' }}>{flag.message}</div>}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div
      style={{
        flex: 1,
        border: '1px solid #27272a',
        borderRadius: 6,
        padding: '6px 8px',
        background: '#18181b',
      }}
    >
      <div style={{ fontSize: 18, fontWeight: 700, color: accent }}>{value}</div>
      <div style={{ fontSize: 10, color: '#71717a', textTransform: 'uppercase', letterSpacing: 0.4 }}>
        {label}
      </div>
    </div>
  );
}
