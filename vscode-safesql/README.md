# SafeSQL for VS Code

Pre-execution SQL validation, right in the editor. On save (or via the command),
SafeSQL validates the active `.sql` file through the SafeSQL REST API and shows
red/amber squiggles on the offending clause — before the query ever runs.

## Setup

1. Get an API key at https://safesqlpro.dev/settings (Pro+).
2. Set it in VS Code settings: `safesql.apiKey`.
3. Optionally set `safesql.dialect`, `safesql.schemaFile`, `safesql.validateOnSave`.

## Build the .vsix

```bash
cd vscode-safesql
npm install
npm run compile
npm run package      # → vscode-safesql-0.1.0.vsix
```

Install locally:

```bash
code --install-extension vscode-safesql-0.1.0.vsix
```

Publish (requires a publisher account):

```bash
npx @vscode/vsce publish
```

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `safesql.apiKey`        | —            | SafeSQL API key |
| `safesql.dialect`       | `postgresql` | SQL dialect |
| `safesql.schemaFile`    | —            | DDL schema file (relative to workspace root) |
| `safesql.validateOnSave`| `true`       | Validate on save |

> Requires the SafeSQL REST API (Sprint 7 Part 3) deployed at safesqlpro.dev.
