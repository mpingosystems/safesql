import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from './supabaseClient';
import type { ValidationReport } from '../types/validation';

// Sprint 8 Part 3 — manager approval workflow. DB ops take an injectable Supabase
// client so they're unit-testable with a fake; needsApproval is pure.

export function needsApproval(score: number, threshold = 70): boolean {
  return score < threshold;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface ApprovalRow {
  id: string;
  team_id: string;
  requester_id: string;
  approver_id: string | null;
  sql: string;
  risk_score: number;
  status: ApprovalStatus;
  requester_note: string | null;
  approver_note: string | null;
  created_at: string;
  resolved_at: string | null;
  // The full ValidationReport captured at request time (used by the inbox to
  // expand the "View full report" panel without re-running validation).
  validation_report?: ValidationReport | null;
}

export interface CreateApprovalInput {
  teamId: string;
  requesterId: string;
  sql: string;
  ddl?: string;
  dialect?: string;
  report: ValidationReport;
  note?: string;
}

export async function createApprovalRequest(
  input: CreateApprovalInput,
  client: SupabaseClient | null = getSupabase(),
): Promise<{ id: string } | null> {
  if (!client || !input.sql) return null;
  const { data, error } = await client
    .from('approval_requests')
    .insert({
      team_id: input.teamId,
      requester_id: input.requesterId,
      sql: input.sql,
      ddl: input.ddl ?? null,
      dialect: input.dialect ?? 'postgresql',
      validation_report: input.report,
      risk_score: input.report.riskScore,
      status: 'pending',
      requester_note: input.note ?? null,
    })
    .select('id')
    .single();
  if (error || !data) return null;
  return { id: (data as { id: string }).id };
}

async function resolve(
  id: string,
  status: 'approved' | 'rejected',
  note: string | undefined,
  client: SupabaseClient | null,
): Promise<boolean> {
  if (!client) return false;
  const { error } = await client
    .from('approval_requests')
    .update({ status, approver_note: note ?? null, resolved_at: new Date().toISOString() })
    .eq('id', id);
  return !error;
}

export function approveRequest(id: string, note?: string, client: SupabaseClient | null = getSupabase()): Promise<boolean> {
  return resolve(id, 'approved', note, client);
}

export function rejectRequest(id: string, note?: string, client: SupabaseClient | null = getSupabase()): Promise<boolean> {
  return resolve(id, 'rejected', note, client);
}

export async function getPendingRequests(
  teamId: string,
  client: SupabaseClient | null = getSupabase(),
): Promise<ApprovalRow[]> {
  if (!client) return [];
  const { data } = await client
    .from('approval_requests')
    .select('*')
    .eq('team_id', teamId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  return (data as ApprovalRow[]) ?? [];
}

// Resolved (approved/rejected) requests for the History tab, newest first.
export async function getResolvedRequests(
  teamId: string,
  client: SupabaseClient | null = getSupabase(),
): Promise<ApprovalRow[]> {
  if (!client) return [];
  const { data } = await client
    .from('approval_requests')
    .select('*')
    .eq('team_id', teamId)
    .in('status', ['approved', 'rejected'])
    .order('resolved_at', { ascending: false });
  return (data as ApprovalRow[]) ?? [];
}
