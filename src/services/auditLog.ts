import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from './supabaseClient';

// Sprint 8 Part 4 — SOC 2-aligned audit log. Append-only event trail; the writer
// takes an injectable client; CSV export is pure (unit-tested).

export type AuditEventType =
  | 'validation_run'
  | 'query_approved'
  | 'query_rejected'
  | 'query_executed_despite_warnings'
  | 'api_key_created'
  | 'api_key_revoked'
  | 'webhook_configured'
  | 'member_added'
  | 'member_removed'
  | 'plan_changed';

export interface AuditContext {
  user_id: string;
  team_id?: string;
  ip?: string;
  userAgent?: string;
}

export async function writeAuditEvent(
  event_type: AuditEventType,
  event_data: Record<string, unknown>,
  context: AuditContext,
  client: SupabaseClient | null = getSupabase(),
): Promise<void> {
  if (!client || !context.user_id) return;
  try {
    await client.from('audit_log').insert({
      user_id: context.user_id,
      team_id: context.team_id ?? null,
      event_type,
      event_data,
      ip_address: context.ip ?? null,
      user_agent: context.userAgent ?? null,
    });
  } catch {
    /* audit write is best-effort — never block the primary action */
  }
}

export interface AuditRow {
  created_at: string;
  user_email?: string;
  event_type: string;
  event_data?: {
    risk_score?: number;
    issue_types?: string[];
    sql_hash?: string;
    [k: string]: unknown;
  } | null;
}

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// CSV export (Business tier). Columns: timestamp, user_email, event_type,
// risk_score, issue_types, sql_hash.
export function auditLogToCsv(rows: AuditRow[]): string {
  const header = ['timestamp', 'user_email', 'event_type', 'risk_score', 'issue_types', 'sql_hash'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [
        csvCell(r.created_at),
        csvCell(r.user_email),
        csvCell(r.event_type),
        csvCell(r.event_data?.risk_score),
        csvCell((r.event_data?.issue_types ?? []).join('|')),
        csvCell(r.event_data?.sql_hash),
      ].join(','),
    );
  }
  return lines.join('\n');
}
