import type { SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../../_shared';
import { admin, callerId, jsonRes, membershipOf, preflight } from './_shared';
import { appendAuditEvent, type AuditActorRole } from '../../../src/services/auditChain';

// Sprint 9 (compliance tier) — POST /api/teams/events
//
// The browser's only way onto the chain. The web editor validates locally and
// persists the row itself; this route lets it record that validation as a
// chain event WITHOUT holding a service-role key. Only `validation_run` is
// accepted from a browser: every other event type is produced by a server
// action that appends directly (approvals, policies, membership, Stripe).
//
// team_id and the actor are never taken from the body — both come from the
// verified Clerk JWT and the caller's membership. A caller with no team gets
// 204: nothing to record, and the editor must keep working unchanged.

const MAX_BODY_BYTES = 8 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;
const SURFACES: ReadonlySet<string> = new Set(['editor']);
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['sql', 'ddl', 'query', 'statement']);

export interface EventsDeps {
  callerId(request: Request): Promise<string | null>;
  db(): SupabaseClient;
}

interface Body {
  event_type?: unknown;
  subject?: unknown;
  payload?: unknown;
}

function isInt(v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

/** Shape-check a browser-supplied validation_run payload. Returns an error string or null. */
export function validationPayloadError(p: unknown): string | null {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'payload must be an object';
  const o = p as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (FORBIDDEN_KEYS.has(k.toLowerCase())) return `payload must not contain "${k}" — only a hash of the SQL is retained`;
  }
  if (typeof o.sql_hash !== 'string' || !HEX64.test(o.sql_hash)) return 'payload.sql_hash must be a 64-char hex sha256';
  if (!isInt(o.risk_score, 0, 100)) return 'payload.risk_score must be an integer 0..100';
  for (const k of ['error_count', 'warning_count', 'suggestion_count']) {
    if (!isInt(o[k], 0, 10_000)) return `payload.${k} must be a non-negative integer`;
  }
  if (!Array.isArray(o.issue_types) || !o.issue_types.every((x) => typeof x === 'string' && x.length <= 80)) {
    return 'payload.issue_types must be an array of strings';
  }
  if (typeof o.surface !== 'string' || !SURFACES.has(o.surface)) return 'payload.surface must be "editor"';
  if (typeof o.dialect !== 'string' || !o.dialect) return 'payload.dialect is required';
  if (typeof o.detector_version !== 'string' || !o.detector_version) return 'payload.detector_version is required';
  if (o.validation_id !== null && o.validation_id !== undefined && typeof o.validation_id !== 'string') {
    return 'payload.validation_id must be a string or null';
  }
  return null;
}

export async function handleEvents(request: Request, deps: EventsDeps): Promise<Response> {
  if (request.method !== 'POST') return jsonRes({ error: 'Method not allowed' }, 405);

  const clerkUserId = await deps.callerId(request);
  if (!clerkUserId) return jsonRes({ error: 'Unauthorized' }, 401);

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    return jsonRes({ error: 'Event body exceeds 8 KB' }, 413);
  }
  let body: Body;
  try {
    body = JSON.parse(text) as Body;
  } catch {
    return jsonRes({ error: 'Invalid JSON body' }, 400);
  }

  if (body.event_type !== 'validation_run') {
    return jsonRes({ error: 'browsers may only append validation_run events' }, 400);
  }
  const payloadError = validationPayloadError(body.payload);
  if (payloadError) return jsonRes({ error: payloadError }, 400);
  const subject = typeof body.subject === 'string' && body.subject ? body.subject.slice(0, 200) : undefined;

  const db = deps.db();
  const membership = await membershipOf(db, clerkUserId);
  if (!membership) return new Response(null, { status: 204 });

  try {
    const seq = await appendAuditEvent(db, {
      teamId: membership.team.id,
      eventType: 'validation_run',
      actor: clerkUserId,
      actorRole: membership.role as AuditActorRole,
      subject,
      payload: body.payload as Record<string, unknown>,
    });
    return jsonRes({ seq, team_id: membership.team.id }, 201);
  } catch (e) {
    return jsonRes({ error: `Could not record event: ${(e as Error).message}` }, 500);
  }
}

export const onRequestOptions = preflight;

export const onRequestPost = async (context: { request: Request; env: Env }): Promise<Response> => {
  const { request, env } = context;
  return handleEvents(request, {
    callerId: (req) => callerId(req, env),
    db: () => admin(env),
  });
};
