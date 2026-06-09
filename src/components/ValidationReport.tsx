import { useState } from 'react';
import type {
  SchemaDefinition,
  ValidationIssue,
  ValidationReport as Report,
} from '../types/validation';
import { RiskScore } from './RiskScore';
import { IssueCard } from './IssueCard';
import { ProofPanel } from './ProofPanel';
import { createSharedValidation } from '../services/sharedValidation';

interface ValidationReportProps {
  report: Report | null;
  onExecute?: () => void;
  onFixIssues?: () => void;
  // PQ context — supplied by the editor, omitted in read-only share view.
  sql?: string;
  ddl?: string;
  schema?: SchemaDefinition | null;
  dialect?: string;
  isPro?: boolean;
  onApplyFix?: (issue: ValidationIssue) => void;
  // Sprint 10 — when supplied (editor, team users), a risky query (<70) can be
  // sent to the team's approval inbox. Omitted in read-only share view.
  onRequestApproval?: () => void;
}

const SOURCE_LABELS: Record<string, string> = {
  cursor: '⚡ Cursor-generated',
  copilot: '⚡ Copilot-generated',
  chatgpt: '⚡ ChatGPT-generated',
  manual: '✍ Hand-written',
  unknown: 'Source: unknown',
};

type Tab = 'errors' | 'warnings' | 'suggestions';

