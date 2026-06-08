import { describe, expect, it } from 'vitest';
import {
  acceptInvitation,
  createTeam,
  getTeamForUser,
  getTeamMembers,
  inviteMember,
  removeMember,
  slugify,
} from '../services/teams';

// ── In-memory fake Supabase client ───────────────────────────────────────────
// Supports the PostgREST chains teams.ts uses: insert/.select().single(),
// upsert(onConflict,ignoreDuplicates), update().eq(), delete().eq().eq(),
// select().eq().limit().maybeSingle(), select().eq().order(). Each builder is
// awaitable (thenable) so bare insert/update/delete resolve to { error }.
function makeFake(seed: Record<string, Record<string, unknown>[]> = {}) {
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const k of Object.keys(seed)) tables[k] = seed[k].map((r) => ({ ...r }));
  let counter = 1;

  function from(table: string) {
    tables[table] ??= [];
    const state: {
      op: 'insert' | 'upsert' | 'update' | 'delete' | null;
      payload: Record<string, unknown> | Record<string, unknown>[] | null;
      filters: [string, unknown][];
      onConflict: string | null;
      ignoreDuplicates: boolean;
      select: boolean;
    } = { op: null, payload: null, filters: [], onConflict: null, ignoreDuplicates: false, select: false };

    function matched() {
      return tables[table].filter((r) => state.filters.every(([c, v]) => r[c] === v));
    }

    function apply(): Record<string, unknown>[] {
      if (state.op === 'insert') {
        const rows = (Array.isArray(state.payload) ? state.payload : [state.payload!]).map((p) => ({
          id: (p as Record<string, unknown>).id ?? `id_${counter++}`,
          ...p,
        }));
        tables[table].push(...rows);
        return rows;
      }
      if (state.op === 'upsert') {
        const rows = Array.isArray(state.payload) ? state.payload : [state.payload!];
        const keys = (state.onConflict ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        const out: Record<string, unknown>[] = [];
        for (const p of rows) {
          const dupe =
            keys.length > 0 &&
            tables[table].find((r) => keys.every((k) => r[k] === (p as Record<string, unknown>)[k]));
          if (dupe) {
            if (!state.ignoreDuplicates) Object.assign(dupe, p);
            out.push(dupe);
          } else {
            const row = { id: `id_${counter++}`, ...p };
            tables[table].push(row);
            out.push(row);
          }
        }
        return out;
      }
      if (state.op === 'update') {
        const rows = matched();
        rows.forEach((r) => Object.assign(r, state.payload));
        return rows;
      }
      if (state.op === 'delete') {
        const keep = tables[table].filter((r) => !state.filters.every(([c, v]) => r[c] === v));
        const removed = tables[table].length - keep.length;
        tables[table] = keep;
        return new Array(removed).fill({});
      }
      return matched();
    }

    function resolve(mode: 'single' | 'maybe' | 'many') {
      const rows = apply();
      if (mode === 'single') {
        const data = state.select ? rows[0] ?? null : null;
        return Promise.resolve({ data, error: data || !state.select ? null : { message: 'no rows' } });
      }
      if (mode === 'maybe') return Promise.resolve({ data: rows[0] ?? null, error: null });
      return Promise.resolve({ data: state.select || state.op === null ? rows : null, error: null });
    }

    const api: Record<string, unknown> = {
      insert: (p: Record<string, unknown>) => ((state.op = 'insert'), (state.payload = p), api),
      upsert: (p: Record<string, unknown>, opts?: { onConflict?: string; ignoreDuplicates?: boolean }) => {
        state.op = 'upsert';
        state.payload = p;
        state.onConflict = opts?.onConflict ?? null;
        state.ignoreDuplicates = !!opts?.ignoreDuplicates;
        return api;
      },
      update: (p: Record<string, unknown>) => ((state.op = 'update'), (state.payload = p), api),
      delete: () => ((state.op = 'delete'), api),
      select: () => ((state.select = true), api),
      eq: (c: string, v: unknown) => (state.filters.push([c, v]), api),
      limit: () => api,
      order: () => resolve('many'),
      single: () => resolve('single'),
      maybeSingle: () => resolve('maybe'),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => resolve('many').then(onF, onR),
    };
    return api;
  }

  return { _tables: tables, from } as never;
}

