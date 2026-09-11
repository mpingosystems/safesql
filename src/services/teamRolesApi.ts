// Sprint 9 (compliance tier) — browser client for PATCH /api/teams/member/role.
// Role changes are authorised server-side and recorded on the team's chain as
// member_role_changed. Never throws.

import { apiUrl } from '../config/api';
import { getClerkToken } from './supabaseClient';

export interface RoleApiDeps {
  fetch?: typeof fetch;
  getToken?: () => Promise<string | null>;
}

export type RoleChangeResult =
  | { ok: true; role: string; from: string; plan_changed: 'granted' | 'revoked' | null; event_seq: number | null }
  | { ok: false; status: number; error: string };

export async function changeMemberRole(
  clerkUserId: string,
  role: string,
  deps: RoleApiDeps = {},
): Promise<RoleChangeResult> {
  try {
    const token = await (deps.getToken ?? getClerkToken)();
    if (!token) return { ok: false, status: 401, error: 'Sign in to change roles' };
    const res = await (deps.fetch ?? fetch)(apiUrl('/api/teams/member/role'), {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clerk_user_id: clerkUserId, role }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { ok: false, status: res.status, error: String(body.error ?? `HTTP ${res.status}`) };
    const member = (body.member ?? {}) as { role?: string };
    return {
      ok: true,
      role: String(member.role ?? role),
      from: String(body.from ?? ''),
      plan_changed: body.plan_changed === 'granted' || body.plan_changed === 'revoked' ? body.plan_changed : null,
      event_seq: typeof body.event_seq === 'number' ? body.event_seq : null,
    };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message };
  }
}
