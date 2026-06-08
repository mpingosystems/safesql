import { nanoid } from 'nanoid';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from './supabaseClient';
import { SITE_URL } from '../config/constants';
import type { SqlSource, ValidationIssue, ValidationReport } from '../types/validation';

// Sprint 5 / v0.3.0 — DB-backed short-URL permalinks. A 12-char nanoid is the
// whole shareable URL (safesql.realitydb.dev/v/{id}), short enough to paste in
// Slack/PRs — unlike the legacy hash-encoded payload (300-500 chars).
//
// Client-side via the existing anon Supabase client (matches persistValidation):
// RLS allows public SELECT + anon INSERT, so this works signed-out and in
// incognito. The Supabase client is injectable so it can be faked in tests.

export interface SharedValidationRow {
  id: string;
  sql: string;
  issues: ValidationIssue[];
  score: number;
  dialect: string | null;
  ddl: string | null;
  source: SqlSource | null;
  created_at: string;
  expires_at: string;
}

export interface CreateSharedInput {
  sql: string;
  report: ValidationReport;
  dialect?: string;
  ddl?: string;
  source?: SqlSource;
}

// The short, Slack-shareable URL. Always built on the canonical domain so links
// shared from any deployment point at safesql.dev.
export function buildShortUrl(id: string): string {
  return `${SITE_URL}/v/${id}`;
}

// Extract the share id from a `/v/{id}` pathname (returns null otherwise).
export function shareIdFromPath(pathname: string): string | null {
  const m = /^\/v\/([A-Za-z0-9_-]+)\/?$/.exec(pathname);
  return m ? m[1] : null;
}

export async function createSharedValidation(
  input: CreateSharedInput,
  client: SupabaseClient | null = getSupabase(),
): Promise<{ id: string; url: string } | null> {
  if (!client || !input.sql) return null;
  const id = nanoid(12);
  const issues: ValidationIssue[] = [
    ...input.report.errors,
    ...input.report.warnings,
    ...input.report.suggestions,
  ];
  try {
    const { error } = await client.from('shared_validations').insert({
      id,
      sql: input.sql,
      issues,
      score: input.report.riskScore,
      dialect: input.dialect ?? 'postgresql',
      ddl: input.ddl || null,
      source: input.report.source ?? input.source ?? null,
    });
    if (error) {
      console.warn('createSharedValidation failed', error.message);
      return null;
    }
    return { id, url: buildShortUrl(id) };
  } catch (e) {
    console.warn('createSharedValidation threw', e);
    return null;
  }
}

export async function fetchSharedValidation(
  id: string,
  client: SupabaseClient | null = getSupabase(),
): Promise<SharedValidationRow | null> {
  if (!client || !id) return null;
  try {
    const { data, error } = await client
      .from('shared_validations')
      .select('id, sql, issues, score, dialect, ddl, source, created_at, expires_at')
      .eq('id', id)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as SharedValidationRow;
    // Treat expired rows as not found (defense in depth; the row may still be
    // readable under RLS until a cleanup job removes it).
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
    return row;
  } catch {
    return null;
  }
}

// Whole days until expiry (for the "Expires in X days" footer).
export function daysUntilExpiry(expiresAt: string): number {
  const ms = new Date(expiresAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

// Rebuild a read-only ValidationReport from the stored issues.
export function rowToReport(row: SharedValidationRow): ValidationReport {
  const issues = Array.isArray(row.issues) ? row.issues : [];
  return {
    riskScore: row.score,
    executionSafe: issues.every((i) => i.severity !== 'error'),
    errors: issues.filter((i) => i.severity === 'error'),
    warnings: issues.filter((i) => i.severity === 'warning'),
    suggestions: issues.filter((i) => i.severity === 'suggestion'),
    processingMs: 0,
    source: (row.source as SqlSource) ?? undefined,
  };
}
