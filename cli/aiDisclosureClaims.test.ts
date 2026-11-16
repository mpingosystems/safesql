import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// 9.6-SEC (H10): every public statement about what reaches Anthropic is pinned
// to a behavioral proof, in the same "copy proves code" spirit as
// tierClaims.test.ts. Each FEATURE_PROOF entry asserts BOTH that the exact
// phrase is on the page AND that the code behaves as the phrase says. Changing
// the copy or the code without the other fails here.

vi.mock('../functions/api/_shared/clerkAuth', () => ({
  verifyClerkJWT: vi.fn(async () => 'user_claims_test'),
}));

let suggestKeyPlan = 'pro';
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { plan: suggestKeyPlan, revoked_at: null }, error: null }) }) }),
    }),
  }),
}));

import { handleExplain } from '../functions/api/explain';
import { handleSuggest } from '../functions/api/rules/suggest';
import { enrichWithAIExplanations, buildExplainBody } from '../src/services/aiExplainer';
import { runEditorValidation } from '../src/services/editorValidation';
import { validateSQL } from '../src/services/sqlValidator';
import { parseDDL } from '../src/services/schemaParser';
import type { Env } from '../functions/_shared';
import type { ValidationReport } from '../src/types/validation';

const ROOT = join(__dirname, '..');
// JSX wraps prose across lines; compare with whitespace collapsed.
const page = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\s+/g, ' ');
const SECURITY = 'src/pages/Security.tsx';
const PRIVACY = 'src/pages/Privacy.tsx';
const SUBPROCESSORS = 'src/pages/SubProcessors.tsx';
const DPA = 'src/pages/DPA.tsx';

const env = {
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'svc-not-real',
  CLERK_DOMAIN: 'clerk.example.test',
  ANTHROPIC_API_KEY: 'test-key-not-real',
} as unknown as Env;

// A schema with distinctive column TYPES, so a leak of types is detectable.
const DDL = 'CREATE TABLE customers (id UUID PRIMARY KEY, secret_amount NUMERIC(12,4) NOT NULL);';
const schema = parseDDL(DDL);

let userPlan = 'pro';
let sentToAnthropic: { body: Record<string, unknown> }[] = [];

