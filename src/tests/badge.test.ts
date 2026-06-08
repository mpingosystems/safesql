import { describe, expect, it } from 'vitest';
import { computeBadgeCriteria, renderBadgeSvg } from '../services/badge';

describe('computeBadgeCriteria', () => {
  it('certifies 100+ validations, avg ≥85, 0 destructive', () => {
    const r = computeBadgeCriteria({ validationCount: 142, averageScore: 88, destructiveExecuted: 0 });
    expect(r.certified).toBe(true);
    expect(r.checks.every((c) => c.met)).toBe(true);
  });

  it('not certified with < 100 validations', () => {
    const r = computeBadgeCriteria({ validationCount: 40, averageScore: 95, destructiveExecuted: 0 });
    expect(r.certified).toBe(false);
    expect(r.checks[0].met).toBe(false);
  });

  it('not certified with low average score', () => {
    expect(computeBadgeCriteria({ validationCount: 200, averageScore: 70, destructiveExecuted: 0 }).certified).toBe(false);
  });

  it('not certified with destructive SQL executed', () => {
    expect(computeBadgeCriteria({ validationCount: 200, averageScore: 95, destructiveExecuted: 3 }).certified).toBe(false);
  });
});

describe('renderBadgeSvg', () => {
  it('green certified badge contains the certified text + counts', () => {
    const svg = renderBadgeSvg({ count: 142, avgScore: 88, certified: true, date: '2026-06-08' });
    expect(svg).toMatch(/<svg/);
    expect(svg).toMatch(/SafeSQL Certified/);
    expect(svg).toMatch(/142/);
    expect(svg).toMatch(/#16a34a/); // green
  });

  it('grey not-yet-certified badge', () => {
    const svg = renderBadgeSvg({ count: 10, avgScore: 60, certified: false, date: '2026-06-08' });
    expect(svg).toMatch(/Not yet certified/);
    expect(svg).toMatch(/#52525b/); // grey
  });
});
