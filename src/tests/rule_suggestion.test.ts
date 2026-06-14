import { describe, it, expect } from 'vitest';
import { parseRuleSuggestion } from '../services/ruleSuggestion';

describe('parseRuleSuggestion', () => {
  it('extracts rule_type, config, and severity from valid JSON', () => {
    const raw = JSON.stringify({
      rule_type: 'required_filter',
      name: 'Require tenant_id filter on payments',
      description: 'Always filter payments by tenant_id',
      config: { table: 'payments', column: 'tenant_id', message: 'Always filter payments by tenant_id' },
      severity: 'error',
    });
    const r = parseRuleSuggestion(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rule.rule_type).toBe('required_filter');
      expect(r.rule.config.table).toBe('payments');
      expect(r.rule.severity).toBe('error');
    }
  });

  it('strips ```json fences before parsing', () => {
    const raw = '```json\n{"rule_type":"forbidden_table","name":"x","description":"y","config":{"table":"secrets"},"severity":"error"}\n```';
    const r = parseRuleSuggestion(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rule.rule_type).toBe('forbidden_table');
  });

  it('returns an error for invalid JSON', () => {
    expect(parseRuleSuggestion('this is not json at all').ok).toBe(false);
  });

  it('returns an error when rule_type is missing', () => {
    expect(parseRuleSuggestion(JSON.stringify({ name: 'x', config: { table: 't' } })).ok).toBe(false);
  });

  it('returns an error when config is missing', () => {
    expect(parseRuleSuggestion(JSON.stringify({ rule_type: 'forbidden_table', name: 'x' })).ok).toBe(false);
  });

  it('defaults severity to warning when absent or invalid', () => {
    const r = parseRuleSuggestion(JSON.stringify({ rule_type: 'forbidden_table', config: { table: 't' } }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rule.severity).toBe('warning');
  });
});
