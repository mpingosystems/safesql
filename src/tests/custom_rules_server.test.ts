import { describe, expect, it } from 'vitest';
import { handleValidate, RULE_ENFORCEMENT_PLANS, type ValidateDeps } from '../../functions/api/validate';
import { handleRuleCreate, handleRulesList } from '../../functions/api/teams/rules/index';
import { handleRuleDelete, handleRuleUpdate, ruleIdFromPath } from '../../functions/api/teams/rules/[id]';
import { canWriteRules, configErrorFor, parseRuleInput, type RulesAccess } from '../../functions/api/teams/rules/_shared';
import { validateSqlSource } from '../services/fileValidation';
import type { CustomRule } from '../types/validation';
import { createRule, deleteRule, listRules, updateRule } from '../services/rulesApi';

// Sprint 9 item 4 — custom rules as enforced, audited team policy.

const TEAM = { id: 'team-1', name: 'Acme', slug: 'acme', plan: 'business', created_by: 'user_owner' };
const RULE_ID = '33333333-2222-4333-8444-555555555555';
const FORBID_PAYROLL: CustomRule = { id: RULE_ID, name: 'No payroll reads', rule_type: 'forbidden_table', config: { table: 'payroll' }, severity: 'error', active: true };

// ── engine plumbing ─────────────────────────────────────────────────────────

describe('validateSqlSource customRules param', () => {
  it('applies rules when given, with rule metadata; unchanged when omitted or empty', () => {
    const withRule = validateSqlSource('SELECT salary FROM payroll', undefined, 'postgresql', 'business', [FORBID_PAYROLL]);
    const hit = withRule.errors.find((e) => e.id === 'CUSTOM_RULE');
    expect(hit).toBeDefined();
    expect(hit?.metadata).toMatchObject({ ruleId: RULE_ID, ruleName: 'No payroll reads', ruleType: 'forbidden_table' });
    const without = validateSqlSource('SELECT salary FROM payroll', undefined, 'postgresql', 'business');
    const empty = validateSqlSource('SELECT salary FROM payroll', undefined, 'postgresql', 'business', []);
    expect(without.errors.map((e) => e.id)).not.toContain('CUSTOM_RULE');
    expect(empty.riskScore).toBe(without.riskScore);
    expect(withRule.riskScore).toBeLessThan(without.riskScore);
  });
});

// ── POST /api/validate loads and applies team rules ─────────────────────────

describe('POST /api/validate with team custom rules', () => {
  const post = (deps: ValidateDeps, sql = 'SELECT salary FROM payroll') =>
    handleValidate(new Request('https://x/api/validate', { method: 'POST', headers: { authorization: 'Bearer k', 'content-type': 'application/json' }, body: JSON.stringify({ sql, dialect: 'postgresql' }) }), deps);
  const base: ValidateDeps = {
    authenticate: async () => ({ ok: true, plan: 'business', userId: 'u1', clerkUserId: 'user_owner', keyPrefix: 'abc' }),
    checkUsage: async () => ({ ok: true }),
  };

  it('applies the loaded rules and reports customRulesApplied', async () => {
    const j = await (await post({ ...base, loadCustomRules: async () => [FORBID_PAYROLL] })).json();
    expect(j.customRulesApplied).toBe(1);
    expect(j.errors.map((e: { id: string }) => e.id)).toContain('CUSTOM_RULE');
  });

  it('no loader / empty loader / throwing loader → no rules, response otherwise identical', async () => {
    const a = await (await post(base)).json();
    const b = await (await post({ ...base, loadCustomRules: async () => [] })).json();
    const c = await (await post({ ...base, loadCustomRules: async () => { throw new Error('db down'); } })).json();
    expect(a).not.toHaveProperty('customRulesApplied', 1);
    expect(b.customRulesApplied).toBe(0);
    expect(c.customRulesApplied).toBe(0);
    expect(a.riskScore).toBe(b.riskScore);
    expect(b.riskScore).toBe(c.riskScore);
    expect(c.errors.map((e: { id: string }) => e.id)).not.toContain('CUSTOM_RULE');
  });

  it('loader is not consulted without a clerkUserId (unknown key owner)', async () => {
    let called = false;
    await post({ ...base, authenticate: async () => ({ ok: true, plan: 'business', userId: 'u2' }), loadCustomRules: async () => { called = true; return [FORBID_PAYROLL]; } });
    expect(called).toBe(false);
  });

  it('enforcement plan set is Business + Enterprise only', () => {
    expect([...RULE_ENFORCEMENT_PLANS].sort()).toEqual(['business', 'enterprise']);
    expect(RULE_ENFORCEMENT_PLANS.has('team')).toBe(false);
  });
});

// ── rule shape validation ───────────────────────────────────────────────────

