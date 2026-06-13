import { useEffect, useMemo, useState } from 'react';
import { useAppUser } from '../hooks/useAppUser';
import { startCheckoutForPlan, type Plan } from '../services/stripe';

// Sprint 10 Part 4 — pricing-page ROI calculator. Pure compute is exported and
// unit-tested; the component renders sliders + live stat cards in the existing
// dark theme (no new colors).

export type RecommendedTier = 'pro' | 'team' | 'business' | 'enterprise';

const ISSUE_RATE = 0.25; // BIRD benchmark — ~25% of (AI) SQL is wrong
const HOURS_PER_ISSUE = 0.5; // 30 min avg to find + fix
const WORKDAYS_PER_MONTH = 22;
const ANNUAL_WORK_HOURS = 2080;

const TIER_MONTHLY: Record<RecommendedTier, number> = { pro: 49, team: 199, business: 599, enterprise: 599 };

export interface ROIInputs {
  analysts: number;
  salary: number; // annual USD
  validationsPerDay: number;
}

export interface ROIResult {
  queriesPerMonth: number;
  issuesPerMonth: number;
  hoursSaved: number;
  monthlyDebuggingCost: number;
  tier: RecommendedTier;
  safesqlCost: number;
  monthlySavings: number;
  annualRoiMultiple: number;
}

export function recommendTier(analysts: number): RecommendedTier {
  if (analysts <= 1) return 'pro';
  if (analysts <= 5) return 'team';
  if (analysts <= 20) return 'business';
  return 'enterprise';
}

export function computeROI(inputs: ROIInputs): ROIResult {
  const queriesPerMonth = inputs.analysts * inputs.validationsPerDay * WORKDAYS_PER_MONTH;
  const issuesPerMonth = queriesPerMonth * ISSUE_RATE;
  const hoursSaved = issuesPerMonth * HOURS_PER_ISSUE;
  const hourlyRate = inputs.salary / ANNUAL_WORK_HOURS;
  const monthlyDebuggingCost = issuesPerMonth * HOURS_PER_ISSUE * hourlyRate;
  const tier = recommendTier(inputs.analysts);
  const safesqlCost = TIER_MONTHLY[tier];
  const monthlySavings = monthlyDebuggingCost - safesqlCost;
  const annualRoiMultiple = safesqlCost > 0 ? (monthlySavings * 12) / (safesqlCost * 12) : 0;
  return {
    queriesPerMonth,
    issuesPerMonth,
    hoursSaved,
    monthlyDebuggingCost,
    tier,
    safesqlCost,
    monthlySavings,
    annualRoiMultiple,
  };
}

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;

interface Props {
  onRecommend?: (tier: RecommendedTier) => void;
}

