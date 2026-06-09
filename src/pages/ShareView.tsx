import { useEffect, useState } from 'react';
import { decodeSharePayload, shareTokenFromHash } from '../services/permalink';
import {
  daysUntilExpiry,
  fetchSharedValidation,
  rowToReport,
  shareIdFromPath,
  type SharedValidationRow,
} from '../services/sharedValidation';
import { ValidationReport } from '../components/ValidationReport';
import type { ValidationReport as Report } from '../types/validation';

type ViewState =
  | { status: 'loading' }
  | { status: 'notfound' }
  | { status: 'ready'; sql: string; ddl?: string; dialect?: string; source?: string; report: Report; expiresAt?: string };

const PRELOAD_KEY = 'safesql.preloadSql';

// Resolve a shared validation: new DB-backed /v/{id}, or legacy #/v/<payload>
// (which we decode and bounce into the editor — the hash scheme is retired for
// new links but old links still open the SQL).
export function ShareViewPage() {
  const [state, setState] = useState<ViewState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    const pathId = shareIdFromPath(window.location.pathname);
    if (pathId) {
      void fetchSharedValidation(pathId).then((row) => {
        if (cancelled) return;
        if (!row) {
          setState({ status: 'notfound' });
          return;
        }
        setState(rowToReadyState(row));
      });
      return () => {
        cancelled = true;
      };
    }

    // Legacy hash permalink: decode and open the SQL in the editor.
    const token = shareTokenFromHash(window.location.hash);
    const legacy = token ? decodeSharePayload(token) : null;
    if (legacy) {
      try {
        window.sessionStorage.setItem(PRELOAD_KEY, legacy.sql);
      } catch {
        /* ignore storage failure */
      }
      window.location.replace('/#/editor');
      return;
    }

    setState({ status: 'notfound' });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === 'loading') {
    return (
      <Shell>
        <p style={{ color: '#a1a1aa' }}>Loading shared validation…</p>
      </Shell>
    );
  }

  if (state.status !== 'ready') {
    return (
      <Shell>
        <h1 style={{ fontSize: 24 }}>Link expired or not found</h1>
        <p style={{ color: '#a1a1aa', marginTop: 12 }}>
          This validation link has expired or doesn't exist.{' '}
          <a href="#/editor" style={{ color: '#a78bfa' }}>
            Open the editor
          </a>{' '}
          to validate a query.
        </p>
      </Shell>
    );
  }

  const openInSafeSQL = () => {
    try {
      window.sessionStorage.setItem(PRELOAD_KEY, state.sql);
    } catch {
      /* ignore */
    }
    window.location.href = '/#/editor';
  };

  return (
    <Shell>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Shared validation — view only</h1>
        <button type="button" onClick={openInSafeSQL} style={openBtn}>
          Open in SafeSQL Pro →
        </button>
      </div>
      <div style={{ color: '#71717a', fontSize: 12, marginTop: 4, display: 'flex', gap: 8 }}>
        {state.dialect && <Badge>{state.dialect}</Badge>}
        {state.source && <Badge>{state.source}</Badge>}
        {state.expiresAt && <span>Expires in {daysUntilExpiry(state.expiresAt)} days</span>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: 16, marginTop: 16 }}>
        <div>
          <SectionLabel>SQL</SectionLabel>
          <pre style={codeBlock}>{state.sql}</pre>
          {state.ddl && (
            <>
              <SectionLabel>Schema (DDL)</SectionLabel>
              <pre style={codeBlock}>{state.ddl}</pre>
            </>
          )}
        </div>
        <div
          style={{
            background: '#0f0f10',
            border: '1px solid #27272a',
            borderRadius: 8,
            overflow: 'hidden',
            minHeight: 320,
          }}
        >
          {/* Read-only: no editor context, so apply-fix / proof run are inert. */}
          <ValidationReport report={state.report} />
        </div>
      </div>
    </Shell>
  );
}

function rowToReadyState(row: SharedValidationRow): ViewState {
  return {
    status: 'ready',
    sql: row.sql,
    ddl: row.ddl ?? undefined,
    dialect: row.dialect ?? undefined,
    source: row.source ?? undefined,
    report: rowToReport(row),
    expiresAt: row.expires_at,
  };
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ background: '#09090b', color: '#e4e4e7', minHeight: '100vh', padding: '32px' }}>
      <a href="#/" style={{ color: '#a78bfa', textDecoration: 'none', fontSize: 13 }}>
        ← SafeSQL Pro
      </a>
      <div style={{ maxWidth: 1100, margin: '20px auto 0' }}>{children}</div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        color: '#71717a',
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        margin: '12px 0 6px',
      }}
    >
      {children}
    </div>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        padding: '1px 7px',
        borderRadius: 999,
        background: '#27272a',
        color: '#a1a1aa',
        fontSize: 11,
      }}
    >
      {children}
    </span>
  );
}

const openBtn: React.CSSProperties = {
  background: '#7c3aed',
  color: 'white',
  border: 'none',
  borderRadius: 5,
  padding: '6px 12px',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
};

const codeBlock: React.CSSProperties = {
  background: '#0a0a0a',
  border: '1px solid #27272a',
  borderRadius: 8,
  padding: 12,
  fontSize: 12.5,
  color: '#e4e4e7',
  overflow: 'auto',
  fontFamily: '"JetBrains Mono", Menlo, Consolas, monospace',
  whiteSpace: 'pre-wrap',
  margin: 0,
};
