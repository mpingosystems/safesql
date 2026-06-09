import type { SandboxResult, SchemaDefinition } from '../types/validation';
import { generateSandboxData } from './sandboxGenerator';

// Lazy-load PGlite — its WASM bundle is ~7-10MB and we only want to ship it
// when the user actually clicks "Run sandbox".
type PGliteCtor = typeof import('@electric-sql/pglite').PGlite;
let pgliteCtorPromise: Promise<PGliteCtor> | null = null;
function loadPGlite(): Promise<PGliteCtor> {
  if (!pgliteCtorPromise) {
    pgliteCtorPromise = import('@electric-sql/pglite')
      .then((m) => m.PGlite)
      .catch((err: unknown) => {
        // A failed dynamic import memoizes a REJECTED promise, which would
        // poison every later retry. Clear it so a reload (or a retry after a
        // new deploy lands) can succeed.
        pgliteCtorPromise = null;
        const msg = String((err as Error)?.message ?? err);
        // Classic "stale index.html after redeploy" symptom: the cached HTML
        // references a chunk hash that no longer exists on the server.
        if (/dynamically imported module|Failed to fetch|error loading|importing a module/i.test(msg)) {
          throw new Error(
            'Could not load the sandbox engine. A new version of SafeSQL Pro was likely just deployed — ' +
              'reload the page (Ctrl/Cmd+Shift+R) and run again.',
          );
        }
        throw err as Error;
      });
  }
  return pgliteCtorPromise;
}

export interface SandboxRunRequest {
  ddl: string;
  sql: string;
  schema: SchemaDefinition;
  expectedRows?: number;
  // Either a uniform row count for every table, or a per-table override map
  // (table-name → rows). Defaults to 100 for any table not specified.
  rowsPerTable?: number | Record<string, number>;
  seed?: number;
}

export async function runSandbox(req: SandboxRunRequest): Promise<SandboxResult> {
  const PGlite = await loadPGlite();
  const db = new PGlite();

  try {
    await db.exec(req.ddl);

    // SafeSQLSandboxGenerator: schema-faithful rows in FK (topological) order.
    const inserts = generateSandboxData(req.schema, {
      rowsPerTable: req.rowsPerTable,
      seed: req.seed,
    });
    if (inserts.length > 0) await db.exec(inserts.join('\n'));

    const start = performance.now();
    let rows: Record<string, unknown>[] = [];
    let executionError: string | undefined;
    try {
      const result = await db.query(req.sql);
      rows = (result.rows as Record<string, unknown>[]) ?? [];
    } catch (e) {
      executionError = (e as Error).message;
    }
    const executionMs = performance.now() - start;
    const totalRows = rows.length;

    const sandboxResult: SandboxResult = {
      rows: rows.slice(0, 50),
      totalRows,
      executionMs,
      expectedRows: req.expectedRows,
      executionError,
    };

    if (
      executionError === undefined &&
      typeof req.expectedRows === 'number' &&
      req.expectedRows > 0
    ) {
      const ratio = totalRows / req.expectedRows;
      sandboxResult.rowCountFlag = {
        expected: req.expectedRows,
        actual: totalRows,
        ratio,
        message: messageForRatio(ratio, req.expectedRows, totalRows),
      };
    }

    return sandboxResult;
  } finally {
    await db.close();
  }
}

function messageForRatio(ratio: number, expected: number, actual: number): string {
  if (ratio > 1.5) {
    return `Got ${actual} rows for ${expected} expected — JOIN multiplication is confirmed (${ratio.toFixed(1)}× inflation).`;
  }
  if (ratio < 0.5) {
    return `Got ${actual} rows for ${expected} expected — query is dropping rows you may want (${(ratio * 100).toFixed(0)}% of expected).`;
  }
  return `Got ${actual} rows for ${expected} expected (${ratio.toFixed(2)}× ratio).`;
}

// Backwards-compatible no-op. Generation state used to live module-globally and
// needed resetting between runs; the SafeSQLSandboxGenerator is now self-
// contained per call, so there is nothing to reset. Kept exported because tests
// (and any external callers) still import it.
export function resetSandboxState(): void {
  /* no-op — generator state is now local to each generateSandboxData() call */
}
