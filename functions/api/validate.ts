import { createClient } from '@supabase/supabase-js';
import type { Env } from '../_shared';
import {
  prepareDbtContext,
  summarizeDbtContext,
  validateSqlSource,
  validateSqlWithDbt,
  type CliDialect,
} from '../../src/services/fileValidation';
import { looksLikeDbtManifest, type DbtArtifactInput } from '../../src/services/dbtArtifacts';
import { hashApiKey, PLAN_API_LIMITS } from '../../src/services/apiKeys';
import { appendAuditEvent, validationRunPayload, type AuditActorRole, type AuditEventInput } from '../../src/services/auditChain';
import { membershipOf } from './teams/_shared';
import type { PlanTier } from '../../src/config/detectorTiers';
import type { CustomRule, ValidationReport } from '../../src/types/validation';
import { DETECTOR_VERSION } from '../../src/config/detectorVersion';

// Sprint 7 Part 3 — REST API. POST /api/validate runs the same 35-detector
// engine server-side, behind Bearer API-key auth + per-plan monthly rate limits.
//
// The core (handleValidate) takes Web-standard Request/Response and injectable
// deps, so it's unit-testable without a live Supabase. onRequestPost wires the
// Supabase service-role-backed deps for the Workers runtime.


// Sprint 8 (dbt) — the request may carry parsed dbt artifacts. A real
// manifest.json is 1–20 MB, so the body cap is generous but finite. Enforced
// on Content-Length when present AND on the bytes actually read, because a
// chunked body carries no Content-Length.
export const MAX_BODY_BYTES = 25 * 1024 * 1024;

// Plans that unlock the full detector set. Anything else — including a missing
// or unrecognised plan string — is treated as free.
const PAID_PLANS: ReadonlySet<string> = new Set(['pro', 'team', 'business', 'enterprise']);
const SETTINGS_URL = 'https://safesqlpro.dev/settings';
const PRICING_URL = 'https://safesqlpro.dev/pricing';

export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders },
  });
}

export interface AuthResult {
  ok: boolean;
  plan?: string;
  userId?: string;
  // Sprint 9 (compliance) — lets the handler attribute a chain event to the
  // key owner's team. Optional: existing deps/tests never set it.
  clerkUserId?: string;
  keyPrefix?: string;
}

export interface ValidateDeps {
  authenticate(token: string | null): Promise<AuthResult>;
  // false → over the monthly limit.
  checkUsage(userId: string, plan: string): Promise<{ ok: boolean }>;
  // Sprint 9 (compliance) — optional. When present, the handler records a
  // validation_run chain event after the response is computed. It is awaited
  // inside a try/catch that swallows everything, so it can never change the
  // status, body or success of the validation itself.
  recordEvent?(input: Omit<AuditEventInput, 'teamId' | 'actorRole'> & { clerkUserId: string }): Promise<void>;
  // Sprint 9 (compliance) — optional. The caller's team custom rules, already
  // gated by team plan (Business+) inside the dep. A throwing loader yields
  // no rules; it never fails the validation.
  loadCustomRules?(clerkUserId: string): Promise<CustomRule[]>;
}

// Plans whose team policy (custom rules) is ENFORCED by the API. Rules can be
// authored on Team; applying them in CI/API is what the Business card sells.
export const RULE_ENFORCEMENT_PLANS: ReadonlySet<string> = new Set(['business', 'enterprise']);

