import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

// Sprint 9 item 6 — every feature string on the Team and Business pricing
// cards must map to something shipped. This is the guard against the pattern
// the pre-Sprint-9 audit found: copy ahead of code. Lives in cli/ because it
// reads files with node:fs (tsconfig.app.json has no Node types).
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const landing = readFileSync(join(ROOT, 'src/pages/Landing.tsx'), 'utf8');

function featuresOf(tier: string): string[] {
  const m = new RegExp(`tier="${tier}"[\\s\\S]*?features=\\{\\[([^\\]]+)\\]\\}`).exec(landing);
  if (!m) throw new Error(`no features for ${tier}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

// Each claim → a file that implements it (relative to repo root).
const PROOF: Record<string, string[]> = {
  'Everything in Pro': [],
  'Everything in Team': [],
  '5 seats': ['supabase/migrations/20260826000000_team_seats.sql'],
  '20 seats': ['supabase/migrations/20260826000000_team_seats.sql', 'supabase/migrations/20260911030000_compliance_team_plan_sync.sql'],
  'Team analytics': ['src/pages/TeamAnalytics.tsx'],
  'Approval workflow (separation of duties)': ['functions/api/teams/approvals/[id]/resolve.ts', 'supabase/migrations/20260911020000_compliance_roles_and_approvals.sql'],
  'Shared query library': ['src/pages/QueryLibrary.tsx'],
  'GitHub Action': ['action.yml'],
  'Tamper-evident audit chain': ['supabase/migrations/20260911000000_compliance_audit_events.sql', 'src/services/auditChain.ts'],
  'Custom rules enforced in CI + API': ['functions/api/teams/rules/index.ts', 'functions/api/validate.ts'],
  'CSV + signed evidence bundles': ['functions/api/teams/audit.ts', 'functions/api/teams/evidence/bundle.ts'],
  'Slack alerts (manual send)': ['functions/api/webhook/notify.ts'],
  'SOC 2 alignment': ['src/pages/Compliance.tsx'],
};

describe('pricing-card claims are backed by shipped code', () => {
  for (const tier of ['Team', 'Business']) {
    it(`${tier} card`, () => {
      const features = featuresOf(tier);
      expect(features.length).toBeGreaterThan(0);
      for (const f of features) {
        expect(PROOF, `unlisted claim on ${tier} card: "${f}"`).toHaveProperty(f);
        for (const file of PROOF[f]) {
          expect(existsSync(join(ROOT, file)), `${f} → ${file} missing`).toBe(true);
        }
      }
    });
  }

  it('the Business card still has exactly 7 features and prices are untouched', () => {
    expect(featuresOf('Business')).toHaveLength(7);
    expect(landing).toContain("price={monthly ? '$599' : '$5,750'}");
    expect(landing).toContain("price={monthly ? '$199' : '$1,910'}");
  });

  it('the compliance page documents the five Sprint 9 controls and does not claim certification', () => {
    const compliance = readFileSync(join(ROOT, 'src/pages/Compliance.tsx'), 'utf8');
    for (const phrase of ['hash chain', 'cannot be updated or deleted', 'Separation of duties', 'signed evidence bundle', 'auditor']) {
      expect(compliance).toContain(phrase);
    }
    expect(compliance).toContain('not a formal certification');
    expect(compliance).not.toMatch(/SOC 2 certified/i);
  });
});
