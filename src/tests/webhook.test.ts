import { describe, expect, it } from 'vitest';
import { buildSlackPayload, shouldFireWebhook, type WebhookConfig } from '../services/webhooks';
import type { ValidationReport } from '../types/validation';

function report(errors: string[], warnings: string[], score = 25): ValidationReport {
  return {
    riskScore: score,
    executionSafe: errors.length === 0,
    errors: errors.map((id) => ({ id, severity: 'error', title: id, description: `${id} desc`, fix: 'do x' })) as never,
    warnings: warnings.map((id) => ({ id, severity: 'warning', title: id, description: `${id} desc`, fix: 'do y' })) as never,
    suggestions: [],
    processingMs: 1,
    source: 'cursor',
  };
}

const errorOnly: WebhookConfig = { webhook_url: 'https://hooks.slack.com/x', trigger_on: ['error'], active: true };
const all: WebhookConfig = { webhook_url: 'https://hooks.slack.com/x', trigger_on: ['all'], active: true };

describe('buildSlackPayload', () => {
  it('produces header + fields + error section + permalink button', () => {
    const p = buildSlackPayload(report(['HALLUCINATED_COLUMN'], []), {
      dialect: 'postgresql',
      permalinkUrl: 'https://safesqlpro.dev/v/abc123def456',
    });
    expect(Array.isArray(p.blocks)).toBe(true);
    const types = (p.blocks as { type: string }[]).map((b) => b.type);
    expect(types).toEqual(['header', 'section', 'section', 'actions']);
    const header = p.blocks[0] as { text: { text: string } };
    expect(header.text.text).toMatch(/SafeSQL caught a risky query/);
    const action = p.blocks[3] as { elements: { url: string }[] };
    expect(action.elements[0].url).toMatch(/\/v\/abc123def456/);
  });

  it('omits the actions block when no permalink', () => {
    const p = buildSlackPayload(report(['CARTESIAN_JOIN'], []));
    expect((p.blocks as { type: string }[]).some((b) => b.type === 'actions')).toBe(false);
  });
});

describe('shouldFireWebhook', () => {
  it('error-only config does NOT fire on a warning-only result', () => {
    expect(shouldFireWebhook(errorOnly, report([], ['JOIN_MULTIPLICATION']))).toBe(false);
  });
  it('error-only config fires on an error result', () => {
    expect(shouldFireWebhook(errorOnly, report(['CARTESIAN_JOIN'], []))).toBe(true);
  });
  it('all config fires even on a clean result', () => {
    expect(shouldFireWebhook(all, report([], [], 100))).toBe(true);
  });
  it('warning config fires on warning-only', () => {
    const warn: WebhookConfig = { webhook_url: 'x', trigger_on: ['warning'], active: true };
    expect(shouldFireWebhook(warn, report([], ['JOIN_MULTIPLICATION']))).toBe(true);
  });
  it('inactive config never fires', () => {
    expect(shouldFireWebhook({ ...all, active: false }, report(['CARTESIAN_JOIN'], []))).toBe(false);
  });
});
