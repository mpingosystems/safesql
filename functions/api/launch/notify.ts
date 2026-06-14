import { json, error, methodNotAllowed, type Env } from '../../_shared';

// Sprint 11 Part 5 — POST /api/launch/notify (admin only). Sends the pre-launch
// email to every launch_subscriber not yet notified, via Resend. Rate-limited to
// one email per subscriber via last_notified_at. The email HTML mirrors
// src/templates/pre-launch-email.html (kept in sync).

interface NotifyEnv extends Env {
  ADMIN_SECRET?: string;
}

function supabaseHeaders(env: NotifyEnv): HeadersInit {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=minimal',
  };
}

function buildEmail(days: number, upvoteUrl: string, unsubscribeUrl: string): string {
  return `<html lang="en"><body style="margin:0;background:#09090b;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#e4e4e7;">
<div style="max-width:560px;margin:0 auto;padding:32px 24px;">
<h1 style="font-size:22px;color:#a78bfa;margin:0 0 4px;">SafeSQL Pro</h1>
<p style="font-size:13px;color:#71717a;margin:0 0 24px;">SQL that runs is the most dangerous SQL.</p>
<p style="font-size:15px;line-height:1.6;">You signed up to be notified when <strong>SafeSQL Pro</strong> launches on Product Hunt. It's happening in <strong>${days} days</strong> — launch day, <strong>12:01 AM PST</strong>.</p>
<ul style="font-size:14px;line-height:1.7;color:#d4d4d8;padding-left:18px;">
<li>Catches semantic logic errors before they run.</li>
<li>Proves it on synthetic data — shows the actual inflated row count.</li>
<li>Deterministic detection: rules never hallucinate; AI only explains.</li></ul>
<p style="font-size:14px;line-height:1.6;">Try it free before launch: <a href="https://safesqlpro.dev" style="color:#a78bfa;">safesqlpro.dev</a></p>
<p style="font-size:14px;line-height:1.6;color:#d4d4d8;">On launch day, early upvotes in the first hour determine the day's ranking.</p>
<p style="margin:24px 0;"><a href="${upvoteUrl}" style="display:inline-block;background:#7c3aed;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 20px;border-radius:6px;">Upvote on Product Hunt →</a></p>
<p style="font-size:11px;color:#52525b;margin-top:32px;">SafeSQL Pro · Mpingo Systems LLC · <a href="${unsubscribeUrl}" style="color:#52525b;">Unsubscribe</a></p>
</div></body></html>`;
}

async function sendEmail(env: NotifyEnv, to: string, days: number, upvoteUrl: string): Promise<boolean> {
  const unsubscribeUrl = `https://safesqlpro.dev/#/unsubscribe?email=${encodeURIComponent(to)}`;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.RESEND_FROM || 'SafeSQL Pro <noreply@safesqlpro.dev>',
        to,
        subject: `SafeSQL Pro launches on Product Hunt in ${days} days 🚀`,
        html: buildEmail(days, upvoteUrl, unsubscribeUrl),
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export const onRequest: PagesFunction<NotifyEnv> = async (context) => {
  if (context.request.method !== 'POST') return methodNotAllowed(['POST']);
  return onRequestPost(context);
};

const onRequestPost = async ({ request, env }: Parameters<PagesFunction<NotifyEnv>>[0]): Promise<Response> => {
  if (!env.ADMIN_SECRET) return error(500, 'ADMIN_SECRET not configured.');
  if (request.headers.get('x-admin-secret') !== env.ADMIN_SECRET) return error(401, 'Unauthorized.');
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return error(500, 'Supabase env not configured.');
  if (!env.RESEND_API_KEY) return error(500, 'RESEND_API_KEY not configured.');

  let body: { days?: number; upvoteUrl?: string };
  try {
    body = (await request.json()) as { days?: number; upvoteUrl?: string };
  } catch {
    body = {};
  }
  const days = typeof body.days === 'number' ? body.days : 0;
  const upvoteUrl = typeof body.upvoteUrl === 'string' ? body.upvoteUrl : 'https://www.producthunt.com';

  // Only subscribers not yet notified (rate-limit: one email each).
  const listRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/launch_subscribers?last_notified_at=is.null&select=id,email`,
    { headers: supabaseHeaders(env) },
  );
  if (!listRes.ok) {
    return error(502, 'Could not read subscribers.', { detail: await listRes.text() });
  }
  const subs = (await listRes.json()) as { id: string; email: string }[];

  let sent = 0;
  let failed = 0;
  for (const sub of subs) {
    if (await sendEmail(env, sub.email, days, upvoteUrl)) {
      sent++;
      await fetch(`${env.SUPABASE_URL}/rest/v1/launch_subscribers?id=eq.${encodeURIComponent(sub.id)}`, {
        method: 'PATCH',
        headers: supabaseHeaders(env),
        body: JSON.stringify({ last_notified_at: new Date().toISOString() }),
      });
    } else {
      failed++;
    }
  }

  return json({ subscribers: subs.length, sent, failed });
};
