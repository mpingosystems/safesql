import { describe, expect, it } from 'vitest';
import {
  SEVERITY_ERROR,
  SEVERITY_INFORMATION,
  SEVERITY_WARNING,
  findToken,
  formatIssueMessage,
  locateIssue,
  severityValue,
  statusBarText,
  statusBarTooltip,
} from '../src/format';

// The vscode-facing modules (diagnostics/statusBar/extension) can't run under
// vitest, so the extension's logic lives in format.ts and is tested here.

type Issue = Parameters<typeof formatIssueMessage>[0];

function issue(over: Partial<Issue> = {}): Issue {
  return {
    issueType: 'AGGREGATE_OVER_FANOUT_JOIN',
    severity: 'error',
    message: 'JOIN on orders multiplies rows before SUM(amount)',
    fix: 'Pre-aggregate orders before joining',
    scoreImpact: -35,
    ...over,
  } as Issue;
}

describe('severityValue', () => {
  it('maps SafeSQL severities to VS Code DiagnosticSeverity values', () => {
    expect(severityValue('error')).toBe(SEVERITY_ERROR);
    expect(severityValue('warning')).toBe(SEVERITY_WARNING);
    expect(severityValue('suggestion')).toBe(SEVERITY_INFORMATION);
  });
});

describe('formatIssueMessage', () => {
  it('renders issue type, message, fix and score impact', () => {
    expect(formatIssueMessage(issue())).toBe(
      '[AGGREGATE_OVER_FANOUT_JOIN] JOIN on orders multiplies rows before SUM(amount)\n' +
        'Fix: Pre-aggregate orders before joining\n' +
        'Score impact: -35',
    );
  });

  it('omits the fix and score lines when absent', () => {
    expect(formatIssueMessage(issue({ fix: '', scoreImpact: 0 }))).toBe(
      '[AGGREGATE_OVER_FANOUT_JOIN] JOIN on orders multiplies rows before SUM(amount)',
    );
  });
});

describe('status bar', () => {
  const result = {
    valid: false,
    score: 25,
    verdict: 'CRITICAL' as const,
    executionTime: 12,
    issues: [issue(), issue({ severity: 'warning' }), issue({ severity: 'suggestion' })],
  };

  it('shows score and verdict', () => {
    expect(statusBarText(result)).toBe('SafeSQL: 25 CRITICAL');
  });

  it('tooltip counts issues by severity', () => {
    const tip = statusBarTooltip(result);
    expect(tip).toContain('Score 25/100 — CRITICAL');
    expect(tip).toContain('1 error(s), 1 warning(s), 1 suggestion(s)');
  });

  // ── Sprint 5C — detector coverage surfaced from the API response ───────────
  const freeResult = {
    ...result,
    tier: 'free',
    detectorsRun: Array.from({ length: 12 }, (_, i) => `DET_${i}`),
    upgradePrompt: '2 additional findings were detected by Pro-only checks.',
  };

  it('appends the detector count when the tier ran a narrowed set', () => {
    expect(statusBarText(freeResult)).toBe('SafeSQL: 25 CRITICAL (12/35)');
  });

  it('leaves the label untouched when all detectors ran', () => {
    const pro = { ...result, tier: 'pro', detectorsRun: Array.from({ length: 35 }, (_, i) => `D${i}`) };
    expect(statusBarText(pro)).toBe('SafeSQL: 25 CRITICAL');
  });

  it('leaves the label untouched when the API sent no coverage info', () => {
    expect(statusBarText(result)).toBe('SafeSQL: 25 CRITICAL');
  });

  it('tooltip discloses the narrowed coverage and the upgrade prompt', () => {
    const tip = statusBarTooltip(freeResult);
    expect(tip).toContain('12 detectors active (free tier)');
    expect(tip).toContain('Pro-only checks');
  });
});

describe('findToken', () => {
  const sql = 'SELECT amount FROM orders JOIN order_items ON orders.id = order_items.order_id';

  it('finds a whole token, case-insensitively', () => {
    const span = findToken(sql, 'ORDERS');
    expect(sql.slice(span!.start, span!.end)).toBe('orders');
    expect(span!.start).toBe(sql.indexOf('orders'));
  });

  it('does not match inside a longer identifier', () => {
    // "order" must not match inside "orders" or "order_items"
    expect(findToken('SELECT * FROM orders', 'order')).toBeNull();
  });

  it('treats a dot as a boundary so qualified columns match', () => {
    const span = findToken('SELECT o.amount FROM orders o', 'amount');
    expect(span).not.toBeNull();
    expect(span!.start).toBe('SELECT o.'.length);
  });

  it('returns null for a token that is not present', () => {
    expect(findToken(sql, 'customers')).toBeNull();
  });
});

describe('locateIssue', () => {
  const sql = 'SELECT SUM(amount)\nFROM orders\nJOIN order_items ON 1 = 1';

  it('prefers the offending column', () => {
    const span = locateIssue(sql, issue({ offendingColumn: 'amount', offendingTable: 'orders' }));
    expect(sql.slice(span.start, span.end)).toBe('amount');
  });

  it('falls back to the offending table', () => {
    const span = locateIssue(sql, issue({ offendingTable: 'orders' }));
    expect(sql.slice(span.start, span.end)).toBe('orders');
  });

  it('falls back to the offending clause keyword', () => {
    const span = locateIssue(sql, issue({ offendingClause: 'JOIN' }));
    expect(sql.slice(span.start, span.end)).toBe('JOIN');
  });

  it('falls back to the first line when nothing matches', () => {
    const span = locateIssue(sql, issue({ offendingColumn: 'nope' }));
    expect(span).toEqual({ start: 0, end: 'SELECT SUM(amount)'.length });
  });

  it('falls back to the first line when the issue names nothing', () => {
    const span = locateIssue('SELECT 1', issue());
    expect(span).toEqual({ start: 0, end: 'SELECT 1'.length });
  });
});
