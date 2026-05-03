import type { ValidationIssue } from '../types/validation';

interface IssueCardProps {
  issue: ValidationIssue;
}

const BADGE_STYLES: Record<ValidationIssue['severity'], { bg: string; fg: string; label: string }> = {
  error: { bg: '#7f1d1d', fg: '#fecaca', label: 'ERROR' },
  warning: { bg: '#78350f', fg: '#fde68a', label: 'WARNING' },
  suggestion: { bg: '#1e3a8a', fg: '#bfdbfe', label: 'SUGGESTION' },
};

export function IssueCard({ issue }: IssueCardProps) {
  const badge = BADGE_STYLES[issue.severity];

  return (
    <div
      style={{
        border: '1px solid #27272a',
        borderRadius: 8,
        padding: 12,
        marginBottom: 10,
        background: '#18181b',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span
          style={{
            background: badge.bg,
            color: badge.fg,
            fontSize: 10,
            fontWeight: 700,
            padding: '2px 6px',
            borderRadius: 4,
            letterSpacing: 0.5,
          }}
        >
          {badge.label}
        </span>
        <span style={{ fontWeight: 600, color: '#e4e4e7', fontSize: 13 }}>{issue.title}</span>
      </div>

      <div style={{ fontSize: 12.5, color: '#a1a1aa', lineHeight: 1.5, marginBottom: 6 }}>
        {issue.description}
      </div>

      {issue.explanation && (
        <div
          style={{
            fontSize: 12.5,
            color: '#d4d4d8',
            fontStyle: 'italic',
            lineHeight: 1.5,
            marginBottom: 6,
            paddingLeft: 8,
            borderLeft: '2px solid #3f3f46',
          }}
        >
          {issue.explanation}
        </div>
      )}

      {issue.fix && (
        <pre
          style={{
            background: '#0a0a0a',
            color: '#86efac',
            fontSize: 12,
            padding: 8,
            borderRadius: 4,
            margin: 0,
            overflow: 'auto',
            fontFamily: '"JetBrains Mono", Menlo, Consolas, monospace',
          }}
        >
          {issue.fix}
        </pre>
      )}
    </div>
  );
}
