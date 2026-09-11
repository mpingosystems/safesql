import { SafeSQLError } from './errors';
import type {
  FetchLike,
  Issue,
  SafeSQLClientOptions,
  ValidateParams,
  ValidationResult,
  Verdict,
  DbtContextSummary,
} from './types';

const DEFAULT_BASE_URL = 'https://safesqlpro.dev';
const DEFAULT_THRESHOLD = 70;

// Shape returned by POST /api/validate (the ValidationReport from the engine).
interface RawIssue {
  id?: string;
  issueType?: string;
  severity?: string;
  title?: string;
  description?: string;
  message?: string;
  fix?: string;
  scoreImpact?: number;
  offendingClause?: string;
  offendingColumn?: string;
  offendingTable?: string;
  lineStart?: number;
  lineEnd?: number;
}

interface RawReport {
  riskScore?: number;
  processingMs?: number;
  errors?: RawIssue[];
  warnings?: RawIssue[];
  suggestions?: RawIssue[];
  error?: string;
  // Sprint 5C — tier transparency fields returned by POST /api/validate.
  tier?: string;
  detectorsRun?: string[];
  upgradePrompt?: string;
  dbtContext?: unknown;
}

/**
 * Score bands from the SafeSQL score policy:
 *   0-40 hard error, 41-69 high-risk warning, 70-84 medium, 85-100 suggestion/clean.
 */
export function verdictFor(score: number): Verdict {
  if (score <= 40) return 'CRITICAL';
  if (score < 70) return 'RISKY';
  if (score < 85) return 'REVIEW';
  return 'CLEAN';
}

function normalizeIssue(raw: RawIssue, fallbackSeverity: Issue['severity']): Issue {
  const severity = (raw.severity as Issue['severity']) ?? fallbackSeverity;
  return {
    issueType: raw.issueType ?? raw.id ?? 'UNKNOWN_ISSUE',
    severity,
    message: raw.message ?? raw.description ?? raw.title ?? '',
    fix: raw.fix ?? '',
    scoreImpact: typeof raw.scoreImpact === 'number' ? raw.scoreImpact : 0,
    offendingClause: raw.offendingClause,
    offendingColumn: raw.offendingColumn,
    offendingTable: raw.offendingTable,
    lineStart: raw.lineStart,
    lineEnd: raw.lineEnd,
  };
}

/** Errors first, then warnings, then suggestions — most severe issue first. */
export function toValidationResult(report: RawReport, threshold: number): ValidationResult {
  const issues: Issue[] = [
    ...(report.errors ?? []).map((i) => normalizeIssue(i, 'error')),
    ...(report.warnings ?? []).map((i) => normalizeIssue(i, 'warning')),
    ...(report.suggestions ?? []).map((i) => normalizeIssue(i, 'suggestion')),
  ];
  const score = typeof report.riskScore === 'number' ? report.riskScore : 0;
  return {
    valid: score >= threshold,
    score,
    verdict: verdictFor(score),
    issues,
    executionTime: typeof report.processingMs === 'number' ? report.processingMs : 0,
    // Sprint 5C — tier transparency. Passed through verbatim so a consumer can
    // tell "clean query" apart from "not checked for that".
    tier: typeof report.tier === 'string' ? report.tier : undefined,
    detectorsRun: Array.isArray(report.detectorsRun) ? report.detectorsRun : undefined,
    upgradePrompt: typeof report.upgradePrompt === 'string' ? report.upgradePrompt : undefined,
    // Sprint 8 (dbt) — provenance passthrough, shape-checked so a malformed
    // server response cannot leak an arbitrary object through the typed API.
    dbtContext: toDbtContextSummary(report.dbtContext),
  };
}

function toDbtContextSummary(raw: unknown): DbtContextSummary | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' ? v : 0);
  const artifacts = (r.artifacts && typeof r.artifacts === 'object' ? r.artifacts : {}) as Record<string, unknown>;
  return {
    models: num(r.models),
    sources: num(r.sources),
    sensitiveTagged: num(r.sensitiveTagged),
    artifacts: { catalog: artifacts.catalog === true, runResults: artifacts.runResults === true },
    warnings: Array.isArray(r.warnings) ? r.warnings.filter((w): w is string => typeof w === 'string') : [],
  };
}

/**
 * Client for the SafeSQL Pro validation API.
 *
 * ```ts
 * const client = new SafeSQLClient({ apiKey: process.env.SAFESQL_PRO_API_KEY! });
 * const result = await client.validate({ sql: 'SELECT ...' });
 * ```
 */
export class SafeSQLClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: SafeSQLClientOptions) {
    if (!options || !options.apiKey) {
      throw new Error('SafeSQLClient: apiKey is required. Get one at https://safesqlpro.dev/settings');
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!fetchImpl) {
      throw new Error('SafeSQLClient: no fetch implementation available — pass options.fetch');
    }
    // Unbound global fetch throws "Illegal invocation" in browsers.
    this.fetchImpl = options.fetch ? fetchImpl : fetchImpl.bind(globalThis);
  }

  async validate(params: ValidateParams): Promise<ValidationResult> {
    if (!params || typeof params.sql !== 'string' || params.sql.trim() === '') {
      throw new Error('SafeSQLClient.validate: sql is required');
    }
    const threshold = params.threshold ?? DEFAULT_THRESHOLD;

    const res = await this.fetchImpl(`${this.baseUrl}/api/validate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sql: params.sql,
        ddl: params.ddl ?? '',
        dialect: params.dialect ?? 'postgresql',
        ...(params.dbt ? { dbt: params.dbt } : {}),
      }),
      signal: params.signal,
    });

    let body: RawReport;
    try {
      body = (await res.json()) as RawReport;
    } catch {
      throw new SafeSQLError(`SafeSQL API returned a non-JSON response (${res.status})`, res.status);
    }

    if (!res.ok) {
      throw new SafeSQLError(body?.error ?? `SafeSQL API error (${res.status})`, res.status);
    }

    return toValidationResult(body, threshold);
  }
}
