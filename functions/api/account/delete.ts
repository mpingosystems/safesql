import { json, error, methodNotAllowed, preflight, type Env } from '../../_shared';
import { verifyClerkJWT } from '../_shared/clerkAuth';

// Sprint 12 Part 3 — POST /api/account/delete. Self-serve account deletion.
// Auth: a verified Clerk session JWT. Sequence (strict): cancel Stripe sub →
// log → delete Supabase data → delete Clerk user (LAST). A Supabase HTTP failure
// aborts BEFORE the Clerk delete so we never strand a Clerk account with no data.

function supabaseHeaders(env: Env): HeadersInit {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=minimal',
  };
}

// Tables keyed by clerk_user_id (TEXT, no FK) — must be deleted explicitly.
// api_keys + webhook_configs (uuid FK ON DELETE CASCADE) are removed automatically
// when the users row is deleted; audit_log + approval_requests use ON DELETE SET
// NULL, so they are retained but anonymized (appropriate for compliance).
const CLERK_KEYED_TABLES = ['saved_queries', 'schema_connections', 'email_preferences'];

interface DeletionResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export async function performAccountDeletion(clerkUserId: string, env: Env, reason?: string): Promise<DeletionResult> {
  const enc = encodeURIComponent(clerkUserId);

  // 1. Look up the user (Stripe subscription + email).
  let user: { id?: string; email?: string; stripe_subscription_id?: string } | undefined;
  try {
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/users?clerk_user_id=eq.${enc}&select=id,email,stripe_subscription_id`,
      { headers: supabaseHeaders(env) },
    );
    if (res.ok) {
      const rows = (await res.json()) as (typeof user)[];
      user = rows[0];
    }
  } catch {
    /* fall through — deletion is best-effort on lookup */
  }

  // 2. Cancel the Stripe subscription FIRST (best-effort — may already be gone).
  if (user?.stripe_subscription_id && env.STRIPE_SECRET_KEY) {
    try {
      await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(user.stripe_subscription_id)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Stripe-Version': '2024-12-18.acacia' },
      });
    } catch {
      console.warn('[account-delete] Stripe cancel failed (continuing)', clerkUserId);
    }
  }

  // 3. Log the deletion.
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/account_deletions`, {
      method: 'POST',
      headers: supabaseHeaders(env),
      body: JSON.stringify({ clerk_user_id: clerkUserId, email: user?.email ?? null, reason: reason ?? null }),
    });
  } catch {
    /* best-effort log */
  }

  // 4. Delete Supabase data. Any HTTP failure aborts BEFORE the Clerk delete.
  for (const table of CLERK_KEYED_TABLES) {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?user_id=eq.${enc}`, {
      method: 'DELETE',
      headers: supabaseHeaders(env),
    });
    if (!res.ok) return { ok: false, status: 500, error: `Failed to delete ${table}.` };
  }
  // Deleting the users row cascades api_keys + webhook_configs and SET NULLs audit_log + approvals.
  const usersDel = await fetch(`${env.SUPABASE_URL}/rest/v1/users?clerk_user_id=eq.${enc}`, {
    method: 'DELETE',
    headers: supabaseHeaders(env),
  });
  if (!usersDel.ok) return { ok: false, status: 500, error: 'Failed to delete user record.' };

  // 5. Delete the Clerk user LAST.
  const clerkRes = await fetch(`https://api.clerk.com/v1/users/${enc}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` },
  });
  if (!clerkRes.ok) {
    return { ok: false, status: 500, error: 'Data deleted but Clerk account delete failed — contact support.' };
  }

  return { ok: true };
}

export async function handleDelete(request: Request, env: Env): Promise<Response> {
  const clerkUserId = await verifyClerkJWT(request, env);
  if (!clerkUserId) return error(401, 'Unauthorized');
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return error(500, 'Supabase env not configured.');
  if (!env.CLERK_SECRET_KEY) return error(500, 'CLERK_SECRET_KEY not configured.');

  let body: { reason?: unknown };
  try {
    body = (await request.json()) as { reason?: unknown };
  } catch {
    body = {};
  }
  const reason = typeof body.reason === 'string' ? body.reason : undefined;

  const result = await performAccountDeletion(clerkUserId, env, reason);
  if (!result.ok) return error(result.status ?? 500, result.error ?? 'Account delete failed.');
  return json({ success: true });
}

// context typed inline (not PagesFunction<Env>) so this module type-checks under
// both the functions tsconfig and the frontend tsconfig (it's imported by tests).
export const onRequest = async (context: { request: Request; env: Env }): Promise<Response> => {
  if (context.request.method === 'OPTIONS') return preflight();
  if (context.request.method !== 'POST') return methodNotAllowed(['POST']);
  return handleDelete(context.request, context.env);
};
