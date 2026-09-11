// Sprint 9 (compliance tier) — the tamper-evident audit chain, TypeScript side.
//
// The chain itself lives in Postgres (supabase/migrations/20260911000000_…):
// a BEFORE INSERT trigger assigns seq / prev_hash / hash and BEFORE UPDATE /
// DELETE / TRUNCATE triggers refuse every change. This module is the ONLY
// application write path (appendAuditEvent → the audit_append RPC) plus a
// pure, dependency-free re-implementation of the verifier so the chain can be
// checked outside the database — in the Worker, in tests, and by an auditor
// with an export and Node alone.
//
// Verification never re-serialises JSON. The hashed record is built from the
// STORED columns (payload_canonical, created_at_iso …), so the TypeScript and
// SQL verifiers compute over identical bytes.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ValidationReport } from '../types/validation';

// ── Vocabulary (mirrors CHECK audit_events_type_known exactly) ──────────────

export const AUDIT_EVENT_TYPES = [
  'validation_run',
  'approval_requested', 'approval_approved', 'approval_rejected',
  'policy_created', 'policy_updated', 'policy_deleted',
  'rule_created', 'rule_updated', 'rule_deleted',
  'member_added', 'member_removed', 'member_role_changed',
  'plan_changed',
  'evidence_bundle_generated',
  'signing_key_rotated',
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];
export type AuditActorRole = 'owner' | 'manager' | 'member' | 'auditor';

export const GENESIS_HASH = '0'.repeat(64);

export function isAuditEventType(value: unknown): value is AuditEventType {
  return typeof value === 'string' && (AUDIT_EVENT_TYPES as readonly string[]).includes(value);
}

// ── Shapes ──────────────────────────────────────────────────────────────────

export interface AuditEventInput {
  teamId: string;
  eventType: AuditEventType;
  // clerk_user_id, or a system principal: 'system:stripe' | 'system:migration' |
  // 'ci:github' | `api:${keyPrefix}`
  actor: string;
  actorRole?: AuditActorRole; // undefined for system principals
  subject?: string; // validation id / approval id / member clerk id / rule id
  payload: Record<string, unknown>;
}

// Exactly the stored columns. This is what verifiers hash and what the
// evidence bundle carries — never a reshaped copy.
export interface AuditEventRow {
  team_id: string;
  seq: number;
  event_type: AuditEventType;
  actor: string;
  actor_role: string | null;
  subject: string | null;
  payload: Record<string, unknown>;
  payload_canonical: string;
  prev_hash: string;
  hash: string;
  created_at: string;
  created_at_iso: string;
}

export interface ChainVerification {
  ok: boolean;
  checked: number;
  firstSeq?: number;
  lastSeq?: number;
  headHash?: string;
  firstBadSeq?: number;
  expectedHash?: string;
  actualHash?: string;
  reason?: string;
}

// ── Hashing ─────────────────────────────────────────────────────────────────

const HEX64 = /^[0-9a-f]{64}$/;

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

// The record the database hashes, byte for byte:
//   prev_hash \n seq \n team_id \n event_type \n actor \n coalesce(subject,'')
//   \n created_at_iso \n payload_canonical
export function auditRecordOf(row: Omit<AuditEventRow, 'hash'>): string {
  return [
    row.prev_hash,
    String(row.seq),
    row.team_id,
    row.event_type,
    row.actor,
    row.subject ?? '',
    row.created_at_iso,
    row.payload_canonical,
  ].join('\n');
}

export async function hashAuditEvent(row: Omit<AuditEventRow, 'hash'>): Promise<string> {
  return sha256Hex(auditRecordOf(row));
}

// ── Verification (same algorithm and reasons as verify_audit_chain()) ───────
// `rows` must be one team's events ordered by seq. Starting mid-chain is
// allowed: the first row's stored prev_hash is taken as the anchor, exactly as
// the SQL function does. Only a run starting at seq 1 checks the genesis.

