import { describe, expect, it, vi } from 'vitest';
import {
  computeDigestData,
  renderDigestEmail,
  sendDigestEmail,
  type DigestRecord,
} from '../services/digest';

const rec = (score: number, errorCount: number, issues: string[]): DigestRecord => ({
  risk_score: score,
  error_count: errorCount,
  report: {
    errors: errorCount > 0 ? issues.slice(0, errorCount).map((id) => ({ id })) : [],
    warnings: issues.map((id) => ({ id })),
  },
});

describe('computeDigestData', () => {
  it('returns correct validation + error counts', () => {
    const week = [rec(80, 1, ['JOIN_MULTIPLICATION']), rec(90, 0, []), rec(40, 1, ['HALLUCINATED_COLUMN'])];
    const d = computeDigestData(week);
    expect(d.totalValidations).toBe(3);
    expect(d.errorsCaught).toBe(2);
    expect(d.avgScore).toBe(70); // (80+90+40)/3
  });

  it('returns top 3 issue types sorted by frequency', () => {
    const week = [
      rec(50, 0, ['JOIN_MULTIPLICATION', 'JOIN_MULTIPLICATION']),
      rec(50, 0, ['JOIN_MULTIPLICATION', 'HALLUCINATED_COLUMN']),
      rec(50, 0, ['LEFT_JOIN_FILTERED_IN_WHERE', 'HALLUCINATED_COLUMN']),
      rec(50, 0, ['NULL_EQUALITY_COMPARISON']),
    ];
    const d = computeDigestData(week);
    expect(d.topIssues.length).toBe(3);
    expect(d.topIssues[0]).toEqual({ issueType: 'JOIN_MULTIPLICATION', count: 3 });
    expect(d.topIssues[1]).toEqual({ issueType: 'HALLUCINATED_COLUMN', count: 2 });
    // third is one of the count-1 issues, alphabetically first
    expect(d.topIssues[2].count).toBe(1);
  });

  it('computes score trend vs the previous period', () => {
    const thisWeek = [rec(84, 0, []), rec(84, 0, [])];
    const lastWeek = [rec(79, 0, []), rec(79, 0, [])];
    const d = computeDigestData(thisWeek, lastWeek);
    expect(d.avgScore).toBe(84);
    expect(d.prevAvgScore).toBe(79);
    expect(d.scoreTrend).toBe(5);
  });

  it('handles an empty week without dividing by zero', () => {
    const d = computeDigestData([]);
    expect(d).toMatchObject({ totalValidations: 0, errorsCaught: 0, avgScore: 0, scoreTrend: 0, topIssues: [] });
  });
});

describe('renderDigestEmail', () => {
  it('produces a subject with the error count and an analytics CTA', () => {
    const d = computeDigestData([rec(80, 1, ['JOIN_MULTIPLICATION'])]);
    const { subject, html } = renderDigestEmail(d, 'https://safesqlpro.dev');
    expect(subject).toMatch(/1 issue caught/);
    expect(html).toContain('https://safesqlpro.dev/#/analytics');
    expect(html).toContain('JOIN_MULTIPLICATION');
  });
});

describe('sendDigestEmail', () => {
  it("skips sending when frequency is 'never'", async () => {
    const fetchSpy = vi.fn();
    const res = await sendDigestEmail(computeDigestData([]), { frequency: 'never', email: 'a@b.com', resendApiKey: 'k' }, fetchSpy as never);
    expect(res.sent).toBe(false);
    expect(res.reason).toBe('opted-out');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips when Resend is not configured', async () => {
    const fetchSpy = vi.fn();
    const res = await sendDigestEmail(computeDigestData([]), { frequency: 'weekly', email: 'a@b.com' }, fetchSpy as never);
    expect(res.sent).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends via Resend when configured', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    const res = await sendDigestEmail(
      computeDigestData([rec(80, 1, ['X'])]),
      { frequency: 'weekly', email: 'a@b.com', resendApiKey: 'k', resendFrom: 'SafeSQL Pro <noreply@safesqlpro.dev>' },
      fetchSpy as never,
    );
    expect(res.sent).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith('https://api.resend.com/emails', expect.objectContaining({ method: 'POST' }));
  });
});
