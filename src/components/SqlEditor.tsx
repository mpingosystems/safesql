import { useEffect, useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import type { SchemaDefinition, ValidationIssue, ValidationReport } from '../types/validation';
import { validateSQL } from '../services/sqlValidator';
import { enrichWithAIExplanations } from '../services/aiExplainer';

type Dialect = 'postgresql' | 'mysql' | 'bigquery' | 'snowflake' | 'ansi';

export interface SqlEditorProps {
  value: string;
  onChange: (next: string) => void;
  onValidate: (report: ValidationReport) => void;
  schema?: SchemaDefinition;
  dialect?: Dialect;
  aiEnabled?: boolean;
  height?: string | number;
}

const SEVERITY_TO_MARKER: Record<ValidationIssue['severity'], number> = {
  error: 8,
  warning: 4,
  suggestion: 1,
};

export function SqlEditor(props: SqlEditorProps) {
  const {
    value,
    onChange,
    onValidate,
    schema,
    dialect = 'postgresql',
    aiEnabled = false,
    height = '100%',
  } = props;

  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof import('monaco-editor') | null>(null);

  const runValidation = async () => {
    const ed = editorRef.current;
    if (!ed) return;
    const sql = ed.getValue();

    let report = validateSQL({ sql, schema, dialect });
    onValidate(report);

    applyMarkers(report);

    if (aiEnabled && (report.errors.length > 0 || report.warnings.length > 0)) {
      const enriched = await enrichWithAIExplanations(report, sql, schema);
      onValidate(enriched);
    }
  };

  const applyMarkers = (report: ValidationReport) => {
    const ed = editorRef.current;
    const monaco = monacoRef.current;
    if (!ed || !monaco) return;

    const model = ed.getModel();
    if (!model) return;

    const issues = [...report.errors, ...report.warnings, ...report.suggestions];
    const markers: editor.IMarkerData[] = issues.map((issue) => ({
      severity: SEVERITY_TO_MARKER[issue.severity],
      message: issue.title + (issue.description ? `\n${issue.description}` : ''),
      startLineNumber: issue.lineStart ?? 1,
      startColumn: issue.columnStart ?? 1,
      endLineNumber: issue.lineEnd ?? issue.lineStart ?? model.getLineCount(),
      endColumn: issue.columnEnd ?? model.getLineMaxColumn(issue.lineEnd ?? model.getLineCount()),
    }));

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
      const ed = editorRef.current;
      const monaco = monacoRef.current;
      const model = ed?.getModel();
      if (monaco && model) monaco.editor.setModelMarkers(model, 'safesql', []);
    };
  }, []);

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
