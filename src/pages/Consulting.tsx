import { SiteNav } from '../components/SiteNav';

// Sprint 9.5A — /consulting. A spec sheet, not a brochure: left-aligned,
// hairline-ruled sections, every fact-number set in the editor's mono stack,
// and exactly one violet application per section. The page's single visual
// peak is the verify.mjs terminal in section 3 — every claim above it maps to
// shipped code (safesql scan, the audit chain, signed evidence bundles).

// ── Tokens (all pre-existing in the app) ─────────────────────────────────────
const INK = '#09090b';
const PANEL = '#0f0f10';
const RULE = '#27272a';
const TEXT = '#e4e4e7';
const MUTED = '#a1a1aa';
const DIM = '#71717a';
const VIOLET = '#7c3aed';
const CONFIRM = '#22c55e';
const MONO = '"JetBrains Mono", Menlo, Consolas, monospace';

const MAIL = 'mailto:eddy@mpingo.ai';
const SUBJECT = (s: string) => `${MAIL}?subject=SafeSQL%20Pro%20Consulting%20%E2%80%94%20${s}`;
const CONSULTING_LINKS = {
  scoping: SUBJECT('Scoping%20Call'),
  healthCheck: SUBJECT('SQL%20Health%20Check'),
  audit: SUBJECT('Governance%20Audit'),
  retainer: SUBJECT('Advisory%20Retainer'),
  direct: MAIL,
} as const;

// ── Content ──────────────────────────────────────────────────────────────────
interface Offering {
  badge: string;
  name: string;
  price: string;
  duration: string;
  tagline: string;
  bullets: string[];
  cta: string;
  href: string;
  highlight?: boolean;
}

const OFFERINGS: Offering[] = [
  {
    badge: 'FASTEST',
    name: 'SQL Health Check',
    price: 'From $2,500',
    duration: '3–7 business days',
    tagline: 'Find every logic error hiding in your SQL.',
    bullets: [
      '35-detector scan of your SQL or dbt project',
      'Risk-ranked findings: Critical → Risky → Review',
      'Plain-language executive summary',
      'Signed evidence bundle — verifiable offline',
      '60-minute review call included',
    ],
    cta: 'Get a quote →',
    href: CONSULTING_LINKS.healthCheck,
  },
  {
    badge: 'MOST POPULAR',
    name: 'Governance Audit',
    price: 'From $10,000',
    duration: '3–6 weeks',
    tagline: 'Build the evidence trail your auditor asks for.',
    bullets: [
      'Everything in SQL Health Check',
      'Custom rules enforced in your CI/CD pipeline',
      'Approval workflow with separation of duties',
      'Tamper-evident audit chain — hash-linked, immutable',
      'Signed evidence bundle at close',
    ],
    cta: 'Schedule a call →',
    href: CONSULTING_LINKS.audit,
    highlight: true,
  },
  {
    badge: 'ONGOING',
    name: 'Advisory Retainer',
    price: 'From $2,000/month',
    duration: '3-month minimum',
    tagline: 'Governance as a service. Evidence keeps building.',
    bullets: [
      'SafeSQL Pro Business license included',
      'Monthly evidence report for your compliance team',
      'Custom rule updates as your stack evolves',
      'Quarterly signed evidence bundle',
      'Slack/email advisory (8 hrs/month)',
    ],
    cta: 'Talk to us →',
    href: CONSULTING_LINKS.retainer,
  },
];

const PROOF_POINTS = [
  'Every query validated before execution — logged',
  'Every issue found — documented with fix guidance',
  'Every approval — recorded with role and timestamp',
  'Hash chain — any tampering breaks the chain',
  'verify.mjs included — your auditor runs it with Node.js, no SafeSQL Pro account required',
];

const INDUSTRIES = [
  {
    name: 'Financial Services & FinTech',
    icon: 'shield',
    copy: 'SOX, SOC 2, and CBK/BoT compliance. Revenue metric accuracy. East African mobile money reconciliation.',
  },
  {
    name: 'Healthcare & Life Sciences',
    icon: 'heart',
    copy: 'HIPAA data pipelines. FDA 21 CFR Part 11. Clinical trial data integrity.',
  },
  {
    name: 'Industrial & Manufacturing',
    icon: 'gear',
    copy: 'Oracle/SAP ERP data quality. ISO 9001. SOX compliance for public companies.',
  },
  {
    name: 'Technology & SaaS',
    icon: 'code',
    copy: 'dbt-heavy analytics teams. AI/ML data quality. GDPR compliance for user data pipelines.',
  },
] as const;

