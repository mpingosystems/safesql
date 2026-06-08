import type { ValidationReport } from '../types/validation';
import { getSupabase, isSupabaseConfigured } from './supabaseClient';
import { writeAuditEvent } from './auditLog';

export interface PersistValidationInput {
  appUserId: string;
  sql: string;
  report: ValidationReport;
  schemaId?: string;
  dialect?: string;
  // Sprint 9 — real team id (teams.id) when the user belongs to a team, so the
  // audit trail is attributable at the team level. Omit for solo users.
  teamId?: string;
}

// Fire-and-forget persistence. Resolves to whether the write succeeded
// (callers don't need to await — useful only for tests + retry logic).
// Never throws — failures are swallowed so the validate path stays smooth.
export async function persistValidation(input: PersistValidationInput): Promise<boolean> {
  if (!isSupabaseConfigured) return false;
  const supabase = getSupabase();
  if (!supabase) return false;
  if (!input.appUserId) return false;

  try {
    const sqlHash = await sha256Hex(input.sql);
    const { error } = await supabase.from('validations').insert({
      user_id: input.appUserId,
      sql_hash: sqlHash,
      schema_id: input.schemaId ?? null,
      report: input.report,
      risk_score: input.report.riskScore,
      error_count: input.report.errors.length,
      warning_count: input.report.warnings.length,
      ai_enriched: hasAIExplanation(input.report),
      dialect: input.dialect ?? 'postgresql',
    });
    if (error) {
      console.warn('persistValidation failed', error.message);
      return false;
    }
    // SOC 2 audit trail (fire-and-forget): record the validation_run event.
    void writeAuditEvent(
      'validation_run',
      {
        risk_score: input.report.riskScore,
        issue_types: [...input.report.errors, ...input.report.warnings].map((i) => i.id),
        sql_hash: sqlHash,
        dialect: input.dialect ?? 'postgresql',
      },
      { user_id: input.appUserId, team_id: input.teamId },
      supabase,
    );
    return true;
  } catch (e) {
    console.warn('persistValidation threw', e);
    return false;
  }
}

function hasAIExplanation(report: ValidationReport): boolean {
  for (const issue of [...report.errors, ...report.warnings]) {
    if (issue.explanation) return true;
  }
  return false;
}

async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
