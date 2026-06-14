import type { CustomRuleType } from '../types/validation';

// Sprint 11 Part 4 — natural-language custom-rule authoring (Layer 2, assistance
// only). Claude drafts a rule CONFIG from a plain-English description; this
// parser validates that draft before it reaches the form. Detection itself stays
// 100% deterministic — Claude never sees the SQL being validated.

const RULE_TYPES: readonly CustomRuleType[] = [
  'required_filter',
  'forbidden_table',
  'required_join_condition',
  'forbidden_pattern',
  'required_column_qualification',
];

export interface SuggestedRule {
  rule_type: CustomRuleType;
  name: string;
  description: string;
  config: Record<string, unknown>;
  severity: 'error' | 'warning' | 'suggestion';
}

export type ParseResult = { ok: true; rule: SuggestedRule } | { ok: false; error: string };

// Pull the first balanced JSON object out of Claude's reply, tolerating ```json
// fences or stray prose.
function stripToJson(raw: string): string {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  return start >= 0 && end > start ? body.slice(start, end + 1) : body.trim();
}

export function parseRuleSuggestion(raw: string): ParseResult {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(stripToJson(raw)) as Record<string, unknown>;
  } catch {
    return { ok: false, error: 'Could not parse rule suggestion' };
  }
  if (!obj || typeof obj !== 'object') {
    return { ok: false, error: 'Could not parse rule suggestion' };
  }
  const ruleType = obj.rule_type;
  if (typeof ruleType !== 'string' || !RULE_TYPES.includes(ruleType as CustomRuleType)) {
    return { ok: false, error: 'Missing or unknown rule_type' };
  }
  if (!obj.config || typeof obj.config !== 'object') {
    return { ok: false, error: 'Missing rule config' };
  }
  const sev = obj.severity;
  const severity = sev === 'error' || sev === 'warning' || sev === 'suggestion' ? sev : 'warning';
  return {
    ok: true,
    rule: {
      rule_type: ruleType as CustomRuleType,
      name: typeof obj.name === 'string' ? obj.name : '',
      description: typeof obj.description === 'string' ? obj.description : '',
      config: obj.config as Record<string, unknown>,
      severity,
    },
  };
}
