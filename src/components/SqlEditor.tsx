import { useEffect, useLayoutEffect, useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import type {
  CustomRule,
  SchemaDefinition,
  SqlSource,
  ValidationIssue,
  ValidationReport,
} from '../types/validation';
import type { PlanTier } from '../config/detectorTiers';
import { validateSQL } from '../services/sqlValidator';
import { validateFromEditor, type EditorValidationMeta, type ExplainFn } from '../services/editorValidation';
import { locateIssue } from '../services/issueLocator';

type Dialect = 'postgresql' | 'mysql' | 'bigquery' | 'snowflake';

export interface SqlEditorProps {
  value: string;
  onChange: (next: string) => void;
  // Fires exactly once per Ctrl+S validation, with the final report. Persist here.
  onValidate: (report: ValidationReport, meta: EditorValidationMeta) => void;
  // Fires before AI enrichment with the deterministic report (display only).
  onInterimReport?: (report: ValidationReport) => void;
  onValidateStart?: () => void;
  schema?: SchemaDefinition;
  dialect?: Dialect;
  source?: SqlSource;
  // 9.6-SEC: Ctrl+S honors the same tier, custom rules, limit and AI
  // entitlement as the Validate button. Omitting tier runs the full detector
  // set, which only the Landing demo does.
  tier?: PlanTier;
  customRules?: CustomRule[];
  blocked?: boolean;
  explain?: ExplainFn;
  height?: string | number;
  clearSignal?: number;
}

const SEVERITY_TO_MARKER: Record<ValidationIssue['severity'], number> = {
  error: 8,
  warning: 4,
  suggestion: 1,
};

export function SqlEditor(props: SqlEditorProps) {
  const { value, onChange, height = '100%', clearSignal } = props;

  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof import('monaco-editor') | null>(null);
  // The Ctrl+S command is registered once, on mount. Reading props through this
  // ref keeps it from running with the first render's tier, AI or limit state.
  const propsRef = useRef(props);
  useLayoutEffect(() => {
    propsRef.current = props;
  });

  const clearMarkers = () => {
    const ed = editorRef.current;
    const monaco = monacoRef.current;
    const model = ed?.getModel();
    if (monaco && model) monaco.editor.setModelMarkers(model, 'safesql', []);
  };

  const runValidation = async () => {
    const ed = editorRef.current;
    if (!ed) return;
    const p = propsRef.current;
    await validateFromEditor(
      {
        sql: ed.getValue(),
        schema: p.schema,
        dialect: p.dialect ?? 'postgresql',
        source: p.source,
        tier: p.tier,
        customRules: p.customRules,
        blocked: p.blocked,
        explain: p.explain,
      },
      {
        onValidateStart: p.onValidateStart,
        onInterimReport: p.onInterimReport,
        onValidate: p.onValidate,
        clearMarkers,
        applyMarkers,
      },
    );
  };

  const applyMarkers = (report: ValidationReport) => {
    const ed = editorRef.current;
    const monaco = monacoRef.current;
    if (!ed || !monaco) return;

    const model = ed.getModel();
    if (!model) return;

    const sql = model.getValue();
    const issues = [...report.errors, ...report.warnings, ...report.suggestions];
    const markers: editor.IMarkerData[] = issues.map((issue) => {
      // PQ3: anchor the squiggle on the offending clause/table/column. Fall back
      // to the whole first line only when the locator can't find the token.
      const range =
        (issue.lineStart
          ? {
              startLineNumber: issue.lineStart,
              startColumn: issue.columnStart ?? 1,
              endLineNumber: issue.lineEnd ?? issue.lineStart,
              endColumn: issue.columnEnd ?? model.getLineMaxColumn(issue.lineEnd ?? issue.lineStart),
            }
          : locateIssue(sql, issue)) ?? {
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: 1,
          endColumn: model.getLineMaxColumn(1),
        };
      const fixHint = issue.fix ? `\n\nFix: ${issue.fix}` : '';
      return {
        severity: SEVERITY_TO_MARKER[issue.severity],
        message: `${issue.title}\n${issue.description}${fixHint}`,
        source: `safesql · ${issue.id}`,
        ...range,
      };
    });

    monaco.editor.setModelMarkers(model, 'safesql', markers);
  };

  const handleMount: OnMount = (ed, monaco) => {
    editorRef.current = ed;
    monacoRef.current = monaco;

    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void runValidation();
    });
  };

  useEffect(() => {
    return () => {
      clearMarkers();
    };
  }, []);

  useEffect(() => {
    if (clearSignal === undefined) return;
    clearMarkers();
  }, [clearSignal]);

  return (
    <Editor
      height={height}
      defaultLanguage="sql"
      theme="vs-dark"
      value={value}
      onChange={(v) => onChange(v ?? '')}
      onMount={handleMount}
      options={{
        minimap: { enabled: false },
        fontSize: 14,
        lineNumbers: 'on',
        automaticLayout: true,
        scrollBeyondLastLine: false,
        wordWrap: 'on',
      }}
    />
  );
}

export function useSqlEditorValidator() {
  // Helper for parents that want to trigger validation imperatively
  // without holding a ref to the editor instance.
  return {
    validate(sql: string, schema?: SchemaDefinition, dialect: Dialect = 'postgresql') {
      return validateSQL({ sql, schema, dialect });
    },
  };
}
