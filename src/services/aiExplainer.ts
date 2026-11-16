import type { SchemaDefinition, ValidationIssue, ValidationReport } from '../types/validation';
import { apiUrl } from '../config/api';
import type { AIExplanation, ExplainRequestBody } from './explainPrompt';

// Layer 2 (explanation only). 9.6-SEC: the browser never talks to an AI
// provider and never holds a provider key. It asks POST /api/explain with the
// Clerk session token, and the server checks the plan and holds the key.
//
// Graceful degradation: any failure (signed out, not entitled, AI down) returns
// the deterministic report unchanged with status 'unavailable'. Detection
// results are always complete without AI.

export type ExplainStatus = 'ok' | 'unavailable';

export interface ExplainOutcome {
  report: ValidationReport;
  status: ExplainStatus;
}

export const AI_UNAVAILABLE_NOTE = 'AI explanation unavailable right now. Detection results above are complete.';

export function buildExplainBody(report: ValidationReport, sql: string, schema?: SchemaDefinition): ExplainRequestBody {
  const issues = [...report.errors, ...report.warnings].map((i) => ({ id: i.id, title: i.title, description: i.description }));
  return {
    sql,
    issues,
    schema: schema?.tables.map((t) => ({ name: t.name, columns: t.columns.map((c) => c.name) })),
  };
}

function merge(report: ValidationReport, explanations: AIExplanation[]): ValidationReport {
  // Each explanation fills the first unexplained issue with its id, in order,
  // so repeated issue ids each get their own entry. Returns new arrays and
  // never mutates the deterministic report the caller already rendered.
  const remaining = [...explanations];
  const apply = (issue: ValidationIssue): ValidationIssue => {
    if (issue.explanation) return issue;
    const idx = remaining.findIndex((e) => e.id === issue.id);
    if (idx < 0) return issue;
    const [ex] = remaining.splice(idx, 1);
    return { ...issue, explanation: ex.explanation, fix: ex.fix || issue.fix };
  };
  return { ...report, errors: report.errors.map(apply), warnings: report.warnings.map(apply) };
}

export async function enrichWithAIExplanations(
  report: ValidationReport,
  sql: string,
  schema: SchemaDefinition | undefined,
  getToken: () => Promise<string | null>,
  fetchImpl: typeof fetch = fetch,
): Promise<ExplainOutcome> {
  if (report.errors.length === 0 && report.warnings.length === 0) return { report, status: 'ok' };

  try {
    const token = await getToken();
    if (!token) return { report, status: 'unavailable' };

    const res = await fetchImpl(apiUrl('/api/explain'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(buildExplainBody(report, sql, schema)),
    });
    if (!res.ok) return { report, status: 'unavailable' };

    const data = (await res.json()) as { explanations?: AIExplanation[] };
    if (!Array.isArray(data.explanations)) return { report, status: 'unavailable' };
    return { report: merge(report, data.explanations), status: 'ok' };
  } catch {
    return { report, status: 'unavailable' };
  }
}
