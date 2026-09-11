import * as vscode from 'vscode';
import { SafeSQLClient, type ValidationResult } from '@safesqlpro/sdk';
import type { SafeSQLConfig } from './config';

// Calls the SafeSQL Pro API through @safesqlpro/sdk. No validator logic lives
// in the extension — the 35-detector engine runs server-side.

/** Reads the configured DDL file relative to the document's workspace folder. */
export async function loadSchema(
  doc: vscode.TextDocument,
  schemaFile: string | undefined,
): Promise<string | undefined> {
  if (!schemaFile) return undefined;
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri) ?? vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  try {
    const uri = vscode.Uri.joinPath(folder.uri, schemaFile);
    const bytes = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder().decode(bytes);
  } catch {
    // Schema file missing — validate without it rather than failing the run.
    return undefined;
  }
}

export async function validateDocument(
  doc: vscode.TextDocument,
  config: SafeSQLConfig,
): Promise<ValidationResult> {
  const client = new SafeSQLClient({ apiKey: config.apiKey, baseUrl: config.baseUrl });
  const ddl = await loadSchema(doc, config.schemaFile);
  return client.validate({
    sql: doc.getText(),
    ddl,
    dialect: config.dialect,
    threshold: config.threshold,
  });
}
