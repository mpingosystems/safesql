import { json, error, methodNotAllowed, preflight, type Env } from '../../_shared';
import { createClient } from '@supabase/supabase-js';
import { hashApiKey } from '../../../src/services/apiKeys';
import { parseRuleSuggestion } from '../../../src/services/ruleSuggestion';

// Sprint 11 Part 4 — POST /api/rules/suggest. Converts a plain-English policy
// description into a structured custom-rule config using Claude (Layer 2,
// assistance only). Claude NEVER sees the SQL being validated — detection stays
// 100% deterministic. Bearer API-key auth (Pro+).

interface SuggestEnv extends Env {
  ANTHROPIC_API_KEY?: string;
}

const ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_VERSION = '2023-06-01';

const SYSTEM_PROMPT = `You are a SQL policy assistant. Convert the user's plain English description into a structured custom rule for SafeSQL Pro.

Available rule types (with their config fields):
- required_filter: a table must have a WHERE filter on a column. config: { table, column, message }
- forbidden_table: a table must never be queried directly. config: { table, message }
- required_join_condition: joining a table requires a specific column condition. config: { table, required_column, message }
- forbidden_pattern: SQL must not match a regex pattern. config: { pattern, message }
- required_column_qualification: columns from a table must be qualified. config: { table, message }

Respond with ONLY valid JSON in this exact shape:
{
  "rule_type": "required_filter",
  "name": "Require tenant_id filter on payments",
  "description": "Always filter payments by tenant_id",
  "config": { "table": "payments", "column": "tenant_id", "message": "Always filter payments by tenant_id to prevent cross-tenant data exposure" },
  "severity": "error"
}

Do not include any explanation or markdown — only the JSON object.`;

export const onRequest: PagesFunction<SuggestEnv> = async (context) => {
  if (context.request.method === 'OPTIONS') return preflight();
  if (context.request.method !== 'POST') return methodNotAllowed(['POST']);
  return onRequestPost(context);
};

const onRequestPost = async ({ request, env }: Parameters<PagesFunction<SuggestEnv>>[0]): Promise<Response> => {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return error(500, 'Supabase env not configured.');
  if (!env.ANTHROPIC_API_KEY) return error(500, 'ANTHROPIC_API_KEY not configured.');

  // Bearer API-key auth (Pro+).
  const authHeader = request.headers.get('authorization') ?? '';
  const token = /^bearer\s+/i.test(authHeader) ? authHeader.replace(/^bearer\s+/i, '').trim() : null;
  if (!token) return error(401, 'Missing API key.');

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const keyHash = await hashApiKey(token);
  const { data: key } = await supabase
    .from('api_keys')
    .select('plan, revoked_at')
    .eq('key_hash', keyHash)
    .maybeSingle();
  if (!key || key.revoked_at) return error(401, 'Invalid API key.');
  if (key.plan === 'free') return error(403, 'Rule authoring requires Pro or above.');

  let body: { description?: unknown };
  try {
    body = (await request.json()) as { description?: unknown };
  } catch {
    return error(400, 'Invalid JSON body.');
  }
  if (typeof body.description !== 'string' || !body.description.trim()) {
    return error(400, 'description is required.');
  }

  // Layer 2: Claude helps author the rule CONFIG. It never sees validated SQL.
  let claudeText: string;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 600,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: body.description.slice(0, 1000) }],
      }),
    });
    if (!res.ok) {
      const detail = await res.text();
      return error(502, 'Claude API error', { detail });
    }
    const data = (await res.json()) as { content?: { text?: string }[] };
    claudeText = data.content?.[0]?.text ?? '';
  } catch (e) {
    return error(502, 'Claude API unreachable', { detail: (e as Error)?.message });
  }

  const parsed = parseRuleSuggestion(claudeText);
  if (!parsed.ok) return error(422, parsed.error);
  return json({ rule: parsed.rule });
};
