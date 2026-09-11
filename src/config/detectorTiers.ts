import type { DetectorId } from '../types/validation';

// ─────────────────────────────────────────────────────────────────────────────
// Sprint 5C — free/pro detector tier split (open-core model).
//
// Free users get a genuinely useful core set that builds trust. Pro+ gets all
// 33 built-in detectors, including the subtle high-value ones (fan-out
// aggregates, schema hallucination, NULL semantics, dialect portability).
//
// NAMING NOTE (deviation from the Sprint 5C prompt, documented deliberately):
// the prompt listed 12 free-tier names that do not exist in this codebase —
// see the pre-Sprint-5 audit. Each has been mapped to the real `issueType` it
// described, and the four with no implementation at all were replaced with the
// closest-in-spirit shipped detector. The mapping is spelled out per entry so
// the substitution is auditable rather than silent.
// ─────────────────────────────────────────────────────────────────────────────

export type PlanTier = 'free' | 'pro' | 'team' | 'business' | 'enterprise';

// The 12 free core detectors. Each line records the Sprint 5C prompt name it
// satisfies, so the plan doc and the code can be reconciled later.
export const FREE_DETECTOR_SLUGS: DetectorId[] = [
  'CARTESIAN_JOIN',            // prompt: CARTESIAN_PRODUCT + MISSING_JOIN_CONDITION (both describe this)
  'CROSS_JOIN_RISK',           // prompt: CROSS_JOIN_WITHOUT_LIMIT
  'JOIN_MULTIPLICATION',       // prompt: FANOUT_JOIN — the basic row-multiplication warning.
                               //   AGGREGATE_OVER_FANOUT_JOIN (the flagship) stays Pro, per the plan.
  'INNER_JOIN_NULL_EXCLUSION', // prompt: NULLABLE_JOIN_KEY
  'AMBIGUOUS_COLUMN',          // prompt: AMBIGUOUS_COLUMN_REFERENCE
  'SELECT_STAR_EXPENSIVE',     // prompt: UNQUALIFIED_SELECT_STAR
  'MISSING_WHERE_DESTRUCTIVE', // prompt: MISSING_WHERE_CLAUSE (fires on UPDATE/DELETE, not SELECT)
  // ── Substitutions for prompt names with no implementation ──────────────────
  'DESTRUCTIVE_DDL',           // replaces IMPLICIT_TYPE_CAST (unimplemented).
                               //   Safety: a free user's DROP must never go unflagged.
  'DESTRUCTIVE_TRUNCATE',      // same rationale as DESTRUCTIVE_DDL.
  'NULL_EQUALITY_COMPARISON',  // replaces DIVISION_BY_ZERO_RISK (unimplemented).
                               //   `col = NULL` is the same class: an obvious, high-trust catch.
  'INCOMPLETE_GROUP_BY',       // replaces DUPLICATE_COLUMN_NAMES (unimplemented).
  'UNKNOWN_ALIAS',             // replaces UNINDEXED_LEADING_WILDCARD (unimplemented, and a
                               //   performance rule rather than a semantic one).
];

// All 33 built-in detectors — the Pro+ set. CUSTOM_RULE is excluded on purpose:
// it is a Business-tier engine driven by caller-supplied rules, not a built-in
// detector. SYNTAX_ERROR is excluded because it is a parse-failure fallback and
// is never gated (see ungatedDetectors below).
export const PRO_DETECTOR_SLUGS: DetectorId[] = [
  ...FREE_DETECTOR_SLUGS,
  'AGGREGATE_OVER_FANOUT_JOIN',
  'MULTIPLE_ONE_TO_MANY_JOINS',
  'AGGREGATION_GRAIN_MISMATCH',
  'HALLUCINATED_TABLE',
  'HALLUCINATED_COLUMN',
  'LEFT_JOIN_FILTERED_IN_WHERE',
  'SUSPICIOUS_JOIN_KEY',
  'SCD_JOIN_WITHOUT_EFFECTIVE_DATE',
  'NOT_IN_NULLABLE',
  'AVG_OVER_NULLABLE',
  'CONTRADICTORY_FILTER',
  'INTEGER_DIVISION_RISK',
  'COUNT_PARENT_AFTER_CHILD_JOIN',
  'COUNT_STAR_VS_COUNT_COL',
  'HAVING_WITHOUT_GROUP_BY',
  'MISSING_TIME_FILTER',
  'DIALECT_MISMATCH',
  'NON_DETERMINISTIC_WINDOW_ORDER',
  'WINDOW_MISSING_ORDER',
  'COALESCE_IN_JOIN_KEY',
  'IMPLICIT_TIMEZONE',
  // ── Sprint 8 (dbt manifest context) — Pro; require request.dbtContext ─────
  'UNAPPROVED_SOURCE',
  'FINANCE_TAG_UNVALIDATED',
];

// Total built-in detector count. Single source of truth for every UI string —
// import this rather than hardcoding a number, so the count can never drift
// from the implementation again.
export const TOTAL_DETECTORS = PRO_DETECTOR_SLUGS.length;
export const FREE_DETECTOR_COUNT = FREE_DETECTOR_SLUGS.length;

// Never gated, on any tier:
//   SYNTAX_ERROR — a parse failure, not a detection. Gating it would leave a
//     free user with an unexplained empty report.
//   CUSTOM_RULE  — only present when a Business caller supplied rules; the tier
//     check happens at the point the rules are loaded.
const UNGATED: ReadonlySet<string> = new Set<DetectorId>(['SYNTAX_ERROR', 'CUSTOM_RULE']);

export function getDetectorsForTier(tier: PlanTier): DetectorId[] {
  return tier === 'free' ? FREE_DETECTOR_SLUGS : PRO_DETECTOR_SLUGS;
}

// True when `id` is allowed to produce a finding on `tier`.
export function isDetectorEnabled(id: DetectorId, tier: PlanTier): boolean {
  if (UNGATED.has(id)) return true;
  return getDetectorsForTier(tier).includes(id);
}

// The detectors a free tier does NOT run — used to size the upgrade prompt.
// Deliberately not surfaced per-detector in the UI: the prompt says how many
// were withheld, never which ones.
export function gatedDetectorCount(tier: PlanTier): number {
  return TOTAL_DETECTORS - getDetectorsForTier(tier).length;
}
