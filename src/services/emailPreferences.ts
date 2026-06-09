import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from './supabaseClient';
import type { DigestFrequency } from './digest';

// Sprint 10 Part 2 — browser-side read/write of the user's digest preference.
// Kept out of digest.ts (which the Cloudflare Worker bundles) because getSupabase
// touches import.meta.env, which is undefined in the Worker runtime.

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
