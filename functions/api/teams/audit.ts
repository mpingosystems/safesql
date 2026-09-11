import type { Env } from '../../_shared';
import { admin, callerId, jsonRes, membershipOf, preflight } from './_shared';
import { verdictFor } from './health';

// Sprint 7 — GET /api/teams/audit. Filterable log of team validations.
//
// NO QUERY TEXT. `validations` stores only sql_hash (SHA-256) — /compliance
// states publicly that "only a SHA-256 hash of the validated SQL is kept". A
// query preview would require storing customer SQL, contradicting a live
// privacy claim, so rows carry the hash prefix and the findings instead.
//
// Query params:
//   days=7|30|90        window (default 30)
//   member=<clerk_id>   single member, or omitted for all
//   verdict=RISKY|REVIEW|SAFE
//   issue=<DETECTOR_ID>
//   limit=1..1000       default 100 (1000 is the export ceiling)

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const SCAN_CAP = 3000; // rows pulled before in-memory filtering

/** Plans whose teams may export the audit trail. */
const EXPORT_PLANS: ReadonlySet<string> = new Set(['team', 'business', 'enterprise']);

interface ReportShape {
  errors?: { id?: string; severity?: string; title?: string; description?: string; fix?: string }[];
  warnings?: { id?: string; severity?: string; title?: string; description?: string; fix?: string }[];
  suggestions?: { id?: string; severity?: string; title?: string; description?: string; fix?: string }[];
}

interface Row {
  id?: string;
  user_id?: string;
  sql_hash?: string;
  risk_score?: number | null;
  error_count?: number;
  warning_count?: number;
  report?: ReportShape | null;
  dialect?: string | null;
  created_at?: string;
}

function allIssues(r: Row) {
  return [
    ...(r.report?.errors ?? []),
    ...(r.report?.warnings ?? []),
    ...(r.report?.suggestions ?? []),
  ];
}

export const onRequestOptions = preflight;

export const onRequestGet = async (context: {
  request: Request;
  env: Env;
}): Promise<Response> => {
  const { request, env } = context;

  const clerkUserId = await callerId(request, env);
  if (!clerkUserId) return jsonRes({ error: 'Authentication required' }, 401);

  const db = admin(env);
  const membership = await membershipOf(db, clerkUserId);
  if (!membership) return jsonRes({ error: 'You do not belong to a team' }, 403);
  const { team, role } = membership;

  const url = new URL(request.url);
  const requestedDays = Number(url.searchParams.get('days'));
  const days = [7, 30, 90].includes(requestedDays) ? requestedDays : 30;
  const memberFilter = url.searchParams.get('member') || '';
  const verdictFilter = url.searchParams.get('verdict') || '';
  const issueFilter = url.searchParams.get('issue') || '';
  const limit = Math.min(
    Math.max(Number(url.searchParams.get('limit')) || DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );

  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  // Member attribution: validations.user_id is a users.id UUID. There is no
  // user_clerk_id column, so the mapping goes through users.
  const { data: memberRows } = await db
    .from('team_members')
    .select('clerk_user_id, email, display_name')
    .eq('team_id', team.id);
  const members = memberRows ?? [];

  const clerkIds = members.map((m) => m.clerk_user_id).filter(Boolean);
  const { data: userRows } = clerkIds.length
    ? await db.from('users').select('id, clerk_user_id').in('clerk_user_id', clerkIds)
    : { data: [] as { id: string; clerk_user_id: string }[] };

  const userIdToClerk = new Map<string, string>();
  const clerkToUserId = new Map<string, string>();
  for (const u of userRows ?? []) {
    userIdToClerk.set(u.id, u.clerk_user_id);
    clerkToUserId.set(u.clerk_user_id, u.id);
  }
  const clerkToMember = new Map(members.map((m) => [m.clerk_user_id, m]));

  let q = db
    .from('validations')
    .select('id, user_id, sql_hash, risk_score, error_count, warning_count, report, dialect, created_at')
    .eq('team_id', team.id)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(SCAN_CAP);

  // Member filter pushed into the query — it is indexable, unlike the verdict
  // and issue filters, which are derived from risk_score and the report jsonb.
  if (memberFilter) {
    const uid = clerkToUserId.get(memberFilter);
    if (!uid) return jsonRes({ rows: [], total: 0, truncated: false, filters: { days, memberFilter, verdictFilter, issueFilter, limit } });
    q = q.eq('user_id', uid);
  }

  const { data, error } = await q;
  if (error) return jsonRes({ error: `Could not read validations: ${error.message}` }, 500);

  let rows = (data ?? []) as Row[];

  if (verdictFilter) {
    rows = rows.filter(
      (r) => typeof r.risk_score === 'number' && verdictFor(r.risk_score) === verdictFilter,
    );
  }
  if (issueFilter) {
    rows = rows.filter((r) => allIssues(r).some((i) => i?.id === issueFilter));
  }

  const total = rows.length;
  const page = rows.slice(0, limit);

  const out = page.map((r) => {
    const clerk = r.user_id ? userIdToClerk.get(r.user_id) : undefined;
    const m = clerk ? clerkToMember.get(clerk) : undefined;
    const issues = allIssues(r);
    const top = issues.find((i) => i?.severity === 'error') ?? issues[0];
    return {
      id: r.id ?? null,
      created_at: r.created_at ?? null,
      clerk_user_id: clerk ?? null,
      member_email: m?.email ?? 'unknown',
      member_name: m?.display_name || m?.email || 'unknown',
      score: r.risk_score ?? null,
      verdict: typeof r.risk_score === 'number' ? verdictFor(r.risk_score) : null,
      error_count: r.error_count ?? 0,
      warning_count: r.warning_count ?? 0,
      issue_count: issues.length,
      top_issue: top?.id ?? null,
      dialect: r.dialect ?? null,
      // Identifies the query without revealing it — enough to recognise a
      // repeat run, useless for reconstructing the SQL.
      sql_hash: r.sql_hash ? r.sql_hash.slice(0, 12) : null,
      issues: issues.map((i) => ({
        id: i?.id ?? null,
        severity: i?.severity ?? null,
        title: i?.title ?? null,
        description: i?.description ?? null,
        fix: i?.fix ?? null,
      })),
    };
  });

  // Distinct detector ids present in the window, for the issue-type dropdown —
  // so the filter only offers values that would actually match something.
  const issueTypes = [
    ...new Set(rows.flatMap((r) => allIssues(r).map((i) => i?.id).filter(Boolean))),
  ].sort() as string[];

  return jsonRes({
    rows: out,
    total,
    returned: out.length,
    // True when the pre-filter scan hit its ceiling: counts are a lower bound.
    truncated: (data?.length ?? 0) >= SCAN_CAP,
    // Export is a Team-tier capability, so it is gated on the team's PLAN, not
    // only the caller's role: a Pro user who created a team could otherwise
    // export. Role still applies — a plain member does not export the team.
    team_plan: team.plan,
    export_requires_upgrade: !EXPORT_PLANS.has(team.plan),
    // Sprint 9 (compliance): exporting evidence is the auditor's job.
    can_export: EXPORT_PLANS.has(team.plan) && (role === 'owner' || role === 'manager' || role === 'auditor'),
    members: members.map((m) => ({
      clerk_user_id: m.clerk_user_id,
      name: m.display_name || m.email,
    })),
    issue_types: issueTypes,
    filters: { days, member: memberFilter, verdict: verdictFilter, issue: issueFilter, limit },
  });
};
