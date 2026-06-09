import type { ReactNode } from 'react';

// Legal/Security pages chrome. Reuses the existing dark theme exactly (same
// colors, typography, and the purple section accent already used on the
// Compliance page) — no new design patterns. Shared by Privacy, Terms,
// Security, DPA, and Sub-processors.
export function LegalShell({
  title,
  subtitle,
  meta,
  children,
}: {
  title: string;
  subtitle?: string;
  meta?: string;
  children: ReactNode;
}) {
  return (
    <div style={{ background: '#09090b', color: '#e4e4e7', minHeight: '100vh', padding: 32 }}>
      <a href="#/" style={{ color: '#a78bfa', textDecoration: 'none', fontSize: 13 }}>← Home</a>
      <div style={{ maxWidth: 760, margin: '24px auto 0' }}>
        <h1 style={{ fontSize: 26, margin: '0 0 6px' }}>{title}</h1>
        {subtitle && <p style={{ color: '#a1a1aa', fontSize: 15, margin: '0 0 6px', lineHeight: 1.5 }}>{subtitle}</p>}
        {meta && <p style={{ color: '#71717a', fontSize: 12.5, margin: '0 0 8px' }}>{meta}</p>}
        {children}
        <p style={{ color: '#52525b', fontSize: 12, marginTop: 40, borderTop: '1px solid #27272a', paddingTop: 16 }}>
          © 2026 Mpingo Systems LLC · North Carolina, USA
        </p>
      </div>
    </div>
  );
}

// A titled section with the purple left-accent used on the Compliance page.
export function LegalSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ borderLeft: '2px solid #7c3aed', paddingLeft: 14, margin: '22px 0' }}>
      <h2 style={{ fontSize: 16, margin: '0 0 6px' }}>{title}</h2>
      <div style={{ color: '#d4d4d8', fontSize: 14, lineHeight: 1.65 }}>{children}</div>
    </div>
  );
}

// Plain prose paragraph in the section body color.
export function P({ children }: { children: ReactNode }) {
  return <p style={{ margin: '0 0 10px', lineHeight: 1.65 }}>{children}</p>;
}

// A small sub-heading inside a section (e.g. "1.1 Account information").
export function SubH({ children }: { children: ReactNode }) {
  return <div style={{ color: '#e4e4e7', fontWeight: 600, fontSize: 13.5, margin: '12px 0 4px' }}>{children}</div>;
}

// Bulleted list reusing the body color.
export function UL({ items }: { items: ReactNode[] }) {
  return (
    <ul style={{ margin: '4px 0 10px', paddingLeft: 18 }}>
      {items.map((it, i) => (
        <li key={i} style={{ marginBottom: 4, lineHeight: 1.6 }}>{it}</li>
      ))}
    </ul>
  );
}

// A simple bordered table matching the existing table styling in the app.
export function LegalTable({ headers, rows }: { headers: string[]; rows: ReactNode[][] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, margin: '10px 0' }}>
      <thead>
        <tr>
          {headers.map((h) => (
            <th key={h} style={{ textAlign: 'left', padding: '8px 10px', color: '#a1a1aa', borderBottom: '1px solid #27272a' }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((cell, j) => (
              <td key={j} style={{ padding: '8px 10px', borderBottom: '1px solid #18181b', color: '#d4d4d8' }}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