const STEPS = [
  {
    title: 'Scoping call',
    meta: '30 min, no cost',
    copy: 'We review your SQL stack and recommend the right offering. You leave with a fixed scope and price — no open-ended statements of work.',
  },
  {
    title: 'Read-only access',
    meta: 'one-page agreement',
    copy: 'One-page agreement. Read-only repo or dbt project access. No database credentials needed for the SQL Health Check.',
  },
  {
    title: 'Delivery and handover',
    meta: 'everything transfers',
    copy: 'Report, evidence bundle, configured framework — all yours. No lock-in. Everything transfers at close.',
  },
];

// ── Icons (inline SVG, stroke-only, inherit currentColor) ────────────────────
function Icon({ name }: { name: (typeof INDUSTRIES)[number]['icon'] }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (name) {
    case 'shield':
      return (
        <svg {...common}>
          <path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6l7-3z" />
          <path d="M9 12l2 2 4-4" />
        </svg>
      );
    case 'heart':
      return (
        <svg {...common}>
          <path d="M12 20s-7-4.5-7-10a4 4 0 017-2.5A4 4 0 0119 10c0 5.5-7 10-7 10z" />
          <path d="M8 11h2l1-2 2 4 1-2h2" />
        </svg>
      );
    case 'gear':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" />
        </svg>
      );
    case 'code':
      return (
        <svg {...common}>
          <path d="M8 8l-4 4 4 4M16 8l4 4-4 4M14 4l-4 16" />
        </svg>
      );
  }
}

