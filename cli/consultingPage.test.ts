import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Sprint 9.5A — /consulting. Same "copy proves code" pattern as
// tierClaims.test.ts: the page is read as source text (rendering it would drag
// Clerk in), and every promise on it is checked against the shipped file that
// backs it. Nav order and routing are asserted so the link cannot silently
// drop out of either header.

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const page = read('src/pages/Consulting.tsx');

describe('/consulting page — structure', () => {
  it('renders all six sections in order', () => {
    const ids = ['consulting-hero', 'consulting-offerings', 'consulting-evidence', 'consulting-industries', 'consulting-steps', 'consulting-cta'];
    const positions = ids.map((id) => page.indexOf(`id="${id}"`));
    expect(positions.every((p) => p > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('every CTA is a mailto with the pre-filled subject', () => {
    expect(page).toContain(`SUBJECT('Scoping%20Call')`);
    expect(page).toContain(`SUBJECT('SQL%20Health%20Check')`);
    expect(page).toContain(`SUBJECT('Governance%20Audit')`);
    expect(page).toContain(`SUBJECT('Advisory%20Retainer')`);
    expect(page).toContain("const SUBJECT = (s: string) => `${MAIL}?subject=SafeSQL%20Pro%20Consulting%20%E2%80%94%20${s}`");
    expect(page).toContain("const MAIL = 'mailto:eddy@mpingo.ai'");
    // no bare http CTA sneaks in
    expect(page).not.toMatch(/href="https?:/);
  });

  it('three offerings with the brief prices, durations and the MOST POPULAR highlight on card 2', () => {
    const cards = ['FASTEST', 'MOST POPULAR', 'ONGOING'];
    const at = cards.map((c) => page.indexOf(`badge: '${c}'`));
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(page).toContain("price: 'From $2,500'");
    expect(page).toContain("price: 'From $10,000'");
    expect(page).toContain("price: 'From $2,000/month'");
    expect(page).toContain("duration: '3–7 business days'");
    expect(page).toContain("duration: '3–6 weeks'");
    expect(page).toContain("duration: '3-month minimum'");
    const audit = page.slice(at[1], at[2]);
    expect(audit).toContain("name: 'Governance Audit'");
    expect(audit).toContain('highlight: true');
    // the other two are not highlighted
    expect(page.slice(at[0], at[1])).not.toContain('highlight: true');
    expect(page.slice(at[2], page.indexOf('PROOF_POINTS'))).not.toContain('highlight: true');
    // highlight drives the violet border, same hex as the Pro card on /pricing
    expect(page).toContain("const VIOLET = '#7c3aed'");
    expect(read('src/pages/Landing.tsx')).toContain("'1px solid #7c3aed'");
  });

  it('terminal block is the exact five-line format, confirmation earned by three PASS lines', () => {
    const lines = [
      '$ node verify.mjs',
      'PASS event hashes        2847/2847',
      'PASS chain linkage       2847/2847',
      'PASS bundle_hash         3f9a1c2e…',
      '✅ BUNDLE INTEGRITY CONFIRMED (2,847 events verified)',
    ];
    for (const l of lines) expect(page).toContain(`'${l}'`);
    // and the confirmed line is the only green on the page
    expect(page.match(/CONFIRM\b/g)?.length).toBe(2); // the const + its one use
  });

  it('design constraints hold: no shadows, no gradients, no new fonts', () => {
    expect(page).not.toMatch(/boxShadow/);
    expect(page).not.toMatch(/gradient/);
    expect(page).not.toMatch(/@import|fonts\.googleapis/);
    expect(page).toContain('"JetBrains Mono", Menlo, Consolas, monospace');
  });
});

describe('/consulting page — every claim maps to shipped code', () => {
  it('35-detector scan → TOTAL_DETECTORS is 35 and the batch scanner exists', () => {
    // FREE_DETECTOR_SLUGS (12) + the Pro additions (23) = TOTAL_DETECTORS (35)
    const tiers = read('src/config/detectorTiers.ts');
    const slugs = tiers.slice(tiers.indexOf('FREE_DETECTOR_SLUGS'), tiers.indexOf('TOTAL_DETECTORS'));
    expect((slugs.match(/^\s+'[A-Z_]+',/gm) ?? []).length).toBe(35);
    expect(read('cli/batchScan.ts')).toContain('export async function runBatchScan');
  });

  it('Critical → Risky → Review is the batch report vocabulary', () => {
    expect(read('cli/batchScan.ts')).toContain("export type ReportSeverity = 'Critical' | 'Risky' | 'Review'");
  });

  it('signed evidence bundle + verify.mjs are shipped', () => {
    const bundle = read('src/services/evidenceBundle.ts');
    expect(bundle).toContain('export const VERIFY_SCRIPT');
    expect(bundle).toContain("check(hashOk === rows.length, 'event hashes'");
    expect(bundle).toContain("check(linkOk === rows.length, 'chain linkage'");
    expect(bundle).toContain("'bundle_hash'");
    expect(bundle).toContain('export async function signBundle');
  });

  it('tamper-evident hash chain, approvals with separation of duties, custom rules in CI are shipped', () => {
    expect(read('src/services/auditChain.ts')).toContain('export async function verifyChain');
    expect(read('supabase/migrations/20260911000000_compliance_audit_events.sql')).toContain('audit_events');
    expect(read('src/services/approvalPolicy.ts')).toContain('export function evaluateApprovalPolicies');
    expect(read('functions/api/validate.ts')).toContain('RULE_ENFORCEMENT_PLANS');
  });
});

describe('/consulting — nav and routing', () => {
  it('SiteNav order is How To · Consulting · Open Editor → · Benchmark · Pricing', () => {
    const nav = read('src/components/SiteNav.tsx');
    expect(nav).toContain("'landing' | 'how-to' | 'consulting' | 'benchmark' | 'pricing'");
    const order = ["label: 'How To'", "label: 'Consulting'", "label: 'Benchmark'", "label: 'Pricing'"].map((s) => nav.indexOf(s));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // first two links precede the editor CTA, the rest follow it
    expect(nav).toContain('LINKS.slice(0, 2).map');
    expect(nav.indexOf('LINKS.slice(0, 2).map')).toBeLessThan(nav.indexOf('href="#/editor"'));
    expect(nav.indexOf('href="#/editor"')).toBeLessThan(nav.indexOf('LINKS.slice(2).map'));
  });

  it('Editor header has Consulting right after How To', () => {
    const editor = read('src/pages/Editor.tsx');
    const howTo = editor.indexOf('href="#/how-to" style={navLink}>How To</a>');
    const consulting = editor.indexOf('href="#/consulting" style={navLink}>Consulting</a>');
    expect(howTo).toBeGreaterThan(0);
    expect(consulting).toBeGreaterThan(howTo);
    expect(editor.slice(howTo + 1, consulting)).not.toContain('href="#/');
  });

  it('App routes #/consulting to ConsultingPage', () => {
    const app = read('src/App.tsx');
    expect(app).toContain("if (h.startsWith('/consulting')) return 'consulting';");
    expect(app).toContain("case 'consulting':\n      return <ConsultingPage />;");
    expect(page).toContain('<SiteNav current="consulting" />');
  });
});