beforeEach(() => {
  userPlan = 'pro';
  suggestKeyPlan = 'pro';
  sentToAnthropic = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/rest/v1/users?')) return new Response(JSON.stringify([{ plan: userPlan }]));
      if (u.includes('api.anthropic.com')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sentToAnthropic.push({ body });
        // suggest.ts sends a system prompt and expects a rule; explain.ts expects an array.
        const text = body.system
          ? '{"rule_type":"forbidden_table","name":"n","description":"d","config":{"table":"t","message":"m"},"severity":"error"}'
          : '[]';
        return new Response(JSON.stringify({ content: [{ text }] }));
      }
      throw new Error(`unexpected fetch ${u}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function explainReq(body: unknown): Request {
  return new Request('https://safesqlpro.dev/api/explain', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer session' },
    body: JSON.stringify(body),
  });
}

function promptSent(): string {
  expect(sentToAnthropic).toHaveLength(1);
  const msgs = sentToAnthropic[0].body.messages as { content: string }[];
  return [String(sentToAnthropic[0].body.system ?? ''), ...msgs.map((m) => m.content)].join('\n');
}

const issue = { id: 'HALLUCINATED_COLUMN', title: 'Unknown column', description: 'not in schema' };

interface Proof {
  // [page, exact phrase] pairs: the claim as worded on each page that makes it.
  stated: [string, string][];
  proof: () => Promise<void> | void;
}

const FEATURE_PROOF: Record<string, Proof> = {
  '(a) SQL sent to Anthropic is truncated to the first 2,000 characters': {
    stated: [[SECURITY, 'the first 2,000 characters of the query'], [SUBPROCESSORS, 'the first 2,000 characters of the query']],
    proof: async () => {
      const head = 'SELECT id FROM customers WHERE ' + 'x'.repeat(2000);
      const sql = head.slice(0, 2000) + 'TAIL_BEYOND_2000_CHARS';
      const res = await handleExplain(explainReq({ sql, issues: [issue] }), env);
      expect(res.status).toBe(200);
      const prompt = promptSent();
      expect(prompt).toContain(sql.slice(0, 2000));
      expect(prompt).not.toContain('TAIL_BEYOND_2000_CHARS');
    },
  },

  '(b) the schema part is table and column names only: no types, no row data': {
    stated: [[SECURITY, 'It never includes column types, row data or credentials.'], [SUBPROCESSORS, 'schema table and column names']],
    proof: async () => {
      // Client side: the body carries names only.
      const report = validateSQL({ sql: 'SELECT nope FROM customers', schema, dialect: 'postgresql' });
      const body = buildExplainBody(report, 'SELECT nope FROM customers', schema);
      expect(body.schema).toEqual([{ name: 'customers', columns: ['id', 'secret_amount'] }]);
      for (const t of body.schema!) expect(Object.keys(t).sort()).toEqual(['columns', 'name']);
      // Server side: even a client that adds types or rows can't get them into the prompt.
      const res = await handleExplain(
        explainReq({
          sql: 'SELECT nope FROM customers',
          issues: [issue],
          schema: [{ name: 'customers', columns: ['id', 'secret_amount'], types: ['NUMERIC_TYPE_LEAK'], rows: [{ secret_amount: 'ROW_DATA_LEAK' }] }],
          rows: ['ROW_DATA_LEAK'],
        }),
        env,
      );
      expect(res.status).toBe(200);
      const prompt = promptSent();
      expect(prompt).toContain('secret_amount');
      for (const leak of ['NUMERIC', 'UUID', 'NUMERIC_TYPE_LEAK', 'ROW_DATA_LEAK', 'PRIMARY KEY']) {
        expect(prompt).not.toContain(leak);
      }
    },
  },

  '(c) nothing is sent when results are clean or suggestion-only': {
    stated: [[SECURITY, 'Clean queries and suggestion-only results are never sent.']],
    proof: async () => {
      const fetchSpy = vi.fn(async () => new Response('{"explanations":[]}'));
      const base = validateSQL({ sql: 'SELECT id FROM customers', schema, dialect: 'postgresql' });
      const clean: ValidationReport = { ...base, errors: [], warnings: [], suggestions: [] };
      const suggestionOnly: ValidationReport = {
        ...base,
        errors: [],
        warnings: [],
        suggestions: [{ ...issue, id: 'SELECT_STAR_EXPENSIVE', severity: 'suggestion' } as ValidationReport['suggestions'][number]],
      };
      for (const r of [clean, suggestionOnly]) {
        const out = await enrichWithAIExplanations(r, 'SELECT id FROM customers', schema, async () => 'session', fetchSpy as unknown as typeof fetch);
        expect(out.report).toBe(r);
      }
      expect(fetchSpy).not.toHaveBeenCalled();
      // And the editor pipeline never even asks for an explanation.
      const explain = vi.fn();
      await runEditorValidation({
        sql: 'SELECT id FROM customers',
        schema,
        dialect: 'postgresql',
        explain,
        validate: () => suggestionOnly,
      });
      expect(explain).not.toHaveBeenCalled();
    },
  },

  '(d) the server logs only status, latency and model': {
    stated: [[SECURITY, 'our server records only the response status, timing and model name.'], [SUBPROCESSORS, 'Not stored or logged by SafeSQL Pro.']],
    proof: async () => {
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
      const sql = 'SELECT nope FROM customers -- SQL_TEXT_MARKER';
      await handleExplain(explainReq({ sql, issues: [{ ...issue, description: 'ISSUE_TEXT_MARKER' }] }), env);
      const lines = spies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(' ')));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        const entry = JSON.parse(line);
        expect(Object.keys(entry).sort()).toEqual(['event', 'latencyMs', 'model', 'status']);
        expect(line).not.toContain('SQL_TEXT_MARKER');
        expect(line).not.toContain('ISSUE_TEXT_MARKER');
      }
    },
  },

  '(e) AI explanations are for the Pro, Team and Business plans only': {
    stated: [SECURITY, PRIVACY, SUBPROCESSORS, DPA].map((p): [string, string] => [p, 'Pro, Team and Business plans']),
    proof: async () => {
      for (const p of ['pro', 'team', 'business']) {
        userPlan = p;
        expect((await handleExplain(explainReq({ sql: 'SELECT 1', issues: [issue] }), env)).status).toBe(200);
      }
      sentToAnthropic = [];
      userPlan = 'free';
      expect((await handleExplain(explainReq({ sql: 'SELECT 1', issues: [issue] }), env)).status).toBe(403);
      expect(sentToAnthropic).toHaveLength(0);
    },
  },

  '(f) rule drafting sends the plain-English description only, never SQL': {
    stated: [SUBPROCESSORS, DPA].map((p): [string, string] => [p, 'drafting custom rules from a plain-English description (the description only, never SQL)']),
    proof: async () => {
      const res = await handleSuggest(
        new Request('https://safesqlpro.dev/api/rules/suggest', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer api-key' },
          body: JSON.stringify({ description: 'DESCRIPTION_MARKER', sql: 'SELECT SQL_MARKER FROM t' }),
        }),
        env,
      );
      expect(res.status).toBe(200);
      const msgs = sentToAnthropic[0].body.messages as { content: string }[];
      expect(msgs).toEqual([{ role: 'user', content: 'DESCRIPTION_MARKER' }]);
      expect(JSON.stringify(sentToAnthropic[0].body)).not.toContain('SQL_MARKER');
    },
  },
};

describe('AI disclosure claims are backed by code (FEATURE_PROOF)', () => {
  for (const [claim, { stated, proof }] of Object.entries(FEATURE_PROOF)) {
    it(claim, async () => {
      for (const [p, phrase] of stated) expect(page(p), `${p} no longer states: "${phrase}"`).toContain(phrase);
      await proof();
    });
  }

  it('the inaccurate pre-9.6 wording is gone from every public page', () => {
    for (const p of [SECURITY, PRIVACY, SUBPROCESSORS, DPA]) {
      expect(page(p)).not.toMatch(/minimal context|not your full query|not full queries|Pro\+/);
    }
  });
});
