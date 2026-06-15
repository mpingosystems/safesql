// Render a sandbox result cell as a human-readable string.
//
// DATE_TRUNC('month', …) — the common analytics grouping — returns a
// first-of-month value that PGlite serializes as a raw ISO timestamp
// ("2026-05-01T05:00:00.000Z"). That reads like a bug to a user staring at a
// revenue-by-month table, so we collapse any first-of-month date down to a
// "May 2026" label.
//
// The year/month are taken from the literal (regex groups), NOT from
// new Date(value).toLocaleDateString(): converting the ISO instant to a local
// date shifts it back a day in any timezone west of the baked-in offset, which
// would render "2026-05-01T05:00:00.000Z" as "Apr 2026". Anchoring the label to
// the parsed Y/M in UTC makes it timezone-independent.
export function formatCell(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'string') {
    // First-of-month, with or without a trailing ISO time component.
    const m = v.match(/^(\d{4})-(\d{2})-01(?:[T ][\d:.]+Z?)?$/);
    if (m) {
      const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
      return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
    }
    return v;
  }
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
