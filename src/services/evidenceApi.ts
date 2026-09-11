// Sprint 9 (compliance tier) — browser client for the evidence bundle API.
// Uses apiUrl() (the pages.dev routing) because bundle generation makes
// outbound subrequests, which the custom-domain edge 502s on POST. Never throws.

import { apiUrl } from '../config/api';
import { getClerkToken } from './supabaseClient';

export interface EvidenceApiDeps {
  fetch?: typeof fetch;
  getToken?: () => Promise<string | null>;
}

export interface EvidenceBundleRow {
  id: string;
  team_id: string;
  period_from: string;
  period_to: string;
  chain_from_seq: number;
  chain_to_seq: number;
  chain_head_hash: string;
  event_count: number;
  validation_count: number;
  approval_count: number;
  bundle_hash: string;
  signature: string;
  signing_key_version: number;
  generated_by: string;
  generated_by_role: string;
  generated_by_email: string | null;
  format_version: number;
  created_at: string;
}

export interface BundleList {
  team_id: string;
  my_role: string;
  can_generate: boolean;
  rows: EvidenceBundleRow[];
  next_cursor: string | null;
  signing_key: { version: number; fingerprint: string } | null;
}

export interface BundleVerification {
  bundle_id: string;
  ok: boolean;
  bundle_hash: { stored: string; recomputed: string; matches: boolean };
  signature: { valid: boolean | null; key_version: number; key_fingerprint: string | null; key_active: boolean | null };
  chain: { db: { ok: boolean; checked: number }; local: { ok: boolean; checked: number }; agree: boolean };
  event_count: { stored: number; recomputed: number };
  checked_at: string;
}

type Fail = { ok: false; status: number; error: string };

async function call(path: string, init: RequestInit, deps: EvidenceApiDeps): Promise<Response | null> {
  const token = await (deps.getToken ?? getClerkToken)();
  if (!token) return null;
  return (deps.fetch ?? fetch)(apiUrl(path), {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) },
  });
}
const readJson = async (res: Response) => (await res.json().catch(() => ({}))) as Record<string, unknown>;

export async function listBundles(deps: EvidenceApiDeps = {}): Promise<BundleList | Fail> {
  try {
    const res = await call('/api/teams/evidence/bundles', { method: 'GET' }, deps);
    if (!res) return { ok: false, status: 401, error: 'Sign in to view evidence bundles' };
    const body = await readJson(res);
    if (!res.ok) return { ok: false, status: res.status, error: String(body.error ?? `HTTP ${res.status}`) };
    return body as unknown as BundleList;
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message };
  }
}

export async function generateBundle(
  periodFrom: string,
  periodTo: string,
  deps: EvidenceApiDeps = {},
): Promise<{ ok: true; bundle: EvidenceBundleRow; event_seq: number | null } | Fail> {
  try {
    const res = await call('/api/teams/evidence/bundle', { method: 'POST', body: JSON.stringify({ period_from: periodFrom, period_to: periodTo }) }, deps);
    if (!res) return { ok: false, status: 401, error: 'Sign in to generate evidence bundles' };
    const body = await readJson(res);
    if (!res.ok) return { ok: false, status: res.status, error: String(body.error ?? `HTTP ${res.status}`) };
    return { ok: true, bundle: body.bundle as EvidenceBundleRow, event_seq: typeof body.event_seq === 'number' ? body.event_seq : null };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message };
  }
}

export async function verifyBundle(id: string, deps: EvidenceApiDeps = {}): Promise<BundleVerification | Fail> {
  try {
    const res = await call(`/api/teams/evidence/bundle/${encodeURIComponent(id)}/verify`, { method: 'GET' }, deps);
    if (!res) return { ok: false, status: 401, error: 'Sign in to verify evidence bundles' };
    const body = await readJson(res);
    if (!res.ok) return { ok: false, status: res.status, error: String(body.error ?? `HTTP ${res.status}`) };
    return body as unknown as BundleVerification;
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message };
  }
}

/** Fetch the zip as bytes (the route needs the Clerk header, so a plain <a href> cannot be used). */
export async function downloadBundle(
  id: string,
  deps: EvidenceApiDeps = {},
): Promise<{ ok: true; bytes: Uint8Array; filename: string } | Fail> {
  try {
    const res = await call(`/api/teams/evidence/bundle/${encodeURIComponent(id)}/download`, { method: 'GET' }, deps);
    if (!res) return { ok: false, status: 401, error: 'Sign in to download evidence bundles' };
    if (!res.ok) {
      const body = await readJson(res);
      return { ok: false, status: res.status, error: String(body.error ?? `HTTP ${res.status}`) };
    }
    const disposition = res.headers.get('content-disposition') ?? '';
    const m = /filename="([^"]+)"/.exec(disposition);
    return { ok: true, bytes: new Uint8Array(await res.arrayBuffer()), filename: m?.[1] ?? `safesql-evidence-${id.slice(0, 8)}.zip` };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message };
  }
}

/** Hand the bytes to the browser as a file download. No-op outside a DOM. */
export function saveBytes(bytes: Uint8Array, filename: string): void {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/zip' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
