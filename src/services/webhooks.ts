import type { ValidationReport } from '../types/validation';
import { verdictFor } from './fileValidation';

// Sprint 8 Part 1 — Slack / webhook alerting. Pure builders + trigger filter so
// they're unit-testable; the notify Function (functions/api/webhook/notify.ts)
// reads webhook_configs and POSTs the payload.

export type TriggerOn = 'error' | 'warning' | 'all';

export interface WebhookConfig {
  webhook_url: string;
  webhook_type?: 'slack' | 'teams' | 'generic';
  trigger_on: TriggerOn[];
  min_severity?: 'error' | 'warning' | 'suggestion';
  active?: boolean;
}

// Should this config fire for this report?
export function shouldFireWebhook(config: WebhookConfig, report: ValidationReport): boolean {
  if (config.active === false) return false;
  const triggers = config.trigger_on ?? ['error'];
  if (triggers.includes('all')) return true;
  if (triggers.includes('error') && report.errors.length > 0) return true;
  if (triggers.includes('warning') && (report.errors.length > 0 || report.warnings.length > 0)) {
    return true;
  }
  return false;
}

const SOURCE_LABEL: Record<string, string> = {
  cursor: 'Cursor',
  copilot: 'Copilot',
  chatgpt: 'ChatGPT',
  manual: 'Hand-written',
  unknown: 'Unknown',
};

export interface SlackPayloadOpts {
  source?: string;
  dialect?: string;
  permalinkUrl?: string; // safesqlpro.dev/v/{id}
}

// Build a Slack Block Kit message for a validation result.
export function buildSlackPayload(report: ValidationReport, opts: SlackPayloadOpts = {}) {
  const verdict = verdictFor(report.riskScore);
  const top = report.errors[0] ?? report.warnings[0];

  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '⚠️ SafeSQL Pro caught a risky query' },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Score:* ${report.riskScore} — ${verdict}` },
        { type: 'mrkdwn', text: `*Source:* ${SOURCE_LABEL[opts.source ?? report.source ?? 'unknown'] ?? 'Unknown'}` },
        { type: 'mrkdwn', text: `*Issues:* ${report.errors.length} error${report.errors.length === 1 ? '' : 's'}, ${report.warnings.length} warning${report.warnings.length === 1 ? '' : 's'}` },
        { type: 'mrkdwn', text: `*Dialect:* ${opts.dialect ?? 'postgresql'}` },
      ],
    },
  ];

  if (top) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${top.severity === 'error' ? 'Error' : 'Warning'}:* \`${top.id}\` — ${top.description}\n*Fix:* ${top.fix ?? '—'}`,
      },
    });
  }

  if (opts.permalinkUrl) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'View validation →' },
          url: opts.permalinkUrl,
        },
      ],
    });
  }

  return { blocks };
}

// POST a payload to a webhook URL. Returns the HTTP status (0 on failure).
// Used by the notify Function and the Settings "Test" button.
export async function deliverWebhook(url: string, payload: unknown): Promise<number> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.status;
  } catch {
    return 0;
  }
}