export function ValidationReport({
  report,
  onExecute,
  onFixIssues,
  sql,
  ddl,
  schema,
  dialect,
  isPro = false,
  onApplyFix,
  onRequestApproval,
}: ValidationReportProps) {
  const [tab, setTab] = useState<Tab>('errors');
  const [copied, setCopied] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [shortUrl, setShortUrl] = useState<string | null>(null);
  const [shareError, setShareError] = useState(false);

  // Create a DB-backed short URL (safesqlpro.dev/v/{id}) and copy it.
  // Free + Pro alike — the permalink is the team-acquisition channel.
  const shareLink = async () => {
    if (!report || !sql || sharing) return;
    setSharing(true);
    setShareError(false);
    const res = await createSharedValidation({
      sql,
      report,
      dialect: dialect ?? 'postgresql',
      ddl: ddl || undefined,
      source: report.source,
    });
    setSharing(false);
    if (!res) {
      setShareError(true);
      return;
    }
    setShortUrl(res.url);
    try {
      await navigator.clipboard.writeText(res.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt('Copy this validation link:', res.url);
    }
  };

  if (!report) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <RiskScore score={100} neutral />
        <div
          style={{
            padding: 16,
            color: '#71717a',
            fontSize: 13,
            textAlign: 'center',
            borderTop: '1px solid #27272a',
          }}
        >
          No errors. Press <kbd style={kbdStyle}>Ctrl</kbd>+<kbd style={kbdStyle}>S</kbd> or click{' '}
          <b>Validate</b> to check this query.
        </div>
      </div>
    );
  }

  const counts = {
    errors: report.errors.length,
    warnings: report.warnings.length,
    suggestions: report.suggestions.length,
  };

  const issues =
    tab === 'errors' ? report.errors : tab === 'warnings' ? report.warnings : report.suggestions;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <RiskScore score={report.riskScore} />

      {/* PQ1 source badge + PQ5 copy-link */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 12px',
          gap: 8,
        }}
      >
        {report.source ? (
          <span
            style={{
              fontSize: 10.5,
              fontWeight: 700,
              padding: '2px 8px',
              borderRadius: 999,
              background: report.source === 'manual' ? '#27272a' : '#78350f',
              color: report.source === 'manual' ? '#a1a1aa' : '#fde68a',
            }}
          >
            {SOURCE_LABELS[report.source] ?? report.source}
          </span>
        ) : (
          <span />
        )}
        {sql && (
          <button
            type="button"
            onClick={() => void shareLink()}
            disabled={sharing}
            title="Create a short, shareable link to this validation"
            style={{
              background: 'transparent',
              border: '1px solid #27272a',
              borderRadius: 5,
              color: shareError ? '#f87171' : copied ? '#22c55e' : '#a1a1aa',
              fontSize: 11,
              padding: '3px 8px',
              cursor: sharing ? 'wait' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 5,
            }}
          >
            {sharing ? 'Creating…' : shareError ? 'Link unavailable' : copied ? '✓ Copied' : '🔗 Share'}
          </button>
        )}
      </div>
      {shortUrl && (
        <div
          style={{
            padding: '0 12px 6px',
            fontSize: 11,
            color: '#71717a',
            display: 'flex',
            justifyContent: 'flex-end',
          }}
        >
          <code style={{ color: '#a78bfa', wordBreak: 'break-all' }}>{shortUrl}</code>
        </div>
      )}

      <div
        role="tablist"
        style={{
          display: 'flex',
          borderTop: '1px solid #27272a',
          borderBottom: '1px solid #27272a',
        }}
      >
        <TabButton active={tab === 'errors'} onClick={() => setTab('errors')} label={`Errors (${counts.errors})`} accent="#ef4444" />
        <TabButton active={tab === 'warnings'} onClick={() => setTab('warnings')} label={`Warnings (${counts.warnings})`} accent="#eab308" />
        <TabButton active={tab === 'suggestions'} onClick={() => setTab('suggestions')} label={`Suggestions (${counts.suggestions})`} accent="#3b82f6" />
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
        {issues.length === 0 ? (
          <div style={{ color: '#52525b', fontSize: 13, textAlign: 'center', padding: 24 }}>
            No {tab}.
          </div>
        ) : (
          issues.map((issue, idx) => (
            <IssueCard
              key={`${issue.id}-${idx}`}
              issue={issue}
              isPro={isPro}
              onApplyFix={onApplyFix}
            />
          ))
        )}
      </div>

      {/* PQ2 — synthetic proof renders only when a fan-out/grain issue exists */}
      <ProofPanel report={report} sql={sql ?? ''} ddl={ddl ?? ''} schema={schema ?? null} />

      <div style={{ padding: 12, borderTop: '1px solid #27272a' }}>
        {report.errors.length > 0 ? (
          <button
            type="button"
            onClick={onFixIssues}
            style={{ ...actionBtn, background: '#dc2626', color: 'white' }}
          >
            Fix Issues First
          </button>
        ) : report.riskScore >= 85 ? (
          <button
            type="button"
            onClick={onExecute}
            style={{ ...actionBtn, background: '#16a34a', color: 'white' }}
          >
            Safe to Execute ✓
          </button>
        ) : (
          <button
            type="button"
            onClick={onExecute}
            style={{ ...actionBtn, background: '#27272a', color: '#e4e4e7' }}
          >
            Execute with Warnings
          </button>
        )}
        {onRequestApproval && report.errors.length === 0 && report.riskScore < 70 && (
          <button
            type="button"
            onClick={onRequestApproval}
            style={{ ...actionBtn, background: 'transparent', color: '#a78bfa', border: '1px solid #7c3aed', marginTop: 8 }}
          >
            Request Approval
          </button>
        )}
        <div style={{ fontSize: 11, color: '#71717a', textAlign: 'center', marginTop: 8 }}>
          Validated in {report.processingMs.toFixed(0)}ms
        </div>
      </div>
    </div>
  );
}

const kbdStyle: React.CSSProperties = {
  background: '#27272a',
  border: '1px solid #3f3f46',
  borderRadius: 3,
  padding: '1px 5px',
  fontSize: 11,
  fontFamily: 'monospace',
};

const actionBtn: React.CSSProperties = {
  width: '100%',
  padding: '10px 14px',
  borderRadius: 6,
  border: 'none',
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: 13,
};

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  label: string;
  accent: string;
}

function TabButton({ active, onClick, label, accent }: TabButtonProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        flex: 1,
        padding: '10px 8px',
        background: active ? '#18181b' : 'transparent',
        color: active ? accent : '#a1a1aa',
        border: 'none',
        borderBottom: active ? `2px solid ${accent}` : '2px solid transparent',
        cursor: 'pointer',
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      {label}
    </button>
  );
}
