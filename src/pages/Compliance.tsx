// Sprint 8 Part 4 — SOC 2 Type 1 alignment page (static), linked from Enterprise pricing.
export function CompliancePage() {
  return (
    <div style={{ background: '#09090b', color: '#e4e4e7', minHeight: '100vh', padding: 32 }}>
      <a href="#/" style={{ color: '#a78bfa', textDecoration: 'none', fontSize: 13 }}>← SafeSQL Pro</a>
      <div style={{ maxWidth: 760, margin: '24px auto 0' }}>
        <h1 style={{ fontSize: 26 }}>How SafeSQL Pro supports SOC 2 Type 1</h1>
        <p style={{ color: '#a1a1aa', lineHeight: 1.6 }}>
          SafeSQL Pro is designed so that an auditor's SQL-validation questions have a documented answer.
          The controls below map to the five Trust Services Criteria.
        </p>
        {SECTIONS.map((s) => (
          <div key={s.title} style={{ borderLeft: '2px solid #7c3aed', paddingLeft: 14, margin: '20px 0' }}>
            <h2 style={{ fontSize: 16, margin: '0 0 4px' }}>{s.title}</h2>
            <p style={{ color: '#d4d4d8', fontSize: 14, lineHeight: 1.6, margin: 0 }}>{s.body}</p>
          </div>
        ))}
        <p style={{ color: '#71717a', fontSize: 12, marginTop: 24 }}>
          SOC 2 Type 1 alignment is a documentation posture, not a formal certification. Contact us for the
          full security questionnaire and audit-log export.
        </p>
      </div>
    </div>
  );
}

const SECTIONS = [
  { title: 'Security', body: 'HTTPS enforced on every request (Cloudflare). API keys are stored only as SHA-256 hashes — the raw key is shown once and never persisted.' },
  { title: 'Availability', body: 'Served on Cloudflare Pages + Workers global edge network with their platform SLA. The detection engine is deterministic and runs in-region with no external dependency.' },
  { title: 'Confidentiality', body: 'Schema DDL is not stored — only a SHA-256 hash of the validated SQL is kept for the audit trail. No production data passes through SafeSQL Pro.' },
  { title: 'Processing Integrity', body: 'Detection is deterministic AST rules — 33+ semantic detectors that either fire or do not. No AI makes a detection decision, so there are no hallucinated findings.' },
  { title: 'Audit trail', body: 'Every validation is logged with user, timestamp, score, and issue types (append-only audit_log). Managers can export the full team trail as CSV.' },
];
