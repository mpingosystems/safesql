import { useState } from 'react';
import type { SchemaDefinition, ValidationReport as Report } from '../types/validation';
import { SqlEditor } from '../components/SqlEditor';
import { ValidationReport } from '../components/ValidationReport';
import { parseDDL } from '../services/schemaParser';
import { validateSQL } from '../services/sqlValidator';

const DEMO_SQL = `SELECT u.id, u.email, SUM(o.amount) AS total_revenue
FROM users u
JOIN orders o ON u.id = o.user_id
JOIN order_items oi ON o.id = oi.order_id;`;

const DEMO_DDL = `CREATE TABLE users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL
);

CREATE TABLE orders (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  amount NUMERIC NOT NULL
);

CREATE TABLE order_items (
  id UUID PRIMARY KEY,
  order_id UUID REFERENCES orders(id),
  price NUMERIC NOT NULL
);`;

const DEMO_SCHEMA: SchemaDefinition = parseDDL(DEMO_DDL);

export function LandingPage() {
  const [demoSql, setDemoSql] = useState(DEMO_SQL);
  const [demoReport, setDemoReport] = useState<Report | null>(null);

  return (
    <div style={{ background: '#09090b', color: '#e4e4e7', minHeight: '100vh' }}>
      {/* NAV */}
      <nav style={navStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <a href="#/" style={{ fontWeight: 700, fontSize: 18, color: '#a78bfa', textDecoration: 'none' }}>
            SafeSQL
          </a>
          <span style={{ fontSize: 11, color: '#52525b' }}>v0.1.0</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <a href="#/pricing" style={navLink}>Pricing</a>
          <a href="#/editor" style={ctaButton}>Open Editor →</a>
        </div>
      </nav>

      {/* HERO */}
      <section style={{ ...section, paddingTop: 80, paddingBottom: 60, textAlign: 'center' }}>
        <div style={{ maxWidth: 760, margin: '0 auto' }}>
          <h1 style={h1}>SQL that runs is the most dangerous SQL.</h1>
          <p style={subhead}>
            It doesn't crash. It doesn't warn you. It quietly returns wrong numbers
            that drive real decisions.
          </p>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 28 }}>
            <a href="#/editor" style={{ ...ctaButton, padding: '12px 22px', fontSize: 14 }}>
              Validate your SQL free →
            </a>
            <a href="#demo" style={{ ...secondaryButton, padding: '12px 22px', fontSize: 14 }}>
              See it in action
            </a>
          </div>
          <div style={{ marginTop: 18, fontSize: 12, color: '#71717a' }}>
            No credit card. 50 free validations per month.
          </div>
        </div>
      </section>

      {/* THE PROBLEM */}
      <section style={section}>
        <h2 style={h2}>Three things you should know</h2>
        <div style={cardGrid}>
          <ProblemCard
            stat="54%"
            text="of database bugs come from SQL logic, not syntax. Every one of them executed successfully."
          />
          <ProblemCard
            stat="25%"
            text="of AI-generated SQL has a semantic error. The BIRD benchmark caps best LLMs at 75% accuracy."
          />
          <ProblemCard
            stat="$3.1T"
            text="lost annually to bad data. Most originates from queries that returned wrong-but-valid results."
          />
        </div>
      </section>

      {/* LIVE DEMO */}
      <section id="demo" style={{ ...section, paddingTop: 60, paddingBottom: 60 }}>
        <h2 style={h2}>Try it on a query that looks correct</h2>
        <p style={demoSubhead}>
          This query computes "total revenue per user." It runs without errors. It returns
          numbers that look reasonable. It's also wrong by 3-10x because of JOIN multiplication.
          SafeSQL catches it before you do.
        </p>
        <div style={demoGrid}>
          <div style={demoEditorWrap}>
            <div style={demoLabel}>SQL</div>
            <div style={{ height: 220, border: '1px solid #27272a', borderRadius: 6, overflow: 'hidden' }}>
              <SqlEditor
                value={demoSql}
                onChange={setDemoSql}
                onValidate={setDemoReport}
                schema={DEMO_SCHEMA}
                dialect="postgresql"
                height="100%"
              />
            </div>
            <div style={demoLabel}>Schema (parsed from DDL)</div>
            <pre style={demoSchemaBox}>
              {DEMO_SCHEMA.tables.map((t) => `${t.name} (${t.columns.length} cols)`).join('\n')}
            </pre>
            <button
              type="button"
              onClick={() =>
                setDemoReport(
                  validateSQL({ sql: demoSql, schema: DEMO_SCHEMA, dialect: 'postgresql' }),
                )
              }
              style={{ ...ctaButton, marginTop: 12, width: '100%', padding: '10px 14px' }}
            >
              Validate this query →
            </button>
          </div>
          <div style={demoReportWrap}>
            <ValidationReport report={demoReport} />
          </div>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section style={section}>
        <h2 style={h2}>How it works</h2>
        <div style={cardGrid}>
          <StepCard num={1} title="Paste SQL + schema" body="Paste your query and DDL. SafeSQL parses both into an AST." />
          <StepCard num={2} title="Analyze logic, not syntax" body="7 deterministic detectors find errors a linter misses: JOIN multiplication, missing WHERE, contradictory filters, and more." />
          <StepCard num={3} title="Run on synthetic data" body="Need proof? Execute against RealityDB-generated synthetic data — see actual row counts before touching production." />
        </div>
      </section>

      {/* PRICING */}
      <section id="pricing" style={section}>
        <h2 style={h2}>Pricing</h2>
        <p style={{ ...demoSubhead, marginBottom: 30 }}>
          DevTools pricing for data teams. Annual billing saves 20%.
        </p>
        <div style={pricingGrid}>
          <PricingCard tier="Free" price="$0" period="forever" features={['50 validations/mo', '5 sandbox runs', 'Basic detectors', 'No AI explanations']} cta="Start free" href="#/editor" />
          <PricingCard tier="Pro" price="$49" period="per month" highlight features={['Unlimited validations', '100 sandbox runs', 'All 7 detectors', 'AI explanations + fixes', 'Catch Copilot/Cursor bugs']} cta="Upgrade to Pro" href="#/pricing" />
          <PricingCard tier="Team" price="$199" period="per month · 5 seats" features={['Everything in Pro', 'Shared schema library', 'Team validation history', 'Priority support']} cta="Start team trial" href="#/pricing" />
          <PricingCard tier="Business" price="$599" period="per month · 20 seats" features={['Everything in Team', 'Custom rules', 'Audit log', 'Slack alerts', 'SLA']} cta="Contact sales" href="#/pricing" />
        </div>
      </section>

      {/* FINAL CTA */}
      <section style={{ ...section, textAlign: 'center', paddingTop: 60, paddingBottom: 100 }}>
        <h2 style={{ ...h2, marginBottom: 14 }}>Start validating free</h2>
        <p style={{ ...demoSubhead, marginBottom: 24 }}>No credit card required.</p>
        <a href="#/editor" style={{ ...ctaButton, padding: '14px 28px', fontSize: 15 }}>
          Open the editor →
        </a>
      </section>

      <footer style={{ borderTop: '1px solid #27272a', padding: '24px 32px', color: '#52525b', fontSize: 12 }}>
        © 2026 Mpingo Systems LLC · Built on RealityDB synthetic data
      </footer>
    </div>
  );
}