describe('parseRuleInput / configErrorFor', () => {
  it('accepts a well-formed rule with defaults; rejects each malformed field', () => {
    const ok = parseRuleInput({ name: ' No payroll ', rule_type: 'forbidden_table', config: { table: 'payroll' } });
    expect(ok).toEqual({ rule: { name: 'No payroll', rule_type: 'forbidden_table', config: { table: 'payroll' }, severity: 'warning', active: true } });
    expect(parseRuleInput({ rule_type: 'forbidden_table', config: { table: 'x' } })).toMatchObject({ error: /name/ });
    expect(parseRuleInput({ name: 'n', rule_type: 'magic', config: {} })).toMatchObject({ error: /rule_type/ });
    expect(parseRuleInput({ name: 'n', rule_type: 'forbidden_table', config: {} })).toMatchObject({ error: /config\.table is required/ });
    expect(parseRuleInput({ name: 'n', rule_type: 'forbidden_table', config: { table: 'drop table;' } })).toMatchObject({ error: /SQL identifier/ });
    expect(parseRuleInput({ name: 'n', rule_type: 'forbidden_pattern', config: { pattern: '(' } })).toMatchObject({ error: /regular expression/ });
    expect(parseRuleInput({ name: 'n', rule_type: 'required_filter', config: { table: 'orders' } })).toMatchObject({ error: /config\.column/ });
    expect(parseRuleInput({ name: 'n', rule_type: 'forbidden_table', config: { table: 'x' }, severity: 'fatal' })).toMatchObject({ error: /severity/ });
    expect(parseRuleInput({ name: 'n', rule_type: 'forbidden_table', config: { table: 'x' }, active: 'yes' })).toMatchObject({ error: /active/ });
    expect(parseRuleInput(null)).toMatchObject({ error: /object/ });
  });
  it('partial mode accepts a subset and skips required-field checks until merged', () => {
    expect(parseRuleInput({ active: false }, { partial: true })).toEqual({ rule: { active: false } });
    expect(parseRuleInput({ config: { table: 'ledger' } }, { partial: true })).toEqual({ rule: { config: { table: 'ledger' } } });
    expect(configErrorFor('required_join_condition', { table: 'a' })).toMatch(/required_column/);
    expect(configErrorFor('required_join_condition', { table: 'a', required_column: 'a_id' })).toBeNull();
  });
  it('canWriteRules: owner and manager only', () => {
    expect(canWriteRules('owner')).toBe(true);
    expect(canWriteRules('manager')).toBe(true);
    expect(canWriteRules('member')).toBe(false);
    expect(canWriteRules('auditor')).toBe(false);
  });
});

// ── rules routes ────────────────────────────────────────────────────────────

function makeDb(rules: Record<string, unknown>[] = []) {
  const tables: Record<string, Record<string, unknown>[]> = {
    custom_rules: rules,
    users: [{ id: 'uid-owner', clerk_user_id: 'user_owner' }, { id: 'uid-mgr', clerk_user_id: 'user_mgr' }],
    team_members: [{ team_id: TEAM.id, clerk_user_id: 'user_owner', email: 'o@x.io' }, { team_id: TEAM.id, clerk_user_id: 'user_mgr', email: 'g@x.io' }],
  };
  const chain: Array<Record<string, unknown>> = [];
  let n = 0;
  function from(table: string) {
    const src = tables[table] ?? (tables[table] = []);
    let rows = [...src];
    let single = false; let ins: Record<string, unknown> | null = null; let patch: Record<string, unknown> | null = null; let del = false;
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = (c: string, v: unknown) => { rows = rows.filter((r) => r[c] === v); return q; };
    q.in = (c: string, vs: unknown[]) => { rows = rows.filter((r) => vs.includes(r[c])); return q; };
    q.order = () => q;
    q.maybeSingle = () => { single = true; return q; };
    q.single = () => { single = true; return q; };
    q.insert = (r: Record<string, unknown>) => { ins = r; return q; };
    q.update = (p: Record<string, unknown>) => { patch = p; return q; };
    q.delete = () => { del = true; return q; };
    (q as { then: unknown }).then = (res: (v: unknown) => unknown) => {
      let out: unknown;
      if (ins) { const row = { id: RULE_ID.replace('3333', String(1000 + n++)), created_at: '2026-09-11T12:00:00Z', updated_at: '2026-09-11T12:00:00Z', last_event_seq: null, created_by: null, ...ins }; src.push(row); out = { data: single ? row : [row], error: null }; }
      else if (patch) { for (const r of rows) Object.assign(r, patch); out = { data: single ? rows[0] ?? null : rows, error: null }; }
      else if (del) { for (const r of rows) src.splice(src.indexOf(r), 1); out = { data: null, error: null }; }
      else out = { data: single ? rows[0] ?? null : rows, error: null };
      return Promise.resolve(out).then(res);
    };
    return q;
  }
  const rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> = async (fn, args) => {
    expect(fn).toBe('audit_append');
    chain.push(args);
    return { data: chain.length, error: null };
  };
  return { from, tables, chain, rpc };
}
const access = (db: ReturnType<typeof makeDb>, role: string, who: string, plan = 'business') => async (): Promise<RulesAccess | Response> =>
  ({ db: db as never, team: { ...TEAM, plan }, role: role as RulesAccess['role'], clerkUserId: who });
