import type { ValidationIssue } from '../types/validation';

// A 1-based line/column range, the shape Monaco's IMarkerData expects.
export interface MarkerRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

const CLAUSE_KEYWORDS: Record<string, RegExp> = {
  WHERE: /\bWHERE\b/i,
  JOIN: /\bJOIN\b/i,
  SELECT: /\bSELECT\b/i,
  FROM: /\bFROM\b/i,
  'GROUP BY': /\bGROUP\s+BY\b/i,
  HAVING: /\bHAVING\b/i,
  'ORDER BY': /\bORDER\s+BY\b/i,
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Convert a 0-based character offset into a 1-based {line, col} position.
function offsetToPosition(sql: string, offset: number): { line: number; col: number } {
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < offset && i < sql.length; i++) {
    if (sql[i] === '\n') {
      line++;
      lastNewline = i;
    }
  }
  return { line, col: offset - lastNewline };
}

// Best-effort: find the character range in the raw SQL that an issue points at,
// preferring the most specific anchor available (column → table → clause).
// Returns null when nothing can be located, so the caller can fall back.
export function locateIssue(sql: string, issue: ValidationIssue): MarkerRange | null {
  let idx = -1;
  let len = 0;

  if (issue.offendingColumn) {
    const col = escapeRegExp(issue.offendingColumn);
    // Prefer a qualified `alias.column` hit when a table/alias is known.
    if (issue.offendingTable) {
      const m = new RegExp(`\\b[A-Za-z_]\\w*\\.${col}\\b`, 'i').exec(sql);
      if (m) {
        idx = m.index;
        len = m[0].length;
      }
    }
    if (idx < 0) {
      const m = new RegExp(`\\b${col}\\b`, 'i').exec(sql);
      if (m) {
        idx = m.index;
        len = m[0].length;
      }
    }
  }

  if (idx < 0 && issue.offendingTable) {
    const m = new RegExp(`\\b${escapeRegExp(issue.offendingTable)}\\b`, 'i').exec(sql);
    if (m) {
      idx = m.index;
      len = m[0].length;
    }
  }

  if (idx < 0 && issue.offendingClause) {
    const re = CLAUSE_KEYWORDS[issue.offendingClause];
    const m = re?.exec(sql);
    if (m) {
      idx = m.index;
      len = m[0].length;
    }
  }

  if (idx < 0 || len === 0) return null;

  const start = offsetToPosition(sql, idx);
  const end = offsetToPosition(sql, idx + len);
  return {
    startLineNumber: start.line,
    startColumn: start.col,
    endLineNumber: end.line,
    endColumn: end.col,
  };
}