export function ROICalculator({ onRecommend }: Props) {
  const { appUser, isClerkReady } = useAppUser();
  const [analysts, setAnalysts] = useState(5);
  const [salary, setSalary] = useState(100_000);
  const [validationsPerDay, setValidationsPerDay] = useState(5);

  const roi = useMemo(() => computeROI({ analysts, salary, validationsPerDay }), [analysts, salary, validationsPerDay]);

  // Surface the recommendation to the pricing cards above.
  useEffect(() => {
    onRecommend?.(roi.tier);
  }, [roi.tier, onRecommend]);

  const perAnalyst = roi.safesqlCost / Math.max(1, analysts);

  const checkout = async () => {
    if (roi.tier === 'enterprise') {
      window.location.href = 'mailto:support@safesqlpro.dev?subject=SafeSQL%20Pro%20Enterprise';
      return;
    }
    await startCheckoutForPlan(roi.tier as Plan, 'monthly', {
      clientReferenceId: appUser?.clerkUserId,
      customerEmail: appUser?.email,
    });
  };

  return (
    <section style={{ padding: '40px 32px', maxWidth: 1100, margin: '0 auto' }}>
      <h2 style={{ fontSize: 28, fontWeight: 700, textAlign: 'center', marginBottom: 8 }}>Calculate your ROI</h2>
      <p style={{ fontSize: 14, color: '#a1a1aa', textAlign: 'center', marginBottom: 24 }}>
        See how much bad SQL is costing your team.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 24 }}>
        {/* Inputs */}
        <div style={card}>
          <Slider label="Number of analysts" value={analysts} min={1} max={50} onChange={setAnalysts} display={String(analysts)} />
          <Slider label="Avg analyst salary" value={salary} min={50_000} max={200_000} step={5_000} onChange={setSalary} display={money(salary)} />
          <Slider label="Validations per analyst / day" value={validationsPerDay} min={1} max={20} onChange={setValidationsPerDay} display={String(validationsPerDay)} />
          <div style={{ fontSize: 12, color: '#71717a', marginTop: 8 }} title="Based on the BIRD benchmark — LLMs produce wrong SQL ~25% of the time">
            % of queries with issues: <strong style={{ color: '#a1a1aa' }}>25%</strong> (industry avg, BIRD benchmark)
          </div>
        </div>

        {/* Output */}
        <div style={card}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Stat label="Issues caught / month" value={String(Math.round(roi.issuesPerMonth))} />
            <Stat label="Debugging time saved" value={`${roi.hoursSaved.toFixed(1)} hrs`} />
            <Stat label="Monthly savings" value={money(roi.monthlySavings)} accent="#22c55e" />
            <Stat label="Annual ROI" value={`${roi.annualRoiMultiple.toFixed(0)}× return`} accent="#a78bfa" />
          </div>
          <p style={{ fontSize: 13, color: '#d4d4d8', lineHeight: 1.6, marginTop: 16 }}>
            SafeSQL Pro <strong style={{ color: '#e4e4e7', textTransform: 'capitalize' }}>{roi.tier}</strong> costs {money(roi.safesqlCost)}/month.
            For your team of {analysts}, that's {money(perAnalyst)} per analyst. You save{' '}
            <strong style={{ color: '#22c55e' }}>{money(roi.monthlySavings)}</strong> every month — a {roi.annualRoiMultiple.toFixed(0)}× return on investment.
          </p>
          <button
            type="button"
            onClick={() => void checkout()}
            disabled={roi.tier !== 'enterprise' && !isClerkReady}
            style={{
              ...cta,
              cursor: roi.tier !== 'enterprise' && !isClerkReady ? 'not-allowed' : 'pointer',
              opacity: roi.tier !== 'enterprise' && !isClerkReady ? 0.6 : 1,
            }}
          >
            {roi.tier === 'enterprise'
              ? 'Contact sales →'
              : !isClerkReady
                ? 'Loading…'
                : `Get started for ${money(roi.safesqlCost)}/month →`}
          </button>
        </div>
      </div>
    </section>
  );
}

function Slider({ label, value, min, max, step = 1, onChange, display }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; display: string }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#a1a1aa', marginBottom: 6 }}>
        <span>{label}</span>
        <strong style={{ color: '#e4e4e7' }}>{display}</strong>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ width: '100%', accentColor: '#7c3aed' }} />
    </div>
  );
}

function Stat({ label, value, accent = '#e4e4e7' }: { label: string; value: string; accent?: string }) {
  return (
    <div style={{ border: '1px solid #27272a', borderRadius: 8, padding: '12px 14px', background: '#0f0f10' }}>
      <div style={{ fontSize: 22, fontWeight: 800, color: accent }}>{value}</div>
      <div style={{ fontSize: 11, color: '#71717a', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
    </div>
  );
}

const card: React.CSSProperties = { background: '#18181b', border: '1px solid #27272a', borderRadius: 10, padding: 20 };
const cta: React.CSSProperties = { width: '100%', marginTop: 14, background: '#7c3aed', color: 'white', border: 'none', borderRadius: 6, padding: '11px 18px', fontWeight: 600, fontSize: 14, cursor: 'pointer' };
