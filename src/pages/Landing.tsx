import { useState, useEffect, lazy, Suspense } from 'react';
import type { SchemaDefinition, ValidationReport as Report } from '../types/validation';
// Lazy: the demo editor loads Monaco. Deferring it lets the landing page paint
// and Clerk initialize before Monaco's chunk + CDN runtime are fetched.
const SqlEditor = lazy(() => import('../components/SqlEditor').then((m) => ({ default: m.SqlEditor })));
import { ValidationReport } from '../components/ValidationReport';
import { parseDDL } from '../services/schemaParser';
import { validateSQL } from '../services/sqlValidator';
import { startCheckoutForPlan, type Plan } from '../services/stripe';
import { SiteNav } from '../components/SiteNav';
import { useAppUser } from '../hooks/useAppUser';
import { ROICalculator, type RecommendedTier } from '../components/ROICalculator';

const DEMO_SQL = `-- Monthly revenue by plan — for the board deck
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
ORDER BY DATE_TRUNC('month', p.paid_at) DESC, total_revenue DESC;`;

const DEMO_DDL = `CREATE TABLE customers (
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

const DEMO_SCHEMA: SchemaDefinition = parseDDL(DEMO_DDL);

export function LandingPage() {
  const [demoSql, setDemoSql] = useState(DEMO_SQL);
  const [demoReport, setDemoReport] = useState<Report | null>(null);

  // Auto-validate the demo query on mount so the JOIN-multiplication warning is
  // visible immediately (validateSQL is deterministic + synchronous, no AI).
  useEffect(() => {
    setDemoReport(validateSQL({ sql: DEMO_SQL, schema: DEMO_SCHEMA, dialect: 'postgresql' }));
  }, []);

  return (
    <div style={{ background: '#09090b', color: '#e4e4e7', minHeight: '100vh' }}>
      {/* NAV */}
      <SiteNav current="landing" />

      {/* HERO — five layers: hook, category+trust, action promise,
          belonging+judgment, CTA. Sized so all five clear the fold on a
          typical desktop viewport (~630px used above 800px). */}
      <section style={{ ...section, paddingTop: 56, paddingBottom: 44, textAlign: 'center' }}>
        <div style={{ maxWidth: 780, margin: '0 auto' }}>
          {/* L1 — hook */}
          <h1 style={h1}>SQL that runs is the most dangerous SQL.</h1>

          {/* L2 — category + trust */}
          <p
            style={{
              fontSize: 20,
              color: '#a1a1aa',
              lineHeight: 1.5,
              marginTop: 18,
              marginBottom: 0,
            }}
          >
            Semantic SQL validation — before execution.
            <br />
            <span style={{ color: '#d4d4d8' }}>
              Deterministic: rules fire or they don't. No AI guesswork.
            </span>
          </p>

          {/* L3 — action promise */}
          <p
            style={{
              fontSize: 17,
              color: '#e4e4e7',
              fontWeight: 600,
              lineHeight: 1.45,
              marginTop: 20,
              marginBottom: 0,
            }}
          >
            Catch dangerous SQL before it runs.
            <br />
            <span style={{ color: '#a78bfa' }}>Prove how every finding was resolved.</span>
          </p>

          {/* L4 — belonging + judgment + action */}
          <p style={{ fontSize: 14, color: '#a1a1aa', lineHeight: 1.6, marginTop: 22, marginBottom: 10 }}>
            SafeSQL Pro runs deterministic detectors on human- and AI-written SQL.
          </p>
          <ul
            style={{
              listStyle: 'none',
              padding: 0,
              margin: '0 auto',
              maxWidth: 560,
              textAlign: 'left',
              display: 'grid',
              gap: 7,
            }}
          >
            {[
              'Your dbt models, CI pipeline, VS Code, and pre-commit — already covered',
              'Catches the JOIN that inflates the revenue report below by 2.8× before it runs',
              'Every finding logged, resolved, and audit-ready',
            ].map((line) => (
              <li
                key={line}
                style={{
                  fontSize: 13.5,
                  color: '#d4d4d8',
                  lineHeight: 1.5,
                  paddingLeft: 20,
                  position: 'relative',
                }}
              >
                <span style={{ position: 'absolute', left: 0, color: '#7c3aed', fontWeight: 700 }}>
                  ✓
                </span>
                {line}
              </li>
            ))}
          </ul>

          {/* L5 — CTAs */}
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 26 }}>
            <a href="#/editor" style={{ ...ctaButton, padding: '12px 22px', fontSize: 14 }}>
              Validate your SQL free →
            </a>
            <a href="#/how-to" style={{ ...secondaryButton, padding: '12px 22px', fontSize: 14 }}>
              How it works →
            </a>
          </div>
          <div style={{ marginTop: 14, fontSize: 12, color: '#71717a' }}>
            No credit card. 50 free validations per month.
          </div>
        </div>
      </section>

      {/* BENCHMARK STATS */}
      <StatsBar />

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
            stat="501"
            text="spurious findings our own benchmark caught in our detectors — fixed before we published the results."
          />
        </div>
      </section>

      {/* LIVE DEMO */}
      <section id="demo" style={{ ...section, paddingTop: 60, paddingBottom: 60 }}>
        <h2 style={h2}>Try it on a query that looks correct</h2>
        <p style={demoSubhead}>
          This query computes "total revenue per user." It runs without errors. It returns
          numbers that look reasonable. It's also wrong by 3-10x because of JOIN multiplication.
          SafeSQL Pro catches it before you do.
        </p>
        <div style={demoGrid}>
          <div style={demoEditorWrap}>
            <div style={demoLabel}>SQL</div>
            <div style={{ height: 220, border: '1px solid #27272a', borderRadius: 6, overflow: 'hidden' }}>
              <Suspense
                fallback={
                  <div
                    style={{
                      height: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#71717a',
                      fontSize: 13,
                      background: '#0a0a0a',
                    }}
                  >
                    Loading editor…
                  </div>
                }
              >
                <SqlEditor
                  value={demoSql}
                  onChange={setDemoSql}
                  onValidate={setDemoReport}
                  schema={DEMO_SCHEMA}
                  dialect="postgresql"
                  height="100%"
                />
              </Suspense>
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
          <StepCard num={1} title="Paste SQL + schema (or connect your database)" body="Paste your query and DDL — or connect directly to your PostgreSQL database. SafeSQL Pro parses both into an AST instantly." />
          <StepCard num={2} title="Detect logic errors, not just syntax" body="35 semantic detectors catch what linters miss: JOIN multiplication, fan-out aggregates, hallucinated AI columns, LEFT JOIN WHERE traps, missing time filters, and more. Deterministic AST detection — rules fire or they don't, never a guess. See our public benchmark." />
          <StepCard num={3} title="Prove it with synthetic data" body="Not just warnings — proof. SafeSQL Pro runs your query on RealityDB synthetic data and shows actual row counts, inflated aggregates, and rejected columns before a single production row is touched." />
        </div>
        <p style={{ textAlign: 'center', marginTop: 18, fontSize: 13.5, color: '#a1a1aa' }}>
          Every claim above is measured, not asserted —{' '}
          <a href="#/benchmark" style={{ color: '#a78bfa', fontWeight: 600 }}>
            see the public benchmark
          </a>{' '}
          (2,654 queries, methodology and raw results in the repo).
        </p>
      </section>

      {/* PROGRESSION */}
      <ProgressionSection />

      {/* PRICING */}
      <PricingSection />

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
        {' · '}
        <a href="#/privacy" style={{ color: '#71717a', textDecoration: 'none' }}>Privacy Policy</a>
        {' · '}
        <a href="#/terms" style={{ color: '#71717a', textDecoration: 'none' }}>Terms of Service</a>
        {' · '}
        <a href="#/security" style={{ color: '#71717a', textDecoration: 'none' }}>Security</a>
        {' · '}
        <a href="#/dpa" style={{ color: '#71717a', textDecoration: 'none' }}>DPA</a>
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

// ── Benchmark stats bar (Sprint 5A) ─────────────────────────────────────────
// Every figure is measured and links to /benchmark where it can be checked.
// Precision is attributed to the labelled suites only — Spider and BIRD label
// no defects, so they cannot contribute a true or false positive.
const BENCH_STATS: Array<{ value: string; label: string }> = [
  { value: '35', label: 'detectors — deterministic AST, no ML' },
  { value: '5', label: 'surfaces — CLI, VS Code, GitHub Action, dbt, pre-commit' },
  { value: '0.70 ms', label: 'median validation time across 2,654 benchmark queries' },
  { value: '76.4%', label: 'precision on 86 labelled queries; 2,654 total in the benchmark' },
];

function StatsBar() {
  return (
    <section style={{ ...section, paddingTop: 0, paddingBottom: 40 }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
          gap: 12,
        }}
      >
        {BENCH_STATS.map((s) => (
          <div key={s.label} style={{ ...card, textAlign: 'center', padding: 16 }}>
            <div style={{ fontSize: 26, fontWeight: 800, color: '#a78bfa' }}>{s.value}</div>
            <div style={{ color: '#a1a1aa', fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>
              {s.label}
            </div>
          </div>
        ))}
      </div>
      <p style={{ textAlign: 'center', marginTop: 14, fontSize: 12.5, color: '#71717a' }}>
        Measured on 2,654 queries.{' '}
        <a href="#/benchmark" style={{ color: '#a78bfa', fontWeight: 600 }}>
          View full methodology →
        </a>
      </p>
    </section>
  );
}

// ── Progression: local → team → audit-ready (Sprint 5A) ─────────────────────
const TIERS = [
  {
    icon: '⌘',
    kicker: 'Local (Free)',
    body: 'Catch logic errors before you push. 12 core detectors. CLI and VS Code.',
    example: 'Caught: JOIN multiplication on revenue query',
  },
  {
    icon: '⇄',
    kicker: 'Team (Pro + Team)',
    body: 'Enforce SQL quality across your repository. All 35 detectors. CI enforcement. Retained validation history.',
    example: 'Enforced: 0 broken SQL merged this sprint',
  },
  {
    icon: '⛊',
    kicker: 'Audit-ready (Business)',
    body: 'Demonstrate what was checked, what failed, how it was resolved, and who approved it. Compliance exports. Approval workflows. Role-based team access.',
    example: 'Proved: every financial query validated before the audit period',
  },
];

function ProgressionSection() {
  return (
    <section style={section}>
      <h2 style={h2}>One platform. Three levels of control.</h2>
      <div style={cardGrid}>
        {TIERS.map((t) => (
          <div key={t.kicker} style={card}>
            <div style={{ fontSize: 22, color: '#7c3aed', marginBottom: 8 }}>{t.icon}</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#e4e4e7', marginBottom: 8 }}>
              {t.kicker}
            </div>
            <div style={{ color: '#a1a1aa', fontSize: 13, lineHeight: 1.6, marginBottom: 12 }}>
              {t.body}
            </div>
            <div
              style={{
                borderLeft: '2px solid #7c3aed',
                paddingLeft: 10,
                color: '#d4d4d8',
                fontSize: 12.5,
                lineHeight: 1.5,
                fontStyle: 'italic',
              }}
            >
              {t.example}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Comparison table (Sprint 5A) ────────────────────────────────────────────
// SQLFluff and SQLSure are separated deliberately: they are different tools,
// and collapsing them into one column invites a reader to dismiss the whole
// table. Every cell is checkable against the vendors' own documentation.
const COMPARE_COLS = ['SQLFluff', 'SQLSure', 'Soda / Monte Carlo', 'SafeSQL Pro'];
const COMPARE_ROWS: Array<[string, string, string, string, string]> = [
  ['When it runs', 'Before execution', 'Before execution', 'After data lands', 'Before execution'],
  ['What it checks', 'Syntax + style', 'Query semantics', 'Data values & metrics', 'Query semantics'],
  ['Detector breadth', 'Style rules', '9 rules', 'Metric monitors', '35 detectors'],
  ['Fan-out aggregate detection', '✗', '✓', '✗', '✓'],
  ['dbt integration', '✓', '✓', '✓', '✓'],
  ['CI enforcement', '✓', '✓', '✓', '✓'],
  ['Synthetic proof of row inflation', '✗', '✗', '✗', '✓'],
  ['Hosted audit evidence trail', '✗', 'Self-hosted recipe', 'Partial', '✓ (Team+)'],
  ['Price', 'Free / open source', 'Free / open source', '$750–$2,000+/mo', '$0–$599/mo'],
];

function ComparisonTable() {
  const cell: React.CSSProperties = {
    padding: '9px 12px',
    fontSize: 12.5,
    borderBottom: '1px solid #1f1f23',
    textAlign: 'center',
    whiteSpace: 'nowrap',
  };
  return (
    <div style={{ maxWidth: 900, margin: '0 auto 28px' }}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 680 }}>
          <thead>
            <tr>
              <th style={{ ...cell, textAlign: 'left', color: '#a1a1aa', fontWeight: 600 }} />
              {COMPARE_COLS.map((c) => (
                <th
                  key={c}
                  style={{
                    ...cell,
                    color: c === 'SafeSQL Pro' ? '#a78bfa' : '#a1a1aa',
                    fontWeight: 700,
                    borderBottom: '1px solid #27272a',
                  }}
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {COMPARE_ROWS.map((r) => (
              <tr key={r[0]}>
                <td style={{ ...cell, textAlign: 'left', color: '#d4d4d8' }}>{r[0]}</td>
                {r.slice(1).map((v, i) => (
                  <td
                    key={i}
                    style={{
                      ...cell,
                      color: i === 3 ? '#e4e4e7' : '#a1a1aa',
                      fontWeight: i === 3 ? 600 : 400,
                      background: i === 3 ? '#141417' : undefined,
                    }}
                  >
                    {v}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ color: '#71717a', fontSize: 12, lineHeight: 1.7, marginTop: 10 }}>
        SQLSure detects fan-out aggregates and ships dbt and CI integrations — we do not claim
        otherwise. Our differentiators are detector breadth (35 vs 9), executable synthetic proof of
        row inflation, and a hosted, retained audit trail with approvals. Every SafeSQL Pro entry is
        measured on our{' '}
        <a href="#/benchmark" style={{ color: '#a78bfa' }}>
          public benchmark
        </a>
        .
      </p>
    </div>
  );
}

export function PricingSection() {
  const { appUser, isClerkReady } = useAppUser();
  const [cadence, setCadence] = useState<'monthly' | 'annual'>('monthly');
  const [busyPlan, setBusyPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recommended, setRecommended] = useState<RecommendedTier | null>(null);

  const handleUpgrade = async (plan: Plan) => {
    setBusyPlan(plan);
    setError(null);
    const result = await startCheckoutForPlan(plan, cadence, {
      clientReferenceId: appUser?.clerkUserId,
      customerEmail: appUser?.email,
    });
    setBusyPlan(null);
    if (!result.ok) setError(result.message ?? 'Checkout failed.');
  };

  const monthly = cadence === 'monthly';

  return (
    <section id="pricing" style={section}>
      <h2 style={h2}>Pricing</h2>
      <p style={{ ...demoSubhead, marginBottom: 18 }}>
        From local detection to team enforcement and audit-ready evidence.
        <br />
        Annual billing saves 20%.
      </p>

      <ComparisonTable />

      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 22 }}>
        <div style={{ display: 'inline-flex', background: '#0f0f10', border: '1px solid #27272a', borderRadius: 999, padding: 4 }}>
          <button
            type="button"
            onClick={() => setCadence('monthly')}
            style={{ ...toggleBtn, background: monthly ? '#7c3aed' : 'transparent', color: monthly ? 'white' : '#a1a1aa' }}
          >
            Monthly
          </button>
          <button
            type="button"
            onClick={() => setCadence('annual')}
            style={{ ...toggleBtn, background: !monthly ? '#7c3aed' : 'transparent', color: !monthly ? 'white' : '#a1a1aa' }}
          >
            Annual <span style={{ fontSize: 10, opacity: 0.85 }}>−20%</span>
          </button>
        </div>
      </div>

      <p
        style={{
          textAlign: 'center',
          color: '#a1a1aa',
          fontSize: 13.5,
          lineHeight: 1.7,
          maxWidth: 620,
          margin: '0 auto 20px',
        }}
      >
        <strong style={{ color: '#e4e4e7' }}>Start free.</strong> 12 core detectors, CLI and
        pre-commit — no account required. VS Code and CI need a free API key. Upgrade for all 35
        detectors, CI enforcement, and team controls.
      </p>

      <div style={pricingGrid}>
        <PricingCard
          tier="Free"
          price="$0"
          period="forever"
          features={['12 core detectors', '50 validations/month', 'Monaco editor sandbox']}
          cta="Start free"
          href="#/editor"
        />
        <PricingCard
          tier="Pro"
          price={monthly ? '$49' : '$470'}
          period={monthly ? 'per month' : 'per year'}
          highlight
          features={['Unlimited validations', 'AI explanations', 'Apply-fix button', 'Schema connections', 'Query library', 'Shareable permalinks']}
          cta={busyPlan === 'pro' || !isClerkReady ? 'Loading…' : 'Upgrade to Pro'}
          onUpgrade={() => void handleUpgrade('pro')}
          disabled={busyPlan !== null || !isClerkReady}
          recommended={recommended === 'pro'}
        />
        <PricingCard
          tier="Team"
          price={monthly ? '$199' : '$1,910'}
          period={monthly ? 'per month · 5 seats' : 'per year · 5 seats'}
          features={['Everything in Pro', '5 seats', 'Team analytics', 'Approval workflow', 'Shared query library', 'GitHub Action']}
          cta={busyPlan === 'team' || !isClerkReady ? 'Loading…' : 'Start team trial'}
          onUpgrade={() => void handleUpgrade('team')}
          disabled={busyPlan !== null || !isClerkReady}
          recommended={recommended === 'team'}
        />
        <PricingCard
          tier="Business"
          price={monthly ? '$599' : '$5,750'}
          period={monthly ? 'per month · 20 seats' : 'per year · 20 seats'}
          features={['Everything in Team', '20 seats', 'Audit log', 'Custom rules', 'CSV export', 'Slack alerts', 'SOC 2 alignment']}
          cta={busyPlan === 'business' || !isClerkReady ? 'Loading…' : 'Start with Business'}
          onUpgrade={() => void handleUpgrade('business')}
          disabled={busyPlan !== null || !isClerkReady}
          recommended={recommended === 'business'}
          secondaryCta="Talk to sales"
          secondaryHref="mailto:sales@safesqlpro.dev?subject=SafeSQL%20Pro%20Business"
        />
      </div>
      {error && (
        <div
          role="alert"
          style={{
            marginTop: 18,
            padding: 12,
            background: '#450a0a',
            border: '1px solid #7f1d1d',
            borderRadius: 6,
            color: '#fecaca',
            fontSize: 12.5,
            textAlign: 'center',
          }}
        >
          {error}
        </div>
      )}

      <ROICalculator onRecommend={setRecommended} />
    </section>
  );
}

interface PricingCardProps {
  tier: string;
  price: string;
  period: string;
  features: string[];
  cta: string;
  href?: string;
  onUpgrade?: () => void;
  highlight?: boolean;
  disabled?: boolean;
  recommended?: boolean;
  secondaryCta?: string;
  secondaryHref?: string;
}

function PricingCard(props: PricingCardProps) {
  return (
    <div
      style={{
        ...card,
        border: props.highlight || props.recommended ? '1px solid #7c3aed' : '1px solid #27272a',
        position: 'relative',
      }}
    >
      {props.recommended && (
        <span
          style={{
            position: 'absolute',
            top: -10,
            right: 16,
            background: '#16a34a',
            color: 'white',
            fontSize: 10,
            fontWeight: 700,
            padding: '3px 8px',
            borderRadius: 4,
            letterSpacing: 0.5,
          }}
        >
          RECOMMENDED FOR YOUR TEAM
        </span>
      )}
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
      {props.onUpgrade ? (
        <button
          type="button"
          onClick={props.onUpgrade}
          disabled={props.disabled}
          style={{
            width: '100%',
            padding: '8px 14px',
            borderRadius: 5,
            fontSize: 13,
            fontWeight: 600,
            border: 'none',
            cursor: props.disabled ? 'wait' : 'pointer',
            background: props.highlight ? '#7c3aed' : '#27272a',
            color: props.highlight ? 'white' : '#e4e4e7',
            opacity: props.disabled ? 0.6 : 1,
          }}
        >
          {props.cta}
        </button>
      ) : (
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
      )}
      {props.secondaryCta && props.secondaryHref && (
        <a
          href={props.secondaryHref}
          style={{
            display: 'block',
            textAlign: 'center',
            marginTop: 8,
            padding: '8px 14px',
            borderRadius: 5,
            fontSize: 13,
            fontWeight: 600,
            textDecoration: 'none',
            background: 'transparent',
            border: '1px solid #3f3f46',
            color: '#a1a1aa',
          }}
        >
          {props.secondaryCta}
        </a>
      )}
    </div>
  );
}

const toggleBtn: React.CSSProperties = {
  border: 'none',
  borderRadius: 999,
  padding: '6px 14px',
  fontSize: 12.5,
  fontWeight: 600,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: 4,
};

// ── Styles ──────────────────────────────────────────────────────────────────



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
