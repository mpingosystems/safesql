import type { SqlSource, ValidationReport } from '../types/validation';

// PQ5 — shareable validation permalink. The full result (SQL, DDL, dialect,
// issues, score) is encoded into the URL hash, so a link is fully reproducible
// with no backend or auth required: anyone who opens it sees the same report.
export interface SharePayload {
  v: 1;
  sql: string;
  ddl?: string;
  dialect: string;
  source?: SqlSource;
  report: ValidationReport;
}

// UTF-8 safe base64url. btoa() only handles Latin-1, so we round-trip through
// encodeURIComponent first to survive non-ASCII SQL/identifiers.
function toBase64Url(str: string): string {
  const b64 = btoa(unescape(encodeURIComponent(str)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(b64url: string): string {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  return decodeURIComponent(escape(atob(b64)));
}

export function encodeSharePayload(payload: SharePayload): string {
  return toBase64Url(JSON.stringify(payload));
}

export function decodeSharePayload(encoded: string): SharePayload | null {
  try {
    const parsed = JSON.parse(fromBase64Url(encoded));
    if (parsed && parsed.v === 1 && typeof parsed.sql === 'string' && parsed.report) {
      return parsed as SharePayload;
    }
    return null;
  } catch {
    return null;
  }
}

// Build the full shareable URL for the current origin.
export function buildShareUrl(payload: SharePayload): string {
  const origin =
    typeof window !== 'undefined' && window.location ? window.location.origin : 'https://safesql.realitydb.dev';
  return `${origin}/#/v/${encodeSharePayload(payload)}`;
}

// Pull the encoded payload out of a hash route like `#/v/<encoded>`.
export function shareTokenFromHash(hash: string): string | null {
  const m = /#\/v\/([^?&]+)/.exec(hash);
  return m ? m[1] : null;
}
