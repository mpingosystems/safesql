// Sprint 9.6-RLS — static guard on the team_members recursion fix.
//
// Unit tests mock Supabase, so RLS is never exercised here. This test parses
// the migration text instead and fails if any rebuilt policy reads
// team_members directly again (the cause of Postgres 42P17).
import { describe, it, expect } from 'vitest'
import migration from '../../supabase/migrations/20261115000000_fix_team_members_rls_recursion.sql?raw'
import rollback from '../../supabase/verify/9.6-rls-rollback.sql?raw'

const EXPECTED = [
  'approval_policies_team_read',
  'approval_requests_requester_insert',
  'approval_requests_team_read',
  'audit_events_team_read',
  'audit_log_team_read',
  'custom_rules_team_read',
  'evidence_bundles_team_read',
  'team members read shared queries',
  'invitees read own invitation',
  'managers create invitations',
  'managers delete members',
  'managers manage members',
  'team members read members',
  'team managers update team',
  'team members read team',
  'Team members can view team validations',
].sort()

const DIRECT_READ = /from\s+(public\.)?team_members\b/i

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '')
}

interface Policy { name: string; body: string }

function createPolicies(sql: string): Policy[] {
  const out: Policy[] = []
  const re = /create\s+policy\s+("([^"]+)"|(\w+))([\s\S]*?);/gi
  for (const m of stripComments(sql).matchAll(re)) {
    out.push({ name: m[2] ?? m[3], body: m[0] })
  }
  return out
}

function functionBodies(sql: string): string[] {
  const re = /create\s+or\s+replace\s+function\s+private\.[\s\S]*?\$\$[\s\S]*?\$\$/gi
  return [...stripComments(sql).matchAll(re)].map((m) => m[0])
}

describe('9.6-RLS migration', () => {
  const policies = createPolicies(migration)

  it('rebuilds exactly the 16 policies, once each', () => {
    expect(policies.map((p) => p.name).sort()).toEqual(EXPECTED)
  })

  it('no CREATE POLICY body reads team_members directly', () => {
    const offenders = policies.filter((p) => DIRECT_READ.test(p.body)).map((p) => p.name)
    expect(offenders).toEqual([])
  })

  it('every rebuilt policy is TO authenticated and calls a private helper', () => {
    for (const p of policies) {
      expect(p.body, p.name).toMatch(/\bto\s+authenticated\b/i)
      expect(p.body, p.name).toMatch(/private\.my_(joined_)?team_ids\(/)
    }
  })

  it('drops each policy before creating it (idempotent)', () => {
    const sql = stripComments(migration)
    for (const name of EXPECTED) {
      const drop = sql.indexOf(`DROP POLICY IF EXISTS "${name}"`)
      const create = sql.indexOf(`CREATE POLICY "${name}"`)
      expect(drop, name).toBeGreaterThanOrEqual(0)
      expect(drop, name).toBeLessThan(create)
    }
    expect(sql).toContain('DROP POLICY IF EXISTS "validations_owner_or_team_read"')
  })

  it('keeps the live invitations email branch word for word', () => {
    const p = policies.find((x) => x.name === 'invitees read own invitation')
    expect(p?.body).toContain("(email = (auth.jwt() ->> 'email'))")
  })

  it('validations uses the joined_at-aware helper', () => {
    const p = policies.find((x) => x.name === 'Team members can view team validations')
    expect(p?.body).toContain('private.my_joined_team_ids()')
  })

  it('does not touch the owner path on validations', () => {
    expect(stripComments(migration)).not.toMatch(/users own validations/i)
  })

  it('runs in one transaction', () => {
    const sql = stripComments(migration).trim()
    expect(sql).toMatch(/^BEGIN;/)
    expect(sql).toMatch(/COMMIT;$/)
  })

  it('helpers are STABLE SECURITY DEFINER with an empty search_path', () => {
    const fns = functionBodies(migration)
    expect(fns).toHaveLength(3)
    for (const f of fns) {
      expect(f).toMatch(/\bstable\b/i)
      expect(f).toMatch(/security\s+definer/i)
      expect(f).toMatch(/set\s+search_path\s*=\s*''/i)
      expect(f).toContain('public.team_members')
    }
    expect(stripComments(migration)).toMatch(/create\s+schema\s+if\s+not\s+exists\s+private/i)
  })

  it('revokes helpers from public/anon and grants them to authenticated', () => {
    const sql = stripComments(migration)
    for (const sig of ['my_team_ids()', 'my_team_ids(text[])', 'my_joined_team_ids()']) {
      expect(sql).toContain(`REVOKE EXECUTE ON FUNCTION private.${sig}`)
      expect(sql).toContain(`GRANT  EXECUTE ON FUNCTION private.${sig}`)
    }
  })
})

describe('9.6-RLS rollback', () => {
  it('restores the same 16 policies without a TO clause', () => {
    const policies = createPolicies(rollback)
    expect(policies.map((p) => p.name).sort()).toEqual(EXPECTED)
    for (const p of policies) expect(p.body, p.name).not.toMatch(/\bto\s+authenticated\b/i)
  })

  it('removes the helpers and the private schema', () => {
    const sql = stripComments(rollback)
    expect(sql).toContain('DROP SCHEMA IF EXISTS private;')
    expect(sql).not.toMatch(/cascade/i)
  })
})