describe('slugify', () => {
  it('produces a url-safe slug with a random suffix', () => {
    const s = slugify('Acme Analytics Team!');
    expect(s).toMatch(/^acme-analytics-team-[a-z0-9]{6}$/);
  });
  it('falls back to "team" for empty names', () => {
    expect(slugify('!!!')).toMatch(/^team-[a-z0-9]{6}$/);
  });
});

describe('createTeam', () => {
  it('creates the team and seats the founder as owner', async () => {
    const fake = makeFake();
    const team = await createTeam('Data Eng', 'clerk_owner', 'owner@acme.com', fake);
    expect(team).not.toBeNull();
    expect(team!.name).toBe('Data Eng');
    const store = (fake as unknown as { _tables: Record<string, Record<string, unknown>[]> })._tables;
    expect(store.teams.length).toBe(1);
    expect(store.team_members.length).toBe(1);
    expect(store.team_members[0]).toMatchObject({ clerk_user_id: 'clerk_owner', role: 'owner', email: 'owner@acme.com' });
  });
});

describe('getTeamForUser', () => {
  it('returns null for a user with no team', async () => {
    const got = await getTeamForUser('nobody', makeFake());
    expect(got).toBeNull();
  });
  it('returns the team for a member', async () => {
    const fake = makeFake();
    const team = await createTeam('Acme', 'owner1', 'o@acme.com', fake);
    const got = await getTeamForUser('owner1', fake);
    expect(got?.id).toBe(team!.id);
  });
});

describe('inviteMember', () => {
  it('returns a token', async () => {
    const fake = makeFake();
    const team = await createTeam('Acme', 'owner1', 'o@acme.com', fake);
    const token = await inviteMember(team!.id, 'new@acme.com', 'member', 'owner1', fake);
    expect(typeof token).toBe('string');
    expect(token!.length).toBeGreaterThan(10);
  });
});

describe('acceptInvitation', () => {
  it('creates a team_members row for the invitee', async () => {
    const fake = makeFake();
    const team = await createTeam('Acme', 'owner1', 'o@acme.com', fake);
    const token = await inviteMember(team!.id, 'new@acme.com', 'member', 'owner1', fake);
    const res = await acceptInvitation(token!, 'clerk_new', 'new@acme.com', fake);
    expect(res?.teamId).toBe(team!.id);
    const members = await getTeamMembers(team!.id, fake);
    expect(members.map((m) => m.clerk_user_id)).toContain('clerk_new');
  });

  it('does not create a duplicate member row when accepted twice', async () => {
    const fake = makeFake();
    const team = await createTeam('Acme', 'owner1', 'o@acme.com', fake);
    const token = await inviteMember(team!.id, 'new@acme.com', 'member', 'owner1', fake);
    await acceptInvitation(token!, 'clerk_new', 'new@acme.com', fake);
    await acceptInvitation(token!, 'clerk_new', 'new@acme.com', fake);
    const members = await getTeamMembers(team!.id, fake);
    expect(members.filter((m) => m.clerk_user_id === 'clerk_new').length).toBe(1);
  });

  it('returns null for an unknown token', async () => {
    const res = await acceptInvitation('bogus', 'clerk_x', 'x@acme.com', makeFake());
    expect(res).toBeNull();
  });
});

describe('removeMember', () => {
  it('deletes the membership row', async () => {
    const fake = makeFake();
    const team = await createTeam('Acme', 'owner1', 'o@acme.com', fake);
    const token = await inviteMember(team!.id, 'new@acme.com', 'member', 'owner1', fake);
    await acceptInvitation(token!, 'clerk_new', 'new@acme.com', fake);
    expect((await getTeamMembers(team!.id, fake)).length).toBe(2);
    const ok = await removeMember(team!.id, 'clerk_new', fake);
    expect(ok).toBe(true);
    const members = await getTeamMembers(team!.id, fake);
    expect(members.map((m) => m.clerk_user_id)).not.toContain('clerk_new');
  });
});
