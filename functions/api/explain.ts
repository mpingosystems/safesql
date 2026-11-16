import { json, error, methodNotAllowed, preflight, type Env } from '../_shared';
import { verifyClerkJWT } from './_shared/clerkAuth';
import { aiUnavailable, callAnthropic } from './_shared/anthropic';
import {
  EXPLAIN_MAX_BODY_BYTES,
  EXPLAIN_MAX_TOKENS,
  buildExplainPrompt,
  parseExplainRequest,
  parseExplanations,
} from '../../src/services/explainPrompt';

// 9.6-SEC — POST /api/explain. The editor's AI explanations (Layer 2). Replaces
// the browser-side Anthropic call, which shipped the key in the bundle.
//
// Auth: a verified Clerk session JWT (no API keys).
// Entitlement: Pro and above, read from users.plan on the server, never from a
// client claim. This matches the pricing page, which lists AI explanations
// under Pro.
// Limits: auth + plan + a 64 KB body cap. No per-user rate limit in this
// hotfix; spend is capped by the key's Anthropic workspace limit.
// CORS: app origin only (corsHeaders). This isn't a public API like
// /api/validate. The production client reaches it through VITE_API_BASE_URL,
// so it handles the OPTIONS preflight from the app origin.

export const EXPLAIN_UNAVAILABLE = 'AI explanations are temporarily unavailable';
const ENTITLED_PLANS = new Set(['pro', 'team', 'business', 'enterprise']);

export const onRequest = async (context: { request: Request; env: Env }): Promise<Response> => {
  if (context.request.method === 'OPTIONS') return preflight();
  if (context.request.method !== 'POST') return methodNotAllowed(['POST']);
  return handleExplain(context.request, context.env);
};

async function lookupPlan(env: Env, clerkUserId: string): Promise<{ ok: true; plan: string | null } | { ok: false }> {
  const url = `${env.SUPABASE_URL}/rest/v1/users?clerk_user_id=eq.${encodeURIComponent(clerkUserId)}&select=plan&limit=1`;
  try {
    const res = await fetch(url, {
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
    });
    if (!res.ok) return { ok: false };
    const rows = (await res.json()) as { plan?: string | null }[];
    return { ok: true, plan: rows[0]?.plan ?? null };
  } catch {
    return { ok: false };
  }
}

export async function handleExplain(request: Request, env: Env): Promise<Response> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return error(500, 'Supabase env not configured.');

  const clerkUserId = await verifyClerkJWT(request, env);
  if (!clerkUserId) return error(401, 'Sign in to use AI explanations.');

  const plan = await lookupPlan(env, clerkUserId);
  if (!plan.ok) return aiUnavailable(EXPLAIN_UNAVAILABLE);
  if (!plan.plan || !ENTITLED_PLANS.has(plan.plan)) {
    return error(403, 'AI explanations require Pro or above.');
  }

  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > EXPLAIN_MAX_BODY_BYTES) return error(413, 'Request body exceeds 64 KB.');
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > EXPLAIN_MAX_BODY_BYTES) {
    return error(413, 'Request body exceeds 64 KB.');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return error(400, 'Invalid JSON body.');
  }
  const parsed = parseExplainRequest(raw);
  if (!parsed.ok) return error(400, parsed.error);

  const ai = await callAnthropic(env, {
    messages: [{ role: 'user', content: buildExplainPrompt(parsed.value) }],
    maxTokens: EXPLAIN_MAX_TOKENS,
  });
  if (!ai.ok) return aiUnavailable(EXPLAIN_UNAVAILABLE);

  const explanations = parseExplanations(ai.text);
  if (!explanations) return aiUnavailable(EXPLAIN_UNAVAILABLE);
  return json({ explanations });
}
