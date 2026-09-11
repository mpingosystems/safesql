import type { ValidationReport } from '../types/validation';
import { getClerkToken, getSupabase, isSupabaseConfigured } from './supabaseClient';
import { writeAuditEvent } from './auditLog';
import { validationRunPayload } from './auditChain';
import { apiUrl } from '../config/api';

export interface PersistValidationInput {
  appUserId: string;
  sql: string;
  report: ValidationReport;
  schemaId?: string;
  dialect?: string;
  // Sprint 9 — real team id (teams.id) when the user belongs to a team, so the
  // audit trail is attributable at the team level. Omit for solo users.
  teamId?: string;
  // Sprint 9 (compliance) — optional extras for the chain event. Both default
  // sensibly; the chain write itself is fire-and-forget and never affects the
  // return value.
  detectorVersion?: string;
  tier?: string;
  dbt?: { currentModel?: string; sensitiveTagged: number };
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
    const { data: inserted, error } = await supabase.from('validations').insert({
      user_id: input.appUserId,
      sql_hash: sqlHash,
      schema_id: input.schemaId ?? null,
      report: input.report,
      risk_score: input.report.riskScore,
      error_count: input.report.errors.length,
      warning_count: input.report.warnings.length,
      ai_enriched: hasAIExplanation(input.report),
      dialect: input.dialect ?? 'postgresql',
      // Sprint 6B: attribute the row to the team so team history and the
      // dashboard can read it. Previously only writeAuditEvent below carried
      // team_id (to audit_log), so validations.team_id was always NULL and the
      // team view had nothing to show.
      team_id: input.teamId ?? null,
    }).select('id').maybeSingle();
    if (error) {
      console.warn('persistValidation failed', error.message);
      return false;
    }
    // Sprint 9 (compliance): put the validation on the team's tamper-evident
    // chain via POST /api/teams/events. Server derives team + actor from the
    // Clerk JWT; a user with no team gets 204 and nothing is recorded.
    void postChainEvent(sqlHash, inserted?.id ?? null, input);
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

// Fire-and-forget chain write. Swallows every failure: the chain is evidence
// for compliance buyers, and its unavailability must never surface in the
// editor. Injectable fetch/token for tests.
export interface ChainEventDeps {
  fetch?: typeof fetch;
  getToken?: () => Promise<string | null>;
}

export async function postChainEvent(
  sqlHash: string,
  validationId: string | null,
  input: PersistValidationInput,
  deps: ChainEventDeps = {},
): Promise<boolean> {
  try {
    const token = await (deps.getToken ?? getClerkToken)();
    if (!token) return false;
    const payload = validationRunPayload(input.report, {
      validationId,
      sqlHash,
      dialect: input.dialect ?? 'postgresql',
      surface: 'editor',
      detectorVersion: input.detectorVersion ?? 'unknown',
      tier: input.tier,
      dbt: input.dbt,
    });
    const res = await (deps.fetch ?? fetch)(apiUrl('/api/teams/events'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_type: 'validation_run', subject: validationId ?? undefined, payload }),
    });
    return res.status === 201;
  } catch {
    return false;
  }
}
