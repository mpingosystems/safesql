import { createClient } from '@supabase/supabase-js';
import type { Env } from '../_shared';
import { validateSqlSource, type CliDialect } from '../../src/services/fileValidation';
import { hashApiKey, PLAN_API_LIMITS } from '../../src/services/apiKeys';

// Sprint 7 Part 3 — REST API. POST /api/validate runs the same 33-detector
// engine server-side, behind Bearer API-key auth + per-plan monthly rate limits.
//
// The core (handleValidate) takes Web-standard Request/Response and injectable
// deps, so it's unit-testable without a live Supabase. onRequestPost wires the
// Supabase service-role-backed deps for the Workers runtime.

const DETECTOR_VERSION = '0.5.0';
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
}

export interface ValidateDeps {
  authenticate(token: string | null): Promise<AuthResult>;
  // false → over the monthly limit.
  checkUsage(userId: string, plan: string): Promise<{ ok: boolean }>;
}

function bearerToken(request: Request): string | null {
  const auth = request.headers.get('authorization') ?? '';
  return /^bearer\s+/i.test(auth) ? auth.replace(/^bearer\s+/i, '').trim() : null;
}

export async function handleValidate(request: Request, deps: ValidateDeps): Promise<Response> {
  let body: { sql?: unknown; ddl?: unknown; dialect?: unknown };
  try {
    body = (await request.json()) as typeof body;
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
  const report = validateSqlSource(body.sql, ddl, dialect);
  return jsonRes({ ...report, detectorVersion: DETECTOR_VERSION }, 200);
}

// ── Cloudflare Pages Function wrappers ───────────────────────────────────────
export const onRequestOptions = (): Response => new Response(null, { status: 204, headers: corsHeaders });

export const onRequestPost = async (context: { request: Request; env: Env }): Promise<Response> => {
  const { request, env } = context;
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  const deps: ValidateDeps = {
    async authenticate(token) {
      if (!token) return { ok: false };
      const keyHash = await hashApiKey(token);
      const { data } = await supabase
        .from('api_keys')
        .select('user_id, plan, revoked_at')
        .eq('key_hash', keyHash)
        .maybeSingle();
      if (!data || data.revoked_at) return { ok: false };
      void supabase
        .from('api_keys')
        .update({ last_used_at: new Date().toISOString() })
        .eq('key_hash', keyHash);
      return { ok: true, userId: data.user_id as string, plan: data.plan as string };
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