async function customRulesFor(deps: ValidateDeps, auth: AuthResult): Promise<CustomRule[]> {
  if (!deps.loadCustomRules || !auth.clerkUserId) return [];
  try {
    return await deps.loadCustomRules(auth.clerkUserId);
  } catch (e) {
    console.warn('custom rules not loaded', (e as Error).message);
    return [];
  }
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

// Fire-and-forget chain write for API-key validations. Never throws.
async function recordValidationRun(
  deps: ValidateDeps,
  auth: AuthResult,
  report: ValidationReport,
  meta: { sql: string; dialect: string; tier: string; dbt?: { currentModel?: string; sensitiveTagged: number } },
): Promise<void> {
  if (!deps.recordEvent || !auth.clerkUserId) return;
  try {
    const payload = validationRunPayload(report, {
      validationId: null,
      sqlHash: await sha256Hex(meta.sql),
      dialect: meta.dialect,
      surface: 'api',
      tier: meta.tier,
      detectorVersion: DETECTOR_VERSION,
      dbt: meta.dbt,
    });
    await deps.recordEvent({
      clerkUserId: auth.clerkUserId,
      eventType: 'validation_run',
      actor: `api:${auth.keyPrefix ?? 'unknown'}`,
      payload,
    });
  } catch (e) {
    console.warn('chain event not recorded', (e as Error).message);
  }
}

function bearerToken(request: Request): string | null {
  const auth = request.headers.get('authorization') ?? '';
  return /^bearer\s+/i.test(auth) ? auth.replace(/^bearer\s+/i, '').trim() : null;
}

interface DbtBody {
  manifest?: unknown;
  catalog?: unknown;
  runResults?: unknown;
  sensitiveTags?: unknown;
  currentModel?: unknown;
}

export async function handleValidate(request: Request, deps: ValidateDeps): Promise<Response> {
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return jsonRes({ error: 'Request body exceeds 25 MB limit' }, 413);
  }

  let body: { sql?: unknown; ddl?: unknown; dialect?: unknown; dbt?: DbtBody };
  try {
    const text = await request.text();
    // Byte length, not string length: a UTF-8 body can be up to 4× its char count.
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
      return jsonRes({ error: 'Request body exceeds 25 MB limit' }, 413);
    }
    body = JSON.parse(text) as typeof body;
  } catch {
    return jsonRes({ error: 'Invalid JSON body' }, 400);
  }

  if (typeof body.sql !== 'string' || body.sql.trim() === '') {
    return jsonRes({ error: 'sql field is required' }, 400);
  }

  const auth = await deps.authenticate(bearerToken(request));
  if (!auth.ok || !auth.userId || !auth.plan) {
    return jsonRes({ error: `Invalid API key. Get yours at ${SETTINGS_URL}` }, 401);
  }

  const usage = await deps.checkUsage(auth.userId, auth.plan);
  if (!usage.ok) {
    return jsonRes({ error: `Rate limit exceeded. Upgrade at ${PRICING_URL}` }, 429);
  }

  const ddl = typeof body.ddl === 'string' ? body.ddl : undefined;
  const dialect = (typeof body.dialect === 'string' ? body.dialect : 'postgresql') as CliDialect;
  // Sprint 5C — the caller's plan decides the detector set. Anything that isn't
  // a recognised paid plan falls back to 'free', so an unknown/blank plan
  // narrows the run rather than silently unlocking all 35.
  const tier: PlanTier = PAID_PLANS.has(auth.plan) ? (auth.plan as PlanTier) : 'free';

  // Sprint 8 (dbt) — optional artifacts. Validated for shape before parsing so
  // a wrong payload gets a readable 400, never a 500 from the parser.
  if (body.dbt !== undefined) {
    const d = body.dbt && typeof body.dbt === 'object' ? body.dbt : undefined;
    const manifest = d?.manifest;
    if (!d || !looksLikeDbtManifest(manifest)) {
      return jsonRes({ error: 'dbt.manifest must be a parsed dbt manifest.json (an object with a `nodes` map)' }, 400);
    }
    const artifacts: DbtArtifactInput = {
      manifest,
      ...(d.catalog && typeof d.catalog === 'object' ? { catalog: d.catalog as DbtArtifactInput['catalog'] } : {}),
      ...(d.runResults && typeof d.runResults === 'object'
        ? { runResults: d.runResults as DbtArtifactInput['runResults'] }
        : {}),
      ...(Array.isArray(d.sensitiveTags) && d.sensitiveTags.every((t) => typeof t === 'string')
        ? { sensitiveTags: d.sensitiveTags as string[] }
        : {}),
    };
    const dbt = prepareDbtContext(artifacts);
    const currentModel = typeof d.currentModel === 'string' && d.currentModel ? d.currentModel : undefined;
    const rules = await customRulesFor(deps, auth);
    const report = validateSqlWithDbt(body.sql, dbt, ddl, dialect, tier, currentModel, rules);
    await recordValidationRun(deps, auth, report, {
      sql: body.sql, dialect, tier,
      dbt: { currentModel, sensitiveTagged: summarizeDbtContext(dbt.context).sensitiveTagged },
    });
    return jsonRes(
      {
        ...report,
        tier,
        detectorVersion: DETECTOR_VERSION,
        // Provenance only — never the full context. Lets a client tell "no
        // finding" from "no context loaded".
        dbtContext: { ...summarizeDbtContext(dbt.context), warnings: dbt.warnings },
        customRulesApplied: rules.length,
      },
      200,
    );
  }

  const rules = await customRulesFor(deps, auth);
  const report = validateSqlSource(body.sql, ddl, dialect, tier, rules);
  await recordValidationRun(deps, auth, report, { sql: body.sql, dialect, tier });
  return jsonRes({ ...report, tier, detectorVersion: DETECTOR_VERSION, customRulesApplied: rules.length }, 200);
}

