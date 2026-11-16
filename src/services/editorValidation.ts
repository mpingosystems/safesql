import type { PlanTier } from '../config/detectorTiers';
import type { CustomRule, SchemaDefinition, SqlSource, ValidationReport, ValidationRequest } from '../types/validation';
import type { ExplainOutcome } from './aiExplainer';
import { validateSQL } from './sqlValidator';

// One validation pipeline for the editor (9.6-SEC). The Validate button and the
// Monaco Ctrl+S command both run through runEditorValidation, so they apply the
// same tier, custom rules, free-tier limit and AI entitlement. Before this, the
// Ctrl+S path called validateSQL with none of them and ran the full Pro set for
// free and signed-out users.
//
// Contract: onInterim may fire once, with the deterministic report, before AI
// enrichment. The returned result is the single final report per validation.
// That final report is the one the caller persists, so each validation is
// persisted exactly once.

export type AiStatus = 'off' | 'ok' | 'unavailable';

export type ExplainFn = (report: ValidationReport, sql: string, schema?: SchemaDefinition) => Promise<ExplainOutcome>;

export interface EditorValidationOptions {
  sql: string;
  schema?: SchemaDefinition;
  dialect: ValidationRequest['dialect'];
  source?: SqlSource;
  // Omitted = full detector set (validateSQL's default). Only the Landing demo
  // omits it; the editor page always passes the user's tier.
  tier?: PlanTier;
  customRules?: CustomRule[];
  // True when the free monthly limit is reached: nothing runs, nothing persists.
  blocked?: boolean;
  // Present only when the user is entitled to AI and has it switched on.
  explain?: ExplainFn;
  onInterim?: (report: ValidationReport) => void;
  validate?: (request: ValidationRequest) => ValidationReport;
}

export interface EditorValidationResult {
  report: ValidationReport;
  sql: string;
  aiStatus: AiStatus;
}

export async function runEditorValidation(opts: EditorValidationOptions): Promise<EditorValidationResult | null> {
  if (opts.blocked) return null;
  const validate = opts.validate ?? validateSQL;
  const report = validate({
    sql: opts.sql,
    schema: opts.schema,
    dialect: opts.dialect,
    source: opts.source,
    tier: opts.tier,
    customRules: opts.customRules,
  });

  const hasFindings = report.errors.length > 0 || report.warnings.length > 0;
  if (!opts.explain || !hasFindings) return { report, sql: opts.sql, aiStatus: 'off' };

  opts.onInterim?.(report);
  const outcome = await opts.explain(report, opts.sql, opts.schema);
  return { report: outcome.report, sql: opts.sql, aiStatus: outcome.status };
}

export interface EditorValidationMeta {
  sql: string;
  aiStatus: AiStatus;
}

export interface EditorValidationHandlers {
  onValidateStart?: () => void;
  onInterimReport?: (report: ValidationReport) => void;
  // Fires exactly once per validation, with the final report.
  onValidate: (report: ValidationReport, meta: EditorValidationMeta) => void;
  clearMarkers?: () => void;
  applyMarkers?: (report: ValidationReport) => void;
}

// The Monaco Ctrl+S path. SqlEditor calls this with its latest props. A blocked
// run (free monthly limit reached) does nothing, exactly like the disabled
// Validate button.
export async function validateFromEditor(
  opts: Omit<EditorValidationOptions, 'onInterim'>,
  h: EditorValidationHandlers,
): Promise<void> {
  if (opts.blocked) return;
  h.onValidateStart?.();
  h.clearMarkers?.();
  const result = await runEditorValidation({
    ...opts,
    onInterim: (r) => {
      h.applyMarkers?.(r);
      h.onInterimReport?.(r);
    },
  });
  if (!result) return;
  h.applyMarkers?.(result.report);
  h.onValidate(result.report, { sql: result.sql, aiStatus: result.aiStatus });
}