// ── Reusable card components ────────────────────────────────────────────────

function ProblemCard({ stat, text }: { stat: string; text: string }) {
  return (
    <div style={card}>
      <div style={{ fontSize: 36, fontWeight: 800, color: '#a78bfa', marginBottom: 10 }}>{stat}</div>
      <div style={{ color: '#a1a1aa', fontSize: 14, lineHeight: 1.55 }}>{text}</div>
    </div>
  );
}

function StepCard({ num, title, body }: { num: number; title: string; body: string }) {
  return (
    <div style={card}>
      <div style={{ fontSize: 12, color: '#7c3aed', fontWeight: 700, marginBottom: 10 }}>STEP {num}</div>
      <div style={{ fontSize: 16, fontWeight: 600, color: '#e4e4e7', marginBottom: 8 }}>{title}</div>
      <div style={{ color: '#a1a1aa', fontSize: 13, lineHeight: 1.55 }}>{body}</div>
    </div>
  );
}

function PricingCard(props: {
  tier: string;
  price: string;
  period: string;
  features: string[];
  cta: string;
  href: string;
  highlight?: boolean;
}) {
  return (
    <div
      style={{
        ...card,
        border: props.highlight ? '1px solid #7c3aed' : '1px solid #27272a',
        position: 'relative',
      }}
    >
      {props.highlight && (
        <span
          style={{
            position: 'absolute',
            top: -10,
            left: 16,
            background: '#7c3aed',
            color: 'white',
            fontSize: 10,
            fontWeight: 700,
            padding: '3px 8px',
            borderRadius: 4,
            letterSpacing: 0.5,
          }}
        >
          MOST POPULAR
        </span>
      )}
      <div style={{ fontSize: 13, fontWeight: 600, color: '#a1a1aa', marginBottom: 10 }}>
        {props.tier}
      </div>
      <div style={{ marginBottom: 14 }}>
        <span style={{ fontSize: 32, fontWeight: 800, color: '#e4e4e7' }}>{props.price}</span>
        <span style={{ color: '#71717a', fontSize: 12, marginLeft: 6 }}>{props.period}</span>
      </div>
      <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 18px 0' }}>
        {props.features.map((f) => (
          <li key={f} style={{ color: '#d4d4d8', fontSize: 13, padding: '4px 0' }}>
            ✓ {f}
          </li>
        ))}
      </ul>
      <a
        href={props.href}
        style={{
          display: 'block',
          textAlign: 'center',
          padding: '8px 14px',
          borderRadius: 5,
          fontSize: 13,
          fontWeight: 600,
          textDecoration: 'none',
          background: props.highlight ? '#7c3aed' : '#27272a',
          color: props.highlight ? 'white' : '#e4e4e7',
        }}
      >
        {props.cta}
      </a>
    </div>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const navStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '14px 32px',
  borderBottom: '1px solid #18181b',
  background: '#0a0a0a',
  position: 'sticky',
  top: 0,
  zIndex: 10,
};

const navLink: React.CSSProperties = {
  color: '#a1a1aa',
  textDecoration: 'none',
  fontSize: 13,
};

const ctaButton: React.CSSProperties = {
  background: '#7c3aed',
  color: 'white',
  textDecoration: 'none',
  padding: '7px 14px',
  borderRadius: 5,
  fontSize: 13,
  fontWeight: 600,
  border: 'none',
  cursor: 'pointer',
  display: 'inline-block',
};

const secondaryButton: React.CSSProperties = {
  background: 'transparent',
  color: '#e4e4e7',
  border: '1px solid #27272a',
  textDecoration: 'none',
  padding: '7px 14px',
  borderRadius: 5,
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  display: 'inline-block',
};

const section: React.CSSProperties = {
  padding: '60px 32px',
  maxWidth: 1100,
  margin: '0 auto',
};

const h1: React.CSSProperties = {
  fontSize: 48,
  fontWeight: 800,
  letterSpacing: -1,
  lineHeight: 1.1,
  margin: 0,
  background: 'linear-gradient(135deg, #e4e4e7 0%, #a78bfa 100%)',
  WebkitBackgroundClip: 'text',
  WebkitTextFillColor: 'transparent',
  backgroundClip: 'text',
};

const h2: React.CSSProperties = {
  fontSize: 28,
  fontWeight: 700,
  marginBottom: 12,
  textAlign: 'center',
};

const subhead: React.CSSProperties = {
  fontSize: 18,
  color: '#a1a1aa',
  lineHeight: 1.55,
  marginTop: 18,
};

const demoSubhead: React.CSSProperties = {
  fontSize: 14,
  color: '#a1a1aa',
  lineHeight: 1.6,
  textAlign: 'center',
  maxWidth: 720,
  margin: '0 auto 24px auto',
};

const cardGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
  gap: 16,
  marginTop: 24,
};

const card: React.CSSProperties = {
  background: '#0f0f10',
  border: '1px solid #27272a',
  borderRadius: 10,
  padding: 24,
};

const demoGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) 360px',
  gap: 16,
  marginTop: 24,
};

const demoEditorWrap: React.CSSProperties = {
  background: '#0f0f10',
  border: '1px solid #27272a',
  borderRadius: 10,
  padding: 16,
};

const demoReportWrap: React.CSSProperties = {
  background: '#0f0f10',
  border: '1px solid #27272a',
  borderRadius: 10,
  height: 540,
  overflow: 'hidden',
};

const demoLabel: React.CSSProperties = {
  fontSize: 11,
  color: '#71717a',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  margin: '6px 0 6px 0',
  fontWeight: 600,
};

const demoSchemaBox: React.CSSProperties = {
  background: '#0a0a0a',
  border: '1px solid #27272a',
  borderRadius: 6,
  padding: 10,
  fontSize: 12,
  color: '#a1a1aa',
  fontFamily: '"JetBrains Mono", Menlo, Consolas, monospace',
  margin: 0,
  maxHeight: 90,
  overflow: 'auto',
};

const pricingGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: 16,
  marginTop: 24,
};