// ── Cloudflare Pages Function wrappers ───────────────────────────────────────
export const onRequestOptions = (): Response => new Response(null, { status: 204, headers: corsHeaders });

export const onRequestPost = async (context: { request: Request; env: Env }): Promise<Response> => {
  const { request, env } = context;
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  // One membership lookup per request, shared by loadCustomRules + recordEvent.
  const membershipCache = new Map<string, ReturnType<typeof membershipOf>>();
  const membershipFor = (clerkUserId: string) => {
    let pending = membershipCache.get(clerkUserId);
    if (!pending) {
      pending = membershipOf(supabase, clerkUserId);
      membershipCache.set(clerkUserId, pending);
    }
    return pending;
  };

  const deps: ValidateDeps = {
    async authenticate(token) {
      if (!token) return { ok: false };
      const keyHash = await hashApiKey(token);
      // The plan comes from users.plan, NOT api_keys.plan.
      //
      // api_keys.plan is stamped when the key is minted and never updated —
      // nothing in the Stripe webhook touches it (webhook.ts patches
      // users.plan only). Trusting it would mean a customer who upgrades keeps
      // the 12-detector free gate and the free rate limit until they rotate
      // their key, and a customer who cancels keeps all 35 forever. users.plan
      // is the live value the billing webhook maintains, so join through to it.
      const { data } = await supabase
        .from('api_keys')
        .select('user_id, revoked_at, users!inner(plan, clerk_user_id)')
        .eq('key_hash', keyHash)
        .maybeSingle();
      if (!data || data.revoked_at) return { ok: false };
      // supabase-js types an embedded to-one relation as an array in some
      // versions; normalise both shapes.
      type U = { plan?: string; clerk_user_id?: string };
      const embedded = (data as { users?: U | U[] }).users;
      const user = Array.isArray(embedded) ? embedded[0] : embedded;
      const livePlan = user?.plan ?? 'free';
      void supabase
        .from('api_keys')
        .update({ last_used_at: new Date().toISOString() })
        .eq('key_hash', keyHash);
      return {
        ok: true,
        userId: data.user_id as string,
        plan: livePlan,
        // Sprint 9 (compliance): chain attribution — the key's owner and a
        // 12-char prefix of the key HASH (never the key) as the actor id.
        clerkUserId: user?.clerk_user_id,
        keyPrefix: keyHash.slice(0, 12),
      };
    },
    // Sprint 9 (compliance): put the validation on the owner's team chain.
    // membershipOf resolves the team + role; a key whose owner has no team
    // records nothing. Errors are swallowed by the caller.
    // Sprint 9 (compliance): the key owner's team rules, enforced for Business+
    // teams only.
    async loadCustomRules(clerkUserId) {
      const membership = await membershipFor(clerkUserId);
      if (!membership || !RULE_ENFORCEMENT_PLANS.has(membership.team.plan)) return [];
      const { data } = await supabase
        .from('custom_rules')
        .select('id, name, description, rule_type, config, severity, active')
        .eq('team_id', membership.team.id)
        .eq('active', true)
        .order('created_at', { ascending: true });
      return (data ?? []) as CustomRule[];
    },
    async recordEvent(input) {
      const membership = await membershipFor(input.clerkUserId);
      if (!membership) return;
      await appendAuditEvent(supabase, {
        teamId: membership.team.id,
        eventType: input.eventType,
        actor: input.actor,
        actorRole: membership.role as AuditActorRole,
        subject: input.subject,
        payload: input.payload,
      });
    },
    async checkUsage(userId, plan) {
      const month = new Date().toISOString().slice(0, 7); // YYYY-MM
      const limit = PLAN_API_LIMITS[plan] ?? PLAN_API_LIMITS.free;
      const { data } = await supabase
        .from('api_usage')
        .select('call_count')
        .eq('user_id', userId)
        .eq('month', month)
        .maybeSingle();
      const count = (data?.call_count as number | undefined) ?? 0;
      if (count >= limit) return { ok: false };
      await supabase
        .from('api_usage')
        .upsert({ user_id: userId, month, call_count: count + 1 }, { onConflict: 'user_id,month' });
      return { ok: true };
    },
  };

  return handleValidate(request, deps);
};
