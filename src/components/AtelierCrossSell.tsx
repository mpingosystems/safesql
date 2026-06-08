import { useEffect, useState } from 'react';

// Sprint 7 Part 6 — contextual cross-sell to RealityDB Atelier, shown once per
// session after a successful sandbox run (rows returned > 0). Practising the
// business judgment on the same data is the natural next step after validating
// the SQL.
const SHOWN_KEY = 'safesql.atelierShown';
const ATELIER_URL = 'https://atelier.realitydb.dev?ref=safesql_sandbox';

interface Props {
  // True when a sandbox execution completed and returned at least one row.
  show: boolean;
}

export function AtelierCrossSell({ show }: Props) {
  const [dismissed, setDismissed] = useState(false);
  const [alreadyShown, setAlreadyShown] = useState(true);

  useEffect(() => {
    try {
      setAlreadyShown(window.sessionStorage.getItem(SHOWN_KEY) === '1');
    } catch {
      setAlreadyShown(false);
    }
  }, []);

  useEffect(() => {
    if (show && !alreadyShown) {
      try {
        window.sessionStorage.setItem(SHOWN_KEY, '1');
      } catch {
        /* ignore */
      }
    }
  }, [show, alreadyShown]);

  if (!show || alreadyShown || dismissed) return null;

  return (
    <div
      style={{
        margin: '10px 14px',
        border: '1px solid #3f3f46',
        borderRadius: 8,
        background: 'linear-gradient(135deg, #1e1b4b, #0f0f10)',
        padding: 14,
        position: 'relative',
      }}
    >
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        style={{ position: 'absolute', top: 8, right: 10, background: 'none', border: 'none', color: '#71717a', cursor: 'pointer', fontSize: 14 }}
      >
        ×
      </button>
      <div style={{ fontSize: 14, fontWeight: 700, color: '#e4e4e7', marginBottom: 4 }}>
        🎯 Practice this query on real business scenarios
      </div>
      <div style={{ fontSize: 12.5, color: '#a1a1aa', lineHeight: 1.5, marginBottom: 10 }}>
        You've validated the SQL. Now practice the business judgment — in RealityDB Atelier.
      </div>
      <a
        href={ATELIER_URL}
        target="_blank"
        rel="noreferrer"
        style={{ background: '#7c3aed', color: 'white', padding: '6px 14px', borderRadius: 6, textDecoration: 'none', fontWeight: 600, fontSize: 12.5 }}
      >
        Try Atelier free →
      </a>
      <span style={{ color: '#52525b', fontSize: 11, marginLeft: 10 }}>atelier.realitydb.dev</span>
    </div>
  );
}