// ── Page ─────────────────────────────────────────────────────────────────────
export function ConsultingPage() {
  return (
    <div style={{ background: INK, color: TEXT, minHeight: '100vh' }}>
      <SiteNav current="consulting" />

      {/* 1 — Hero. Violet: the CTA. */}
      <section style={section} aria-labelledby="consulting-hero">
        <div style={kicker}>Mpingo Systems · SafeSQL Pro</div>
        <h1 id="consulting-hero" style={h1}>SQL Governance Consulting</h1>
        <p style={lede}>
          We catch the logic errors your AI copilot introduced, your linter missed, and your
          observability tool will only find after the number is already wrong.
        </p>
        <p style={body}>
          Powered by SafeSQL Pro — 35 deterministic detectors, tamper-evident audit chains, and
          signed evidence bundles your auditor can verify offline.
        </p>
        <a href={CONSULTING_LINKS.scoping} style={primaryButton}>
          Schedule a scoping call →
        </a>
      </section>

      {/* 2 — Offerings. Violet: card 2's border + badge. */}
      <section style={section} aria-labelledby="consulting-offerings">
        <h2 id="consulting-offerings" style={h2}>Three engagements. Fixed scope, fixed price.</h2>
        <div style={grid3}>
          {OFFERINGS.map((o) => (
            <OfferingCard key={o.name} {...o} />
          ))}
        </div>
      </section>

      {/* 3 — Evidence bundle. Violet: the $ prompt. Green: the one confirmed line. */}
      <section style={section} aria-labelledby="consulting-evidence">
        <h2 id="consulting-evidence" style={h2}>Every engagement delivers a signed evidence bundle.</h2>
        <p style={{ ...body, maxWidth: 720 }}>
          Not a PDF. A cryptographically signed, offline-verifiable artifact — the kind of evidence a
          SOC 2 Type II auditor or SOX examiner actually needs.
        </p>
        <Terminal />
        <ul style={proofList} aria-label="What the evidence bundle proves">
          {PROOF_POINTS.map((p) => (
            <li key={p} style={proofItem}>
              <span style={proofTick} aria-hidden>✓</span>
              <span>{p}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* 4 — Industries. Violet: the index numerals. */}
      <section style={section} aria-labelledby="consulting-industries">
        <h2 id="consulting-industries" style={h2}>Industries we serve</h2>
        <div style={grid2}>
          {INDUSTRIES.map((ind, i) => (
            <div key={ind.name} style={panel}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                <span style={index}>{String(i + 1).padStart(2, '0')}</span>
                <span style={{ color: MUTED, display: 'inline-flex' }}>
                  <Icon name={ind.icon} />
                </span>
                <span style={{ fontSize: 15, fontWeight: 700, color: TEXT }}>{ind.name}</span>
              </div>
              <p style={{ ...body, margin: 0, fontSize: 13 }}>{ind.copy}</p>
            </div>
          ))}
        </div>
      </section>

      {/* 5 — How it works. Violet: the step numerals. */}
      <section style={section} aria-labelledby="consulting-steps">
        <h2 id="consulting-steps" style={h2}>How it works</h2>
        <ol style={{ ...grid3, listStyle: 'none', padding: 0, margin: 0 }}>
          {STEPS.map((s, i) => (
            <li key={s.title} style={{ borderTop: `1px solid ${RULE}`, paddingTop: 16 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
                <span style={index}>{String(i + 1).padStart(2, '0')}</span>
                <span style={{ fontSize: 16, fontWeight: 700 }}>{s.title}</span>
              </div>
              <div style={{ ...mono, fontSize: 11, color: DIM, marginBottom: 10 }}>{s.meta}</div>
              <p style={{ ...body, margin: 0, fontSize: 13 }}>{s.copy}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* 6 — Bottom CTA. Violet: the button. */}
      <section style={{ ...section, borderBottom: 'none', paddingBottom: 80 }} aria-labelledby="consulting-cta">
        <h2 id="consulting-cta" style={{ ...h2, fontSize: 32 }}>Ready to find what's hiding in your SQL?</h2>
        <p style={{ ...body, marginBottom: 22 }}>
          Schedule a 30-minute scoping call.
          <br />
          No cost, no commitment.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
          <a href={CONSULTING_LINKS.scoping} style={{ ...primaryButton, padding: '12px 22px', fontSize: 15 }}>
            Schedule a scoping call →
          </a>
          <span style={{ fontSize: 13, color: MUTED }}>
            Or email{' '}
            <a href={CONSULTING_LINKS.direct} style={{ color: TEXT, textDecoration: 'underline' }}>
              eddy@mpingo.ai
            </a>{' '}
            directly.
          </span>
        </div>
      </section>

      <footer style={{ padding: '20px 32px', borderTop: `1px solid ${RULE}`, fontSize: 13, color: DIM }}>
        Mpingo Systems LLC · Charlotte, NC · SafeSQL Pro v0.11.0 · 35 detectors ·{' '}
        <a href="#/compliance" style={{ color: MUTED }}>Compliance</a> ·{' '}
        <a href="#/security" style={{ color: MUTED }}>Security</a>
      </footer>
    </div>
  );
}

// ── Offering card: an instrument panel — mono header strip, mono readout ─────
function OfferingCard(o: Offering) {
  const edge = o.highlight ? VIOLET : RULE;
  return (
    <article
      style={{ ...panel, padding: 0, border: `1px solid ${edge}`, display: 'flex', flexDirection: 'column' }}
      aria-label={o.name}
    >
      <div
        style={{
          ...mono,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '10px 20px',
          borderBottom: `1px solid ${edge}`,
          fontSize: 10,
          letterSpacing: 1,
          textTransform: 'uppercase',
        }}
      >
        <span
          style={{
            fontWeight: 700,
            color: o.highlight ? 'white' : MUTED,
            background: o.highlight ? VIOLET : 'transparent',
            padding: o.highlight ? '2px 7px' : 0,
            borderRadius: 3,
          }}
        >
          {o.badge}
        </span>
        <span style={{ color: DIM }}>{o.duration}</span>
      </div>
      <div style={{ padding: '20px 20px 22px', display: 'flex', flexDirection: 'column', flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: MUTED, marginBottom: 6 }}>{o.name}</div>
        <div style={{ ...mono, fontSize: 30, fontWeight: 700, color: TEXT, letterSpacing: -0.5, marginBottom: 12 }}>
          {o.price}
        </div>
        <p style={{ fontSize: 15, fontWeight: 600, color: TEXT, margin: '0 0 16px', lineHeight: 1.4 }}>{o.tagline}</p>
        <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 22px', flex: 1 }}>
          {o.bullets.map((b) => (
            <li key={b} style={{ color: '#d4d4d8', fontSize: 13, padding: '4px 0', lineHeight: 1.45 }}>
              ✓ {b}
            </li>
          ))}
        </ul>
        <a
          href={o.href}
          style={{
            ...primaryButton,
            textAlign: 'center',
            background: o.highlight ? VIOLET : RULE,
            color: o.highlight ? 'white' : TEXT,
          }}
        >
          {o.cta}
        </a>
      </div>
    </article>
  );
}

// ── The terminal: the page's one visual peak ─────────────────────────────────
const TERMINAL_LINES = [
  '$ node verify.mjs',
  'PASS event hashes        2847/2847',
  'PASS chain linkage       2847/2847',
  'PASS bundle_hash         3f9a1c2e…',
  '✅ BUNDLE INTEGRITY CONFIRMED (2,847 events verified)',
] as const;

function Terminal() {
  return (
    <div
      role="img"
      aria-label="Terminal: node verify.mjs reports PASS for event hashes, chain linkage and bundle_hash, then BUNDLE INTEGRITY CONFIRMED, 2,847 events verified"
      style={{ ...panel, padding: 0, background: '#0a0a0a', margin: '28px 0 26px', overflow: 'hidden' }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 16px',
          borderBottom: `1px solid ${RULE}`,
          ...mono,
          fontSize: 11,
          color: DIM,
        }}
      >
        <span style={dot} />
        <span style={dot} />
        <span style={dot} />
        <span style={{ marginLeft: 8 }}>safesql-health-check-2026-09-20-3f9a1c2e.zip</span>
      </div>
      <pre style={{ ...mono, margin: 0, padding: '18px 20px 20px', fontSize: 14, lineHeight: 1.7, overflowX: 'auto' }}>
        <span style={{ color: VIOLET }}>$</span>
        <span style={{ color: TEXT }}> node verify.mjs</span>
        {'\n'}
        {TERMINAL_LINES.slice(1, 4).map((l) => (
          <span key={l}>
            <span style={{ color: MUTED }}>{l.slice(0, 4)}</span>
            <span style={{ color: '#d4d4d8' }}>{l.slice(4)}</span>
            {'\n'}
          </span>
        ))}
        <span style={{ color: CONFIRM, fontWeight: 700, fontSize: 16 }}>{TERMINAL_LINES[4]}</span>
      </pre>
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────
const mono: React.CSSProperties = { fontFamily: MONO };

const section: React.CSSProperties = {
  padding: '56px 32px',
  maxWidth: 1100,
  margin: '0 auto',
  borderBottom: `1px solid ${RULE}`,
};

const kicker: React.CSSProperties = {
  ...mono,
  fontSize: 11,
  letterSpacing: 1,
  textTransform: 'uppercase',
  color: DIM,
  marginBottom: 14,
};

const h1: React.CSSProperties = {
  fontSize: 48,
  fontWeight: 800,
  letterSpacing: -1,
  lineHeight: 1.1,
  margin: '0 0 18px',
  color: TEXT,
};

const h2: React.CSSProperties = {
  fontSize: 28,
  fontWeight: 700,
  letterSpacing: -0.5,
  margin: '0 0 14px',
  textAlign: 'left',
};

const lede: React.CSSProperties = {
  fontSize: 21,
  lineHeight: 1.45,
  color: TEXT,
  maxWidth: 760,
  margin: '0 0 14px',
};

const body: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.65,
  color: MUTED,
  maxWidth: 760,
  margin: '0 0 26px',
};

const primaryButton: React.CSSProperties = {
  background: VIOLET,
  color: 'white',
  textDecoration: 'none',
  padding: '10px 18px',
  borderRadius: 5,
  fontSize: 14,
  fontWeight: 600,
  display: 'inline-block',
};

const grid3: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
  gap: 16,
  marginTop: 24,
};

const grid2: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
  gap: 16,
  marginTop: 24,
};

const panel: React.CSSProperties = {
  background: PANEL,
  border: `1px solid ${RULE}`,
  borderRadius: 10,
  padding: 20,
};

const index: React.CSSProperties = {
  ...mono,
  fontSize: 12,
  fontWeight: 700,
  color: VIOLET,
  letterSpacing: 1,
};

const proofList: React.CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: 0,
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
  gap: '8px 24px',
};

const proofItem: React.CSSProperties = {
  display: 'flex',
  gap: 10,
  alignItems: 'flex-start',
  fontSize: 14,
  color: '#d4d4d8',
  lineHeight: 1.5,
};

const proofTick: React.CSSProperties = {
  ...mono,
  color: MUTED,
  flexShrink: 0,
};

const dot: React.CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: 999,
  border: `1px solid ${RULE}`,
  display: 'inline-block',
};
