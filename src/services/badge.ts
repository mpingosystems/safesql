// Sprint 7 Part 6 — SafeSQL Certified badge. Pure criteria + SVG so both the
// Cloudflare Function (functions/api/badge/[user_id].ts) and the Settings UI +
// tests share one implementation.

export interface BadgeInput {
  validationCount: number; // last 30 days
  averageScore: number; // 0-100
  destructiveExecuted: number; // destructive queries run despite warnings (proxy: destructive errors)
}

export interface BadgeCriteria {
  certified: boolean;
  checks: { label: string; met: boolean }[];
}

export function computeBadgeCriteria(input: BadgeInput): BadgeCriteria {
  const c1 = input.validationCount >= 100;
  const c2 = input.averageScore >= 85;
  const c3 = input.destructiveExecuted === 0;
  return {
    certified: c1 && c2 && c3,
    checks: [
      { label: '100+ validations in the last 30 days', met: c1 },
      { label: 'Average risk score ≥ 85', met: c2 },
      { label: 'No destructive SQL run despite warnings', met: c3 },
    ],
  };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface BadgeRenderOpts {
  username?: string;
  count: number;
  avgScore: number;
  certified: boolean;
  date: string; // ISO date (YYYY-MM-DD)
}

// A flat two-line SVG badge. Green when certified, grey otherwise.
export function renderBadgeSvg(opts: BadgeRenderOpts): string {
  const accent = opts.certified ? '#16a34a' : '#52525b';
  const title = opts.certified ? '✓ SafeSQL Pro Certified' : 'SafeSQL Pro — Not yet certified';
  const sub = opts.certified
    ? `Validated ${opts.count} queries · avg ${opts.avgScore} · ${opts.date}`
    : `${opts.count} validations · avg ${opts.avgScore} · keep going`;
  const who = opts.username ? `${esc(opts.username)} · ` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="56" role="img" aria-label="${esc(title)}">
  <rect width="320" height="56" rx="6" fill="#0f0f10" stroke="${accent}"/>
  <rect x="0" y="0" width="6" height="56" rx="3" fill="${accent}"/>
  <text x="18" y="24" font-family="system-ui,Segoe UI,Arial" font-size="14" font-weight="700" fill="${accent}">${esc(title)}</text>
  <text x="18" y="42" font-family="system-ui,Segoe UI,Arial" font-size="11" fill="#a1a1aa">${who}${esc(sub)}</text>
</svg>`;
}
