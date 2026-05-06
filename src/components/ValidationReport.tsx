import { useState } from 'react';
import type { ValidationReport as Report } from '../types/validation';
import { RiskScore } from './RiskScore';
import { IssueCard } from './IssueCard';

interface ValidationReportProps {
  report: Report | null;
  onExecute?: () => void;
  onFixIssues?: () => void;
}

type Tab = 'errors' | 'warnings' | 'suggestions';

export function ValidationReport({ report, onExecute, onFixIssues }: ValidationReportProps) {
  const [tab, setTab] = useState<Tab>('errors');

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
          issues.map((issue, idx) => <IssueCard key={`${issue.id}-${idx}`} issue={issue} />)
        )}
      </div>

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
