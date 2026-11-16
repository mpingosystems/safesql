import { describe, expect, it, vi } from 'vitest';
import { runEditorValidation, validateFromEditor, type ExplainFn } from '../services/editorValidation';
import { isDetectorEnabled } from '../config/detectorTiers';

type DetectorId = Parameters<typeof isDetectorEnabled>[0];
import { parseDDL } from '../services/schemaParser';
import type { CustomRule, ValidationReport } from '../types/validation';

// 9.6-SEC Step 3 (review item): the Monaco Ctrl+S path (validateFromEditor)
// must honor tier, custom rules and the free monthly limit exactly like the
// Validate button (runEditorValidation), and persist once per validation.

const schema = parseDDL('CREATE TABLE users (id INT PRIMARY KEY, email TEXT);');
// HALLUCINATED_TABLE is Pro-only; CARTESIAN_JOIN is free.
const PRO_ONLY_SQL = 'SELECT id FROM ghost';

const allIds = (r: ValidationReport) => [...r.errors, ...r.warnings, ...r.suggestions].map((i) => i.id);

function handlers() {
  return {
    onValidateStart: vi.fn(),
    onInterimReport: vi.fn(),
    onValidate: vi.fn(),
    clearMarkers: vi.fn(),
    applyMarkers: vi.fn(),
  };
}

const explainOk: ExplainFn = async (report) => ({
  report: { ...report, errors: report.errors.map((e) => ({ ...e, explanation: 'AI says why.' })) },
  status: 'ok',
});

describe('Ctrl+S path (validateFromEditor)', () => {
  it('free tier runs only free detectors', async () => {
    const h = handlers();
    await validateFromEditor({ sql: PRO_ONLY_SQL, schema, dialect: 'postgresql', tier: 'free' }, h);
    expect(h.onValidate).toHaveBeenCalledTimes(1);
    const final = h.onValidate.mock.calls[0][0] as ValidationReport;
    expect(allIds(final)).not.toContain('HALLUCINATED_TABLE');
    for (const id of allIds(final)) {
      if (id !== 'SYNTAX_ERROR') expect(isDetectorEnabled(id as DetectorId, 'free')).toBe(true);
    }
  });

  it('control: the same SQL on Pro surfaces the Pro-only detector', async () => {
    const h = handlers();
    await validateFromEditor({ sql: PRO_ONLY_SQL, schema, dialect: 'postgresql', tier: 'pro' }, h);
    expect(allIds(h.onValidate.mock.calls[0][0])).toContain('HALLUCINATED_TABLE');
  });

  it('blocked (free monthly limit reached): nothing runs, nothing is reported or persisted', async () => {
    const h = handlers();
    const validate = vi.fn();
    await validateFromEditor({ sql: PRO_ONLY_SQL, schema, dialect: 'postgresql', tier: 'free', blocked: true, validate }, h);
    expect(validate).not.toHaveBeenCalled();
    expect(h.onValidateStart).not.toHaveBeenCalled();
    expect(h.onValidate).not.toHaveBeenCalled();
  });

  it('honors team custom rules', async () => {
    const rule: CustomRule = {
      id: 'r1',
      name: 'No users table',
      rule_type: 'forbidden_table',
      config: { table: 'users', message: 'Use the users_masked view.' },
      severity: 'error',
      active: true,
    };
    const h = handlers();
    await validateFromEditor(
      { sql: 'SELECT id FROM users', schema, dialect: 'postgresql', tier: 'business', customRules: [rule] },
      h,
    );
    expect(allIds(h.onValidate.mock.calls[0][0])).toContain('CUSTOM_RULE');
  });

  it('with AI on: one interim render, then exactly one final onValidate (one persist)', async () => {
    const h = handlers();
    await validateFromEditor({ sql: PRO_ONLY_SQL, schema, dialect: 'postgresql', tier: 'pro', explain: explainOk }, h);
    expect(h.onInterimReport).toHaveBeenCalledTimes(1);
    expect(h.onValidate).toHaveBeenCalledTimes(1);
    const [final, meta] = h.onValidate.mock.calls[0];
    expect((final as ValidationReport).errors[0].explanation).toBe('AI says why.');
    expect(meta).toEqual({ sql: PRO_ONLY_SQL, aiStatus: 'ok' });
  });

  it('with AI off: no interim, exactly one final onValidate', async () => {
    const h = handlers();
    await validateFromEditor({ sql: PRO_ONLY_SQL, schema, dialect: 'postgresql', tier: 'pro' }, h);
    expect(h.onInterimReport).not.toHaveBeenCalled();
    expect(h.onValidate).toHaveBeenCalledTimes(1);
    expect(h.onValidate.mock.calls[0][1]).toEqual({ sql: PRO_ONLY_SQL, aiStatus: 'off' });
  });

  it('AI unavailable: final report is the deterministic one, flagged unavailable', async () => {
    const h = handlers();
    const explainDown: ExplainFn = async (report) => ({ report, status: 'unavailable' });
    await validateFromEditor({ sql: PRO_ONLY_SQL, schema, dialect: 'postgresql', tier: 'pro', explain: explainDown }, h);
    expect(h.onValidate).toHaveBeenCalledTimes(1);
    expect(h.onValidate.mock.calls[0][1].aiStatus).toBe('unavailable');
  });
});

describe('button path and Ctrl+S path agree', () => {
  it.each(['free', 'pro'] as const)('same detector set for tier %s', async (tier) => {
    const button = await runEditorValidation({ sql: PRO_ONLY_SQL, schema, dialect: 'postgresql', tier });
    const h = handlers();
    await validateFromEditor({ sql: PRO_ONLY_SQL, schema, dialect: 'postgresql', tier }, h);
    expect(allIds(h.onValidate.mock.calls[0][0]).sort()).toEqual(allIds(button!.report).sort());
  });

  it('button path is blocked by the limit too', async () => {
    expect(await runEditorValidation({ sql: PRO_ONLY_SQL, dialect: 'postgresql', blocked: true })).toBeNull();
  });
});
