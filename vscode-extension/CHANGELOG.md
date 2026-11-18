# Change Log

## 0.1.1 — November 2026

Maintenance release. No change to settings or behaviour.

- Built on the published [`@safesqlpro/sdk`](https://www.npmjs.com/package/@safesqlpro/sdk) 0.2.0.
- Published from CI to the VS Code Marketplace and, for the first time, to
  [Open VSX](https://open-vsx.org) (for VSCodium, Cursor and other
  Open VSX-based editors).

## 0.1.0 — August 2026

Initial release.

- Validate `.sql` files on save (`safesql.validateOnSave`) or on demand via
  **SafeSQL Pro: Validate Current File**.
- Inline diagnostics — squiggly lines anchored on the offending column, table
  or clause, with the issue type, message, fix and score impact on hover.
- Status bar score, e.g. `SafeSQL: 25 CRITICAL`, coloured when below threshold.
- Settings: `apiKey`, `threshold`, `dialect`, `validateOnSave`, `schemaFile`,
  `baseUrl`.
- Friendly one-time prompt (with **Open Settings** / **Get an API key**) instead
  of an error when no API key is configured.

Detection runs server-side through [`@safesqlpro/sdk`](https://www.npmjs.com/package/@safesqlpro/sdk).

### Planned

- `0.2.0` — quick-fix code actions
- `0.3.0` — synthetic proof runner panel
