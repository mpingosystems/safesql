import type { SchemaDefinition, ValidationIssue, ValidationReport } from '../types/validation';

const ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_VERSION = '2023-06-01';

interface AIExplanation {
  id: string;
  explanation: string;
  fix: string;
}

export async function enrichWithAIExplanations(
  report: ValidationReport,
  sql: string,
  schema?: SchemaDefinition,
  apiKey: string = import.meta.env.VITE_ANTHROPIC_API_KEY,
): Promise<ValidationReport> {
  if (!apiKey) return report;
  if (report.errors.length === 0 && report.warnings.length === 0) return report;

  const issueList: ValidationIssue[] = [...report.errors, ...report.warnings];

  const schemaSummary = schema
    ? JSON.stringify(
        schema.tables.map((t) => ({
          name: t.name,
          columns: t.columns.map((c) => c.name),
        })),
      )
    : 'Not provided';

  const prompt = `You are a senior data engineer reviewing SQL for a colleague.
You have been given a list of issues detected by a rule-based SQL validator.
For each issue, provide:
1. A plain-English explanation of WHY this is dangerous (2 sentences max)
2. A specific SQL fix example relevant to this exact query

Do NOT invent additional issues. Do NOT remove issues. Only explain the ones provided, in the same order.

SQL query being validated:
\`\`\`sql
${sql.slice(0, 2000)}
\`\`\`

Schema context:
${schemaSummary}

Issues to explain (respond as JSON array, same order):
${JSON.stringify(
  issueList.map((i) => ({ id: i.id, title: i.title, description: i.description })),
)}

Return ONLY a JSON array of objects with fields: id, explanation, fix
No markdown, no preamble.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) throw new Error(`AI API error: ${res.status}`);
    const data = await res.json();
    const raw: string = data.content?.[0]?.text ?? '[]';
    const cleaned = raw
      .replace(/^```json\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();
    const explanations: AIExplanation[] = JSON.parse(cleaned);

    const allIssues = [...report.errors, ...report.warnings];
    for (const ex of explanations) {
      const target = allIssues.find((i) => i.id === ex.id && !i.explanation);
      if (target) {
        target.explanation = ex.explanation;
        target.fix = ex.fix || target.fix;
      }
    }

    return report;
  } catch {
    return report; // graceful degradation — rules still work without AI
  }
}
