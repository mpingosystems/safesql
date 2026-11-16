// Shared contract for POST /api/explain (9.6-SEC). Pure, with no browser or
// Workers APIs, so the Function, the client and the tests all import the same
// shapes. The prompt is built on the server, so the browser can no longer
// choose the model, the token budget or the instructions.
//
// Layer 2 only: the model explains issues the deterministic detectors already
// found. It never adds, removes or re-scores an issue.

export const EXPLAIN_MAX_BODY_BYTES = 64 * 1024;
export const EXPLAIN_MAX_ISSUES = 60;
export const EXPLAIN_MAX_TOKENS = 2000;
const SQL_PROMPT_CHARS = 2000;

export interface ExplainIssueInput {
  id: string;
  title: string;
  description: string;
}

export interface ExplainSchemaTable {
  name: string;
  columns: string[];
}

export interface ExplainRequestBody {
  sql: string;
  issues: ExplainIssueInput[];
  schema?: ExplainSchemaTable[];
}

export interface AIExplanation {
  id: string;
  explanation: string;
  fix: string;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const isStr = (v: unknown): v is string => typeof v === 'string';

export function parseExplainRequest(raw: unknown): Parsed<ExplainRequestBody> {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Body must be a JSON object.' };
  const b = raw as Record<string, unknown>;
  if (!isStr(b.sql) || !b.sql.trim()) return { ok: false, error: 'sql is required.' };
  if (!Array.isArray(b.issues) || b.issues.length === 0) return { ok: false, error: 'issues must be a non-empty array.' };
  if (b.issues.length > EXPLAIN_MAX_ISSUES) return { ok: false, error: `At most ${EXPLAIN_MAX_ISSUES} issues per request.` };

  const issues: ExplainIssueInput[] = [];
  for (const i of b.issues) {
    const o = (i ?? {}) as Record<string, unknown>;
    if (!isStr(o.id) || !isStr(o.title) || !isStr(o.description)) {
      return { ok: false, error: 'Each issue needs string id, title and description.' };
    }
    issues.push({ id: o.id, title: o.title, description: o.description });
  }

  let schema: ExplainSchemaTable[] | undefined;
  if (b.schema !== undefined && b.schema !== null) {
    if (!Array.isArray(b.schema)) return { ok: false, error: 'schema must be an array.' };
    schema = [];
    for (const t of b.schema) {
      const o = (t ?? {}) as Record<string, unknown>;
      if (!isStr(o.name) || !Array.isArray(o.columns) || !o.columns.every(isStr)) {
        return { ok: false, error: 'Each schema table needs a string name and string columns.' };
      }
      schema.push({ name: o.name, columns: o.columns as string[] });
    }
  }

  return { ok: true, value: { sql: b.sql, issues, schema } };
}

export function buildExplainPrompt(body: ExplainRequestBody): string {
  const schemaSummary = body.schema && body.schema.length > 0 ? JSON.stringify(body.schema) : 'Not provided';
  return `You are a senior data engineer reviewing SQL for a colleague.
You have been given a list of issues detected by a rule-based SQL validator.
For each issue, provide:
1. A plain-English explanation of WHY this is dangerous (2 sentences max)
2. A specific SQL fix example relevant to this exact query

Do NOT invent additional issues. Do NOT remove issues. Only explain the ones provided, in the same order.

SQL query being validated:
\`\`\`sql
${body.sql.slice(0, SQL_PROMPT_CHARS)}
\`\`\`

Schema context:
${schemaSummary}

Issues to explain (respond as JSON array, same order):
${JSON.stringify(body.issues.map((i) => ({ id: i.id, title: i.title, description: i.description })))}

Return ONLY a JSON array of objects with fields: id, explanation, fix
No markdown, no preamble.`;
}

// Parses the model's reply. Returns null when it isn't a JSON array of
// explanation objects; malformed entries are dropped and never coerced.
export function parseExplanations(text: string): AIExplanation[] | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  return raw
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
    .filter((e) => isStr(e.id) && isStr(e.explanation))
    .map((e) => ({ id: e.id as string, explanation: e.explanation as string, fix: isStr(e.fix) ? e.fix : '' }));
}
