import { useMemo } from 'react';
import { decodeSharePayload, shareTokenFromHash } from '../services/permalink';
import { ValidationReport } from '../components/ValidationReport';

// PQ5 — resolve a shared validation permalink (#/v/<encoded>). The whole report
// is encoded in the URL, so this renders read-only with no fetch or auth.
export function ShareViewPage() {
  const payload = useMemo(() => {
    const token = shareTokenFromHash(window.location.hash);
    return token ? decodeSharePayload(token) : null;
  }, []);

  if (!payload) {
    return (
      <Shell>
        <h1 style={{ fontSize: 24 }}>Link not found</h1>
        <p style={{ color: '#a1a1aa', marginTop: 12 }}>
          This validation link is invalid or corrupted.{' '}
          <a href="#/editor" style={{ color: '#a78bfa' }}>
            Open the editor
          </a>{' '}
          to validate a query.
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Shared validation</h1>
        <a href="#/editor" style={{ color: '#a78bfa', fontSize: 13, textDecoration: 'none' }}>
          Validate your own SQL →
        </a>
      </div>
      <div style={{ color: '#71717a', fontSize: 12, marginTop: 4 }}>
        Dialect: {payload.dialect}
        {payload.source ? ` · ${payload.source}` : ''}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: 16, marginTop: 16 }}>
        <div>
          <SectionLabel>SQL</SectionLabel>
          <pre style={codeBlock}>{payload.sql}</pre>
          {payload.ddl && (
            <>
              <SectionLabel>Schema (DDL)</SectionLabel>
              <pre style={codeBlock}>{payload.ddl}</pre>
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
          <ValidationReport report={payload.report} />
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ background: '#09090b', color: '#e4e4e7', minHeight: '100vh', padding: '32px' }}>
      <a href="#/" style={{ color: '#a78bfa', textDecoration: 'none', fontSize: 13 }}>
        ← SafeSQL
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
