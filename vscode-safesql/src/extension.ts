import * as vscode from 'vscode';

// SafeSQL VS Code extension — validates the active SQL file via the SafeSQL REST
// API and shows inline squiggles. Calls POST /api/validate (Part 3) — no
// validator logic lives here.

const API_URL = 'https://safesqlpro.dev/api/validate';
const diagnosticCollection = vscode.languages.createDiagnosticCollection('safesql');

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(diagnosticCollection);

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const cfg = vscode.workspace.getConfiguration('safesql');
      if (doc.languageId === 'sql' && cfg.get<boolean>('validateOnSave', true)) {
        void validateDocument(doc);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('safesql.validate', () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) void validateDocument(editor.document);
    }),
  );
}

async function validateDocument(doc: vscode.TextDocument): Promise<void> {
  const config = vscode.workspace.getConfiguration('safesql');
  const apiKey = config.get<string>('apiKey');
  const dialect = config.get<string>('dialect') ?? 'postgresql';
  const schemaFile = config.get<string>('schemaFile');

  if (!apiKey) {
    vscode.window.showWarningMessage(
      'SafeSQL: Set your API key in settings (safesql.apiKey) to enable validation.',
    );
    return;
  }

  const sql = doc.getText();
  let ddl = '';
  if (schemaFile && vscode.workspace.workspaceFolders?.length) {
    const schemaPath = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, schemaFile);
    try {
      const schemaDoc = await vscode.workspace.openTextDocument(schemaPath);
      ddl = schemaDoc.getText();
    } catch {
      /* schema file not found — proceed without schema */
    }
  }

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, ddl, dialect }),
    });
    if (!res.ok) {
      vscode.window.showErrorMessage(`SafeSQL API error: ${res.status}`);
      return;
    }
    applyDiagnostics(doc, await res.json());
  } catch (err) {
    vscode.window.showErrorMessage(`SafeSQL: Network error — ${String(err)}`);
  }
}

interface Issue {
  id?: string;
  issueType?: string;
  severity?: string;
  description?: string;
  message?: string;
  fix?: string;
  offendingColumn?: string;
  offendingTable?: string;
  offendingClause?: string;
}

function applyDiagnostics(doc: vscode.TextDocument, report: { errors?: Issue[]; warnings?: Issue[] }): void {
  const diagnostics: vscode.Diagnostic[] = [];
  const allIssues = [...(report.errors ?? []), ...(report.warnings ?? [])];

  for (const issue of allIssues) {
    const token = issue.offendingColumn ?? issue.offendingTable ?? issue.offendingClause;
    const range = token ? findTokenRange(doc, token) : new vscode.Range(0, 0, 0, 1);
    const severity =
      issue.severity === 'error'
        ? vscode.DiagnosticSeverity.Error
        : vscode.DiagnosticSeverity.Warning;
    const msg = issue.message ?? issue.description ?? 'SafeSQL issue';
    const diagnostic = new vscode.Diagnostic(range, `[SafeSQL] ${msg}\n\nFix: ${issue.fix ?? ''}`, severity);
    diagnostic.source = 'SafeSQL';
    diagnostic.code = issue.issueType ?? issue.id;
    diagnostics.push(diagnostic);
  }

  diagnosticCollection.set(doc.uri, diagnostics);
}

function findTokenRange(doc: vscode.TextDocument, token: string): vscode.Range {
  const idx = doc.getText().toLowerCase().indexOf(token.toLowerCase());
  if (idx === -1) return new vscode.Range(0, 0, 0, 1);
  return new vscode.Range(doc.positionAt(idx), doc.positionAt(idx + token.length));
}

export function deactivate(): void {
  diagnosticCollection.dispose();
}