export async function verifyChain(rows: readonly AuditEventRow[]): Promise<ChainVerification> {
  const out: ChainVerification = { ok: true, checked: 0 };
  // Both are assigned on the first row before they are read.
  let prev = '';
  let prevSeq = 0;

  const fail = (row: AuditEventRow, reason: string, expected?: string, actual?: string): ChainVerification => ({
    ...out,
    ok: false,
    firstBadSeq: row.seq,
    reason,
    ...(expected !== undefined ? { expectedHash: expected } : {}),
    ...(actual !== undefined ? { actualHash: actual } : {}),
  });

  for (const row of rows) {
    if (!HEX64.test(row.hash) || !HEX64.test(row.prev_hash)) {
      return fail(row, 'hash or prev_hash is not 64 hex characters');
    }
    if (out.firstSeq === undefined) {
      out.firstSeq = row.seq;
      // A mid-chain start trusts the first row's stored prev_hash as its anchor.
      if (row.seq === 1 && row.prev_hash !== GENESIS_HASH) return fail(row, 'genesis prev_hash is not zero');
    } else if (row.seq !== prevSeq + 1) {
      return fail(row, 'gap in seq');
    } else if (row.prev_hash !== prev) {
      return fail(row, 'prev_hash does not match previous row hash', prev, row.prev_hash);
    }

    // The stored canonical text must still be a faithful rendering of the JSON
    // column. We compare parsed values (never re-serialise) to keep the check
    // independent of any serialiser's key order.
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payload_canonical);
    } catch {
      return fail(row, 'payload_canonical is not valid JSON');
    }
    if (!deepEqual(parsed, row.payload)) return fail(row, 'payload_canonical does not represent payload');

    const calc = await hashAuditEvent(row);
    if (calc !== row.hash) return fail(row, 'row hash does not match its contents', calc, row.hash);

    prev = row.hash;
    prevSeq = row.seq;
    out.checked += 1;
    out.lastSeq = row.seq;
    out.headHash = row.hash;
  }
  return out;
}

// Structural equality for JSON values (objects compared key-set-wise, arrays
// in order). Postgres jsonb has no key order, so this is the right notion.
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    if (Array.isArray(b)) return false;
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

// ── validation_run payload ──────────────────────────────────────────────────
// What a validation leaves on the chain. NO SQL text — /compliance states that
// only a hash of validated SQL is retained, and the chain must not quietly
// contradict that. Issue ids are sorted and de-duplicated so two validations
// of the same query produce the same payload.

export type ValidationSurface = 'editor' | 'api' | 'action' | 'cli' | 'dbt';

export interface ValidationRunPayload {
  validation_id: string | null; // validations.id when persisted; null for API calls that are not stored
  sql_hash: string; // sha256 of the SQL text
  dialect: string;
  risk_score: number;
  error_count: number;
  warning_count: number;
  suggestion_count: number;
  issue_types: string[];
  source?: string; // PQ1 LLM source tag, copied from the report when present
  surface: ValidationSurface;
  tier?: string;
  detector_version: string;
  dbt?: { current_model?: string; sensitive_tagged: number };
  [key: string]: unknown; // payload is Record<string, unknown> at the boundary
}

export interface ValidationRunMeta {
  validationId?: string | null;
  sqlHash: string;
  dialect: string;
  surface: ValidationSurface;
  detectorVersion: string;
  tier?: string;
  dbt?: { currentModel?: string; sensitiveTagged: number };
}

export function validationRunPayload(report: ValidationReport, meta: ValidationRunMeta): ValidationRunPayload {
  const ids = new Set<string>();
  for (const i of [...report.errors, ...report.warnings, ...report.suggestions]) ids.add(i.id);
  return {
    validation_id: meta.validationId ?? null,
    sql_hash: meta.sqlHash,
    dialect: meta.dialect,
    risk_score: report.riskScore,
    error_count: report.errors.length,
    warning_count: report.warnings.length,
    suggestion_count: report.suggestions.length,
    issue_types: [...ids].sort(),
    ...(report.source ? { source: report.source } : {}),
    surface: meta.surface,
    ...(meta.tier ? { tier: meta.tier } : {}),
    detector_version: meta.detectorVersion,
    ...(meta.dbt
      ? {
          dbt: {
            ...(meta.dbt.currentModel ? { current_model: meta.dbt.currentModel } : {}),
            sensitive_tagged: meta.dbt.sensitiveTagged,
          },
        }
      : {}),
  };
}

// ── Writer ──────────────────────────────────────────────────────────────────
// The only application write path. `db` must be the service-role client: the
// RPC is SECURITY DEFINER but EXECUTE is revoked from anon/authenticated, so a
// browser client gets a permission error by design. Returns the assigned seq.

export interface ChainWriter {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export async function appendAuditEvent(db: SupabaseClient | ChainWriter, input: AuditEventInput): Promise<number> {
  if (!isAuditEventType(input.eventType)) {
    throw new Error(`appendAuditEvent: unknown event type "${String(input.eventType)}"`);
  }
  if (!input.teamId || !input.actor) throw new Error('appendAuditEvent: teamId and actor are required');
  const { data, error } = await (db as ChainWriter).rpc('audit_append', {
    p_team_id: input.teamId,
    p_event_type: input.eventType,
    p_actor: input.actor,
    p_actor_role: input.actorRole ?? null,
    p_subject: input.subject ?? null,
    p_payload: input.payload ?? {},
  });
  if (error) throw new Error(`audit_append failed: ${error.message}`);
  const seq = typeof data === 'number' ? data : Number(data);
  if (!Number.isInteger(seq) || seq < 1) throw new Error(`audit_append returned an invalid seq: ${String(data)}`);
  return seq;
}
