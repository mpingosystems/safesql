import { describe, it, expect } from 'vitest';
import { formatCell } from '../components/formatCell';

describe('SandboxPanel formatCell — DATE_TRUNC display', () => {
  it('renders a first-of-month ISO timestamp as "May 2026"', () => {
    expect(formatCell('2026-05-01T05:00:00.000Z')).toBe('May 2026');
  });

  it('renders a plain YYYY-MM-01 date as the month label', () => {
    expect(formatCell('2026-05-01')).toBe('May 2026');
  });

  it('leaves non-first-of-month dates untouched', () => {
    expect(formatCell('2026-05-14T05:00:00.000Z')).toBe('2026-05-14T05:00:00.000Z');
  });

  it('preserves NULL, objects, numbers, and ordinary strings', () => {
    expect(formatCell(null)).toBe('NULL');
    expect(formatCell(undefined)).toBe('NULL');
    expect(formatCell(42)).toBe('42');
    expect(formatCell('pro')).toBe('pro');
    expect(formatCell({ a: 1 })).toBe('{"a":1}');
  });
});
