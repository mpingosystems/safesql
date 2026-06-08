import type { ValidationIssue } from '../types/validation';

// PQ4 — one-click apply fix. Many issue.fix strings are guidance ("move the
// condition to the ON clause") that can't be mechanically applied, but a subset
// have a deterministic, safe rewrite. applyFix returns the rewritten SQL for
// those, or null when the fix must be applied by hand.
//
// Pure + side-effect free so it's unit-testable; the editor wires the result
// into the model and re-validates.
export function applyFix(sql: string, issue: ValidationIssue): string | null {
  switch (issue.id) {
    case 'NULL_EQUALITY_COMPARISON':
      return fixNullEquality(sql);
    default:
      return null;
  }
}

export function canApplyFix(issue: ValidationIssue): boolean {
  return issue.id === 'NULL_EQUALITY_COMPARISON';
}

// `col = NULL` → `col IS NULL`; `col != NULL` / `col <> NULL` → `col IS NOT NULL`.
function fixNullEquality(sql: string): string | null {
  let changed = false;
  const out = sql.replace(
    /([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*(=|!=|<>)\s*NULL\b/gi,
    (_m, col: string, op: string) => {
      changed = true;
      return `${col} IS ${op === '=' ? '' : 'NOT '}NULL`;
    },
  );
  return changed ? out : null;
}
