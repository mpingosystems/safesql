import { describe, expect, it } from 'vitest';
import { applyFix, canApplyFix } from '../services/applyFix';
import {
  buildShareUrl,
  decodeSharePayload,
  encodeSharePayload,
  shareTokenFromHash,
  type SharePayload,
} from '../services/permalink';
import { validateSQL } from '../services/sqlValidator';
import type { ValidationIssue } from '../types/validation';

describe('PQ4: applyFix', () => {
  const nullEq: ValidationIssue = {
    id: 'NULL_EQUALITY_COMPARISON',
    severity: 'error',
    title: 't',
    description: 'd',
  };

  it('rewrites col = NULL to col IS NULL', () => {
    expect(applyFix('SELECT * FROM users WHERE deleted_at = NULL', nullEq)).toBe(
      'SELECT * FROM users WHERE deleted_at IS NULL',
    );
  });

  it('rewrites col != NULL to col IS NOT NULL', () => {
    expect(applyFix('SELECT * FROM users WHERE deleted_at != NULL', nullEq)).toBe(
      'SELECT * FROM users WHERE deleted_at IS NOT NULL',
    );
  });

  it('the rewritten query no longer trips the detector and scores higher', () => {
    const before = validateSQL({
      sql: 'SELECT id FROM users WHERE deleted_at = NULL',
      dialect: 'postgresql',
    });
    const fixed = applyFix('SELECT id FROM users WHERE deleted_at = NULL', nullEq)!;
    const after = validateSQL({ sql: fixed, dialect: 'postgresql' });
    expect(after.errors.map((e) => e.id)).not.toContain('NULL_EQUALITY_COMPARISON');
    expect(after.riskScore).toBeGreaterThan(before.riskScore);
  });

  it('returns null when no mechanical fix is available', () => {
    const issue: ValidationIssue = { id: 'SELECT_STAR_EXPENSIVE', severity: 'suggestion', title: 't', description: 'd' };
    expect(applyFix('SELECT * FROM big_table', issue)).toBeNull();
    expect(canApplyFix(issue)).toBe(false);
  });
});

describe('PQ5: permalink encode/decode', () => {
  const report = validateSQL({ sql: 'SELECT id, lifetime_value FROM users', dialect: 'postgresql' });
  const payload: SharePayload = {
    v: 1,
    sql: 'SELECT id, lifetime_value FROM users',
    dialect: 'postgresql',
    report,
  };

  it('round-trips a payload', () => {
    const decoded = decodeSharePayload(encodeSharePayload(payload));
    expect(decoded).not.toBeNull();
    expect(decoded!.sql).toBe(payload.sql);
    expect(decoded!.report.riskScore).toBe(report.riskScore);
  });

  it('survives non-ASCII identifiers', () => {
    const p2: SharePayload = { ...payload, sql: 'SELECT café FROM résumé' };
    const decoded = decodeSharePayload(encodeSharePayload(p2));
    expect(decoded!.sql).toBe('SELECT café FROM résumé');
  });

  it('builds and parses a /v/ hash route', () => {
    const url = buildShareUrl(payload);
    const token = shareTokenFromHash(url.slice(url.indexOf('#')));
    expect(token).toBeTruthy();
    expect(decodeSharePayload(token!)!.sql).toBe(payload.sql);
  });

  it('returns null on garbage', () => {
    expect(decodeSharePayload('not-valid-base64!!!')).toBeNull();
    expect(shareTokenFromHash('#/editor')).toBeNull();
  });
});
