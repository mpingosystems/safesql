import { describe, expect, it } from 'vitest';
import {
  deleteQuery,
  getMyQueries,
  getTeamQueries,
  saveQuery,
  searchQueries,
} from '../services/queryLibrary';

// In-memory fake Supabase client (same shape as teams.test.ts) covering the
// chains queryLibrary.ts uses: insert/.select().single(), select().eq().order(),
// select().eq().eq().order(), update().eq(), delete().eq().
function makeFake(seed: Record<string, Record<string, unknown>[]> = {}) {
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const k of Object.keys(seed)) tables[k] = seed[k].map((r) => ({ ...r }));
  let counter = 1;

  function from(table: string) {
    tables[table] ??= [];
    const state = {
      op: null as 'insert' | 'update' | 'delete' | null,
      payload: null as Record<string, unknown> | null,
      filters: [] as [string, unknown][],
      select: false,
    };

    function matched() {
      return tables[table].filter((r) => state.filters.every(([c, v]) => r[c] === v));
    }
    function apply(): Record<string, unknown>[] {
      if (state.op === 'insert') {
        const row = { id: `id_${counter++}`, ...state.payload };
        tables[table].push(row);
        return [row];
      }
      if (state.op === 'update') {
        const rows = matched();
        rows.forEach((r) => Object.assign(r, state.payload));
        return rows;
      }
      if (state.op === 'delete') {
        const keep = tables[table].filter((r) => !state.filters.every(([c, v]) => r[c] === v));
        tables[table] = keep;
        return [];
      }
      return matched();
    }
    function resolve(mode: 'single' | 'many') {
      const rows = apply();
      if (mode === 'single') return Promise.resolve({ data: rows[0] ?? null, error: null });
      return Promise.resolve({ data: rows, error: null });
    }
    const api: Record<string, unknown> = {
      insert: (p: Record<string, unknown>) => ((state.op = 'insert'), (state.payload = p), api),
      update: (p: Record<string, unknown>) => ((state.op = 'update'), (state.payload = p), api),
      delete: () => ((state.op = 'delete'), api),
      select: () => ((state.select = true), api),
      eq: (c: string, v: unknown) => (state.filters.push([c, v]), api),
      order: () => resolve('many'),
      single: () => resolve('single'),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => resolve('many').then(onF, onR),
    };
    return api;
  }
  return { from } as never;
}

describe('saveQuery', () => {
  it('stores the query with normalized fields', async () => {
    const fake = makeFake();
    const q = await saveQuery(
      { userId: 'u1', title: '  Monthly revenue  ', sql: 'SELECT 1', tags: ['finance'], lastRiskScore: 92 },
      fake,
    );
    expect(q).not.toBeNull();
    expect(q!.title).toBe('Monthly revenue');
    expect(q!.tags).toEqual(['finance']);
    expect(q!.last_risk_score).toBe(92);
    expect(q!.last_validated_at).toBeTruthy();
    expect(q!.is_team_shared).toBe(false);
  });

  it('returns null without a title or sql', async () => {
    expect(await saveQuery({ userId: 'u1', title: '', sql: 'SELECT 1' }, makeFake())).toBeNull();
    expect(await saveQuery({ userId: 'u1', title: 'x', sql: '' }, makeFake())).toBeNull();
  });
});

describe('getMyQueries', () => {
  it('returns only the current user’s queries', async () => {
    const fake = makeFake();
    await saveQuery({ userId: 'u1', title: 'a', sql: 'SELECT 1' }, fake);
    await saveQuery({ userId: 'u2', title: 'b', sql: 'SELECT 2' }, fake);
    const mine = await getMyQueries('u1', fake);
    expect(mine.map((q) => q.title)).toEqual(['a']);
  });
});

describe('getTeamQueries', () => {
  it('returns only is_team_shared=true queries for the team', async () => {
    const fake = makeFake();
    await saveQuery({ userId: 'u1', teamId: 't1', title: 'shared', sql: 'SELECT 1', isTeamShared: true }, fake);
    await saveQuery({ userId: 'u1', teamId: 't1', title: 'private', sql: 'SELECT 2', isTeamShared: false }, fake);
    const team = await getTeamQueries('t1', fake);
    expect(team.map((q) => q.title)).toEqual(['shared']);
  });
});

describe('searchQueries', () => {
  it('matches on title and on tags', async () => {
    const fake = makeFake();
    await saveQuery({ userId: 'u1', title: 'Revenue by region', sql: 'SELECT 1', tags: ['finance'] }, fake);
    await saveQuery({ userId: 'u1', title: 'Active users', sql: 'SELECT 2', tags: ['growth', 'kpi'] }, fake);
    expect((await searchQueries('u1', 'revenue', fake)).map((q) => q.title)).toEqual(['Revenue by region']);
    expect((await searchQueries('u1', 'kpi', fake)).map((q) => q.title)).toEqual(['Active users']);
    expect((await searchQueries('u1', '', fake)).length).toBe(2);
  });
});

describe('deleteQuery', () => {
  it('removes the row', async () => {
    const fake = makeFake();
    const q = await saveQuery({ userId: 'u1', title: 'a', sql: 'SELECT 1' }, fake);
    expect((await getMyQueries('u1', fake)).length).toBe(1);
    const ok = await deleteQuery(q!.id, fake);
    expect(ok).toBe(true);
    expect((await getMyQueries('u1', fake)).length).toBe(0);
  });
});
