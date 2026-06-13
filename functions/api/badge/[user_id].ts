import { createClient } from '@supabase/supabase-js';
import type { Env } from '../../_shared';
import { computeBadgeCriteria, renderBadgeSvg } from '../../../src/services/badge';

// GET /api/badge/{user_id} → SVG badge (green if certified, grey otherwise).
// Criteria over the last 30 days: ≥100 validations, avg score ≥85, 0 destructive
// SQL run despite warnings (proxied by destructive-error validations).
const DESTRUCTIVE_IDS = new Set(['MISSING_WHERE_DESTRUCTIVE', 'DESTRUCTIVE_DDL', 'DESTRUCTIVE_TRUNCATE']);

interface ValRow {
  risk_score: number;
  report?: { errors?: { id: string }[] } | null;
}

// Public badge is GET-only (embedded via <img>); a matching OPTIONS handler
// keeps cross-origin fetch() callers happy. Origin stays '*' like the GET.
export const onRequestOptions = (): Response =>
  new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'Content-Type',
      'access-control-max-age': '86400',
    },
  });

export const onRequestGet = async (context: {
  params: { user_id: string };
  env: Env;
}): Promise<Response> => {
  const userId = context.params.user_id;
  const today = new Date().toISOString().slice(0, 10);

  let count = 0;
  let avg = 0;
  let destructive = 0;
  try {
    const supabase = createClient(context.env.SUPABASE_URL, context.env.SUPABASE_SERVICE_ROLE_KEY);
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const { data } = await supabase
      .from('validations')
      .select('risk_score, report')
      .eq('user_id', userId)
      .gte('created_at', since);
    const rows = (data as ValRow[]) ?? [];
    count = rows.length;
    avg = count ? Math.round(rows.reduce((s, r) => s + (r.risk_score ?? 0), 0) / count) : 0;
    destructive = rows.filter((r) =>
      (r.report?.errors ?? []).some((e) => DESTRUCTIVE_IDS.has(e.id)),
    ).length;
  } catch {
    /* fall through to a not-certified badge on any error */
  }

  const { certified } = computeBadgeCriteria({
    validationCount: count,
    averageScore: avg,
    destructiveExecuted: destructive,
  });
  const svg = renderBadgeSvg({ count, avgScore: avg, certified, date: today });

  return new Response(svg, {
    headers: {
      'content-type': 'image/svg+xml',
      'cache-control': 'max-age=3600',
      'access-control-allow-origin': '*',
    },
  });
};
