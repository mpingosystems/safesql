import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from './supabaseClient';

// Sprint 10 Part 2 — weekly/daily SQL health digest. The compute + render layer
// is pure (no import.meta.env, no fetch) so it runs identically in the browser,
// the Cloudflare Worker, and unit tests. The Worker (functions/api/digest/send.ts)
// fetches rows and calls these.

export interface DigestRecord {
  risk_score: number;
  error_count: number;
  report?: { errors?: { id: string }[]; warnings?: { id: string }[] } | null;
  created_at?: string;
}

export interface DigestIssue {
  issueType: string;
  count: number;
}

export interface DigestData {
  totalValidations: number;
  errorsCaught: number;
  avgScore: number;
  prevAvgScore: number;
  scoreTrend: number; // avgScore - prevAvgScore (signed)
  topIssues: DigestIssue[];
}

function avgScore(rows: DigestRecord[]): number {
  if (rows.length === 0) return 0;
  return Math.round(rows.reduce((s, r) => s + (r.risk_score ?? 0), 0) / rows.length);
}

// Pure digest computation from this period's rows (+ the previous period's rows
// for the score trend). Top 3 issue types by frequency, ties broken by name.
export function computeDigestData(thisPeriod: DigestRecord[], previousPeriod: DigestRecord[] = []): DigestData {
  const counts = new Map<string, number>();
  for (const r of thisPeriod) {
    for (const issue of [...(r.report?.errors ?? []), ...(r.report?.warnings ?? [])]) {
      counts.set(issue.id, (counts.get(issue.id) ?? 0) + 1);
    }
  }
  const topIssues = [...counts.entries()]
    .map(([issueType, count]) => ({ issueType, count }))
    .sort((a, b) => b.count - a.count || a.issueType.localeCompare(b.issueType))
    .slice(0, 3);

  const thisAvg = avgScore(thisPeriod);
  const prevAvg = avgScore(previousPeriod);

  return {
    totalValidations: thisPeriod.length,
    errorsCaught: thisPeriod.filter((r) => (r.error_count ?? 0) > 0).length,
    avgScore: thisAvg,
    prevAvgScore: prevAvg,
    scoreTrend: thisAvg - prevAvg,
    topIssues,
  };
}

// Render the digest as a standalone HTML email. baseUrl is injected (the Worker
// passes its SITE_URL) so this stays free of import.meta.env.
export function renderDigestEmail(data: DigestData, baseUrl = 'https://safesqlpro.dev'): { subject: string; html: string } {
  const subject = `Your SafeSQL Pro weekly report — ${data.errorsCaught} issue${data.errorsCaught === 1 ? '' : 's'} caught`;
  const trendArrow = data.scoreTrend > 0 ? '↑' : data.scoreTrend < 0 ? '↓' : '→';
  const trendText = data.prevAvgScore
    ? `avg ${data.avgScore} ${trendArrow} from ${data.prevAvgScore} last week`
    : `avg ${data.avgScore}`;
  const issuesHtml = data.topIssues.length
    ? data.topIssues
        .map((i) => `<li><strong>${i.issueType}</strong> — ${i.count} occurrence${i.count === 1 ? '' : 's'}</li>`)
        .join('')
    : '<li>No issues caught this week — nice work.</li>';

  const html = `<!doctype html><html><body style="background:#09090b;color:#e4e4e7;font-family:Arial,Helvetica,sans-serif;padding:24px;">
  <div style="max-width:560px;margin:0 auto;">
    <h1 style="font-size:20px;color:#a78bfa;margin:0 0 4px;">SafeSQL Pro</h1>
    <h2 style="font-size:16px;margin:0 0 16px;color:#e4e4e7;">Weekly SQL Health Report</h2>
    <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
      <tr>
        <td style="padding:10px;background:#18181b;border:1px solid #27272a;text-align:center;"><div style="font-size:24px;font-weight:700;color:#a78bfa;">${data.totalValidations}</div><div style="font-size:11px;color:#71717a;">validations</div></td>
        <td style="padding:10px;background:#18181b;border:1px solid #27272a;text-align:center;"><div style="font-size:24px;font-weight:700;color:#eab308;">${data.errorsCaught}</div><div style="font-size:11px;color:#71717a;">errors caught</div></td>
        <td style="padding:10px;background:#18181b;border:1px solid #27272a;text-align:center;"><div style="font-size:24px;font-weight:700;color:#22c55e;">${data.avgScore}</div><div style="font-size:11px;color:#71717a;">avg score</div></td>
      </tr>
    </table>
    <h3 style="font-size:14px;color:#a1a1aa;">Top issues this week</h3>
    <ol style="color:#d4d4d8;font-size:13px;line-height:1.7;">${issuesHtml}</ol>
    <h3 style="font-size:14px;color:#a1a1aa;">Score trend</h3>
    <p style="color:#d4d4d8;font-size:13px;">This week: ${trendText}</p>
    <p style="margin:20px 0;"><a href="${baseUrl}/#/analytics" style="background:#7c3aed;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600;font-size:13px;">View full analytics →</a></p>
    <p style="color:#52525b;font-size:11px;margin-top:24px;border-top:1px solid #27272a;padding-top:12px;">
      You're receiving this because you enabled digests. Manage preferences at
      <a href="${baseUrl}/#/settings" style="color:#71717a;">safesqlpro.dev/settings</a>.
      <a href="${baseUrl}/#/settings?digest=unsubscribe" style="color:#71717a;">Unsubscribe</a>.
    </p>
  </div></body></html>`;
  return { subject, html };
}

export type DigestFrequency = 'daily' | 'weekly' | 'never';

export interface DigestSendInput {
  frequency: DigestFrequency;
  email?: string;
  resendApiKey?: string;
  resendFrom?: string;
  baseUrl?: string;
}

// Send the digest via Resend. Skips (without error) when the user opted out
// ('never') or when email isn't configured. Returns whether an email was sent.
export async function sendDigestEmail(
  data: DigestData,
  input: DigestSendInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ sent: boolean; reason?: string }> {
  if (input.frequency === 'never') return { sent: false, reason: 'opted-out' };
  if (!input.resendApiKey || !input.email) return { sent: false, reason: 'email-not-configured' };
  const { subject, html } = renderDigestEmail(data, input.baseUrl);
  await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: input.resendFrom || 'SafeSQL Pro <noreply@safesqlpro.dev>',
      to: input.email,
      subject,
      html,
    }),
  });
  return { sent: true };
}

// Browser-side: read/write the current user's digest preference row.
export interface EmailPreference {
  user_id: string;
  digest_frequency: DigestFrequency;
  digest_day: number;
  digest_hour: number;
  last_sent_at: string | null;
}

export async function getEmailPreference(
  clerkUserId: string,
  client: SupabaseClient | null = getSupabase(),
): Promise<EmailPreference | null> {
  if (!client || !clerkUserId) return null;
  const { data } = await client
    .from('email_preferences')
    .select('user_id, digest_frequency, digest_day, digest_hour, last_sent_at')
    .eq('user_id', clerkUserId)
    .maybeSingle();
  return (data as EmailPreference) ?? null;
}

export async function saveEmailPreference(
  pref: { user_id: string; digest_frequency: DigestFrequency; digest_day?: number },
  client: SupabaseClient | null = getSupabase(),
): Promise<boolean> {
  if (!client || !pref.user_id) return false;
  const { error } = await client
    .from('email_preferences')
    .upsert(
      { user_id: pref.user_id, digest_frequency: pref.digest_frequency, digest_day: pref.digest_day ?? 1 },
      { onConflict: 'user_id' },
    );
  return !error;
}
