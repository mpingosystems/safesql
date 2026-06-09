import { error, json, methodNotAllowed, siteUrl, type Env } from '../../_shared';
import {
  computeDigestData,
  sendDigestEmail,
  type DigestData,
  type DigestRecord,
  type DigestFrequency,
} from '../../../src/services/digest';

// Sprint 10 Part 2 — digest dispatch.
//   POST { test: true, clerkUserId }  → compute + send one user's digest now
//   POST {}  with header x-cron-secret → batch: send to every due user
//
// Designed to be hit by a Cloudflare Cron trigger (see wrangler.toml). Pages
// Functions don't run a `scheduled` handler directly, so the cron invokes this
// HTTP endpoint. All email is best-effort: if RESEND_API_KEY is unset the digest
// is still computed and returned, just not emailed.

interface DigestEnv extends Env {
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  CRON_SECRET?: string;
}

interface PrefRow {
  user_id: string; // clerk id
  digest_frequency: DigestFrequency;
}

interface UserRow {
  id: string; // users.id (UUID)
  email: string;
  clerk_user_id: string;
}

export const onRequest: PagesFunction<DigestEnv> = async (context) => {
  if (context.request.method !== 'POST') return methodNotAllowed(['POST']);
  try {
    return await handle(context.request, context.env);
  } catch (err) {
    console.error('Digest error:', (err as Error)?.message ?? err);
    return error(500, 'Digest dispatch failed.');
  }
};

async function handle(request: Request, env: DigestEnv): Promise<Response> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return error(500, 'Supabase env not configured.');

  let body: { test?: unknown; clerkUserId?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    /* empty body is valid for the cron batch run */
  }

  // Single-user test send (from Settings).
  if (body.test === true) {
    if (typeof body.clerkUserId !== 'string') return error(400, 'clerkUserId required for a test send.');
    const result = await runForUser(body.clerkUserId, 'weekly', env);
    return json(result);
  }

  // Batch run — guard with the cron secret when one is configured.
  if (env.CRON_SECRET && request.headers.get('x-cron-secret') !== env.CRON_SECRET) {
    return error(401, 'Invalid cron secret.');
  }

  const prefs = await fetchDuePreferences(env);
  let sent = 0;
  for (const p of prefs) {
    const r = await runForUser(p.user_id, p.digest_frequency, env);
    if (r.sent) sent++;
  }
  return json({ processed: prefs.length, sent });
}

async function runForUser(
  clerkUserId: string,
  frequency: DigestFrequency,
  env: DigestEnv,
): Promise<{ sent: boolean; reason?: string; data: DigestData | null }> {
  const user = await fetchUser(clerkUserId, env);
  if (!user) return { sent: false, reason: 'no-user', data: null };

  const now = Date.now();
  const day = 86_400_000;
  const thisStart = new Date(now - 7 * day).toISOString();
  const prevStart = new Date(now - 14 * day).toISOString();

  const thisPeriod = await fetchValidations(user.id, thisStart, undefined, env);
  const prevPeriod = await fetchValidations(user.id, prevStart, thisStart, env);
  const data = computeDigestData(thisPeriod, prevPeriod);

  const res = await sendDigestEmail(data, {
    frequency,
    email: user.email,
    resendApiKey: env.RESEND_API_KEY,
    resendFrom: env.RESEND_FROM,
    baseUrl: siteUrl(env),
  });

  if (res.sent) await markSent(clerkUserId, env);
  return { sent: res.sent, reason: res.reason, data };
}

// ── Supabase REST helpers ────────────────────────────────────────────────────

function headers(env: Env): HeadersInit {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function fetchDuePreferences(env: DigestEnv): Promise<PrefRow[]> {
  // frequency != 'never' AND (last_sent_at is null OR older than 6 days)
  const sixDaysAgo = new Date(Date.now() - 6 * 86_400_000).toISOString();
  const url =
    `${env.SUPABASE_URL}/rest/v1/email_preferences` +
    `?digest_frequency=neq.never&or=(last_sent_at.is.null,last_sent_at.lt.${sixDaysAgo})` +
    `&select=user_id,digest_frequency`;
  const res = await fetch(url, { headers: headers(env) });
  if (!res.ok) return [];
  return (await res.json()) as PrefRow[];
}

async function fetchUser(clerkUserId: string, env: Env): Promise<UserRow | null> {
  const url = `${env.SUPABASE_URL}/rest/v1/users?clerk_user_id=eq.${encodeURIComponent(clerkUserId)}&select=id,email,clerk_user_id`;
  const res = await fetch(url, { headers: headers(env) });
  if (!res.ok) return null;
  const rows = (await res.json()) as UserRow[];
  return rows?.[0] ?? null;
}

async function fetchValidations(
  appUserId: string,
  fromIso: string,
  toIso: string | undefined,
  env: Env,
): Promise<DigestRecord[]> {
  let url =
    `${env.SUPABASE_URL}/rest/v1/validations?user_id=eq.${encodeURIComponent(appUserId)}` +
    `&created_at=gte.${fromIso}&select=risk_score,error_count,report,created_at`;
  if (toIso) url += `&created_at=lt.${toIso}`;
  const res = await fetch(url, { headers: headers(env) });
  if (!res.ok) return [];
  return (await res.json()) as DigestRecord[];
}

async function markSent(clerkUserId: string, env: Env): Promise<void> {
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/email_preferences?user_id=eq.${encodeURIComponent(clerkUserId)}`, {
      method: 'PATCH',
      headers: { ...headers(env), Prefer: 'return=minimal' },
      body: JSON.stringify({ last_sent_at: new Date().toISOString() }),
    });
  } catch {
    /* best-effort */
  }
}