const req = (method: string, path: string, body?: unknown) => new Request(`https://x${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const existing = () => ({ id: RULE_ID, team_id: TEAM.id, name: 'No payroll reads', description: null, rule_type: 'forbidden_table', config: { table: 'payroll' }, severity: 'error', active: true, created_by: 'uid-owner', created_by_clerk_user_id: 'user_owner', created_at: '2026-09-10T00:00:00Z', updated_at: '2026-09-10T00:00:00Z', updated_by_clerk_user_id: null, last_event_seq: 3 });

describe('/api/teams/rules', () => {
  it('POST creates (owner/manager), stores creator, writes rule_created; member/auditor 403; bad body 400', async () => {
    const db = makeDb();
    const r = await handleRuleCreate(req('POST', '/api/teams/rules', { name: 'No payroll reads', rule_type: 'forbidden_table', config: { table: 'payroll' }, severity: 'error' }), { access: access(db, 'manager', 'user_mgr') });
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.rule).toMatchObject({ name: 'No payroll reads', rule_type: 'forbidden_table', severity: 'error', active: true, created_by: 'uid-mgr', created_by_clerk_user_id: 'user_mgr', last_event_seq: 1 });
    expect(db.chain[0]).toMatchObject({ p_event_type: 'rule_created', p_actor: 'user_mgr', p_actor_role: 'manager', p_payload: { name: 'No payroll reads', rule_type: 'forbidden_table', config: { table: 'payroll' }, severity: 'error' } });
    for (const role of ['member', 'auditor']) {
      expect((await handleRuleCreate(req('POST', '/api/teams/rules', { name: 'x', rule_type: 'forbidden_table', config: { table: 'x' } }), { access: access(makeDb(), role, 'u') })).status).toBe(403);
    }
    expect((await handleRuleCreate(req('POST', '/api/teams/rules', { name: 'x', rule_type: 'forbidden_table', config: {} }), { access: access(makeDb(), 'owner', 'user_owner') })).status).toBe(400);
  });

  it('GET lists active rules with creator email, can_write and enforced_in_api by plan', async () => {
    const db = makeDb([existing(), { ...existing(), id: '44444444-2222-4333-8444-555555555555', name: 'old', active: false }]);
    const biz = await (await handleRulesList(req('GET', '/api/teams/rules'), { access: access(db, 'auditor', 'user_aud') })).json();
    expect(biz).toMatchObject({ my_role: 'auditor', can_write: false, enforced_in_api: true });
    expect(biz.rows).toHaveLength(1);
    expect(biz.rows[0]).toMatchObject({ name: 'No payroll reads', created_by_email: 'o@x.io' });
    const all = await (await handleRulesList(req('GET', '/api/teams/rules?include_inactive=true'), { access: access(db, 'owner', 'user_owner') })).json();
    expect(all.rows).toHaveLength(2);
    expect(all.can_write).toBe(true);
    const team = await (await handleRulesList(req('GET', '/api/teams/rules'), { access: access(db, 'owner', 'user_owner', 'team') })).json();
    expect(team.enforced_in_api).toBe(false);
  });

  it('PATCH edits with a change map, re-validates config against the type, deactivates as soft delete → rule_updated', async () => {
    const db = makeDb([existing()]);
    const r = await handleRuleUpdate(req('PATCH', `/api/teams/rules/${RULE_ID}`, { active: false, severity: 'warning' }), { access: access(db, 'manager', 'user_mgr') });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.changes).toEqual({ severity: { from: 'error', to: 'warning' }, active: { from: true, to: false } });
    expect(db.tables.custom_rules[0]).toMatchObject({ active: false, severity: 'warning', updated_by_clerk_user_id: 'user_mgr', last_event_seq: 1 });
    expect(db.chain[0]).toMatchObject({ p_event_type: 'rule_updated', p_subject: RULE_ID, p_payload: { rule_id: RULE_ID, changes: j.changes } });
    // no-op → 200 unchanged, nothing chained
    const same = await (await handleRuleUpdate(req('PATCH', `/api/teams/rules/${RULE_ID}`, { active: false }), { access: access(db, 'manager', 'user_mgr') })).json();
    expect(same.unchanged).toBe(true);
    expect(db.chain).toHaveLength(1);
    // config incompatible with the stored type → 400
    expect((await handleRuleUpdate(req('PATCH', `/api/teams/rules/${RULE_ID}`, { config: { column: 'x' } }), { access: access(db, 'owner', 'user_owner') })).status).toBe(400);
    expect((await handleRuleUpdate(req('PATCH', `/api/teams/rules/${RULE_ID}`, { active: true }), { access: access(db, 'member', 'u') })).status).toBe(403);
    expect((await handleRuleUpdate(req('PATCH', '/api/teams/rules/not-a-uuid', { active: true }), { access: access(db, 'owner', 'user_owner') })).status).toBe(400);
    expect((await handleRuleUpdate(req('PATCH', `/api/teams/rules/${RULE_ID}`, {}), { access: access(db, 'owner', 'user_owner') })).status).toBe(400);
  });

  it('DELETE is owner-only, chains the FULL rule first, then removes it', async () => {
    const db = makeDb([existing()]);
    expect((await handleRuleDelete(req('DELETE', `/api/teams/rules/${RULE_ID}`), { access: access(db, 'manager', 'user_mgr') })).status).toBe(403);
    expect(db.tables.custom_rules).toHaveLength(1);
    const r = await handleRuleDelete(req('DELETE', `/api/teams/rules/${RULE_ID}`), { access: access(db, 'owner', 'user_owner') });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, id: RULE_ID, event_seq: 1 });
    expect(db.tables.custom_rules).toHaveLength(0);
    expect(db.chain[0]).toMatchObject({ p_event_type: 'rule_deleted', p_actor: 'user_owner', p_subject: RULE_ID, p_payload: { rule_id: RULE_ID, rule: { name: 'No payroll reads', rule_type: 'forbidden_table', config: { table: 'payroll' }, severity: 'error', created_by: 'user_owner' } } });
    expect((await handleRuleDelete(req('DELETE', `/api/teams/rules/${RULE_ID}`), { access: access(db, 'owner', 'user_owner') })).status).toBe(404);
    expect(ruleIdFromPath(`/api/teams/rules/${RULE_ID}`)).toBe(RULE_ID);
    expect(ruleIdFromPath('/api/teams/rules/x')).toBeNull();
  });

  it('a chain failure on DELETE leaves the rule in place (500)', async () => {
    const db = makeDb([existing()]);
    db.rpc = async () => ({ data: null, error: { message: 'chain unavailable' } });
    const r = await handleRuleDelete(req('DELETE', `/api/teams/rules/${RULE_ID}`), { access: access(db, 'owner', 'user_owner') });
    expect(r.status).toBe(500);
    expect((await r.json()).error).toMatch(/rule not deleted/);
    expect(db.tables.custom_rules).toHaveLength(1);
  });
});

// ── browser client ──────────────────────────────────────────────────────────

describe('rulesApi client', () => {
  const fake = (status: number, body: unknown) => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify(body), { status }); }) as unknown as typeof fetch;
    return { f, calls, deps: { fetch: f, getToken: async () => 'jwt' } };
  };
  it('list / create / update / delete hit the right routes with the token; failures map to {ok:false}', async () => {
    const l = fake(200, { team_id: 't', team_plan: 'business', my_role: 'owner', can_write: true, enforced_in_api: true, rows: [] });
    expect(await listRules(l.deps, { includeInactive: true })).toMatchObject({ can_write: true });
    expect(l.calls[0].url).toMatch(/\/api\/teams\/rules\?include_inactive=true$/);
    const c = fake(201, { rule: { id: 'r1', name: 'x' }, event_seq: 5 });
    expect(await createRule({ name: 'x', rule_type: 'forbidden_table', config: { table: 'p' } }, c.deps)).toMatchObject({ ok: true, event_seq: 5 });
    expect(c.calls[0].init.method).toBe('POST');
    const u = fake(200, { rule: { id: 'r1', active: false }, event_seq: 6 });
    expect(await updateRule('r1', { active: false }, u.deps)).toMatchObject({ ok: true, event_seq: 6 });
    expect(u.calls[0].url).toMatch(/\/api\/teams\/rules\/r1$/);
    expect(u.calls[0].init.method).toBe('PATCH');
    const d = fake(403, { error: 'Only the owner can delete a rule (managers can deactivate it instead)' });
    expect(await deleteRule('r1', d.deps)).toEqual({ ok: false, status: 403, error: 'Only the owner can delete a rule (managers can deactivate it instead)' });
    expect(await listRules({ getToken: async () => null })).toMatchObject({ ok: false, status: 401 });
  });
});
