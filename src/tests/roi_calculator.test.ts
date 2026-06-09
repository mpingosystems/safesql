import { describe, expect, it } from 'vitest';
import { computeROI, recommendTier } from '../components/ROICalculator';

describe('recommendTier', () => {
  it('maps analyst count to the right tier', () => {
    expect(recommendTier(1)).toBe('pro');
    expect(recommendTier(2)).toBe('team');
    expect(recommendTier(5)).toBe('team');
    expect(recommendTier(6)).toBe('business');
    expect(recommendTier(20)).toBe('business');
    expect(recommendTier(21)).toBe('enterprise');
    expect(recommendTier(50)).toBe('enterprise');
  });
});

describe('computeROI', () => {
  it('computes queries, issues and debugging cost from the formulas', () => {
    const r = computeROI({ analysts: 5, salary: 100_000, validationsPerDay: 5 });
    // 5 * 5 * 22 = 550 queries; 25% = 137.5 issues; 0.5 hr each = 68.75 hrs
    expect(r.queriesPerMonth).toBe(550);
    expect(r.issuesPerMonth).toBeCloseTo(137.5, 5);
    expect(r.hoursSaved).toBeCloseTo(68.75, 5);
    // hourly = 100000/2080 = 48.0769; cost = 137.5 * 0.5 * 48.0769 = 3305.29
    expect(r.monthlyDebuggingCost).toBeCloseTo(3305.29, 1);
    expect(r.tier).toBe('team');
    expect(r.safesqlCost).toBe(199);
  });

  it('computes monthly savings = debugging cost − SafeSQL cost', () => {
    const r = computeROI({ analysts: 5, salary: 100_000, validationsPerDay: 5 });
    expect(r.monthlySavings).toBeCloseTo(r.monthlyDebuggingCost - 199, 5);
  });

  it('computes annual ROI multiple = savings / safesql cost', () => {
    const r = computeROI({ analysts: 5, salary: 100_000, validationsPerDay: 5 });
    expect(r.annualRoiMultiple).toBeCloseTo(r.monthlySavings / r.safesqlCost, 5);
    expect(r.annualRoiMultiple).toBeGreaterThan(1);
  });

  it('edge case: 1 analyst at $50K still yields positive ROI', () => {
    const r = computeROI({ analysts: 1, salary: 50_000, validationsPerDay: 5 });
    expect(r.tier).toBe('pro');
    expect(r.safesqlCost).toBe(49);
    expect(r.monthlySavings).toBeGreaterThan(0);
    expect(r.annualRoiMultiple).toBeGreaterThan(0);
  });
});
