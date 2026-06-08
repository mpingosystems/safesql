import { buildSlackPayload, deliverWebhook } from '../../../src/services/webhooks';
import type { ValidationReport } from '../../../src/types/validation';

// POST /api/webhook/notify — sends a SafeSQL alert to a Slack webhook URL.
// Used by the Settings "Test" button (the caller supplies their own webhook_url),
// and reusable by the validate flow for real alerts. CORS-open for the test UI.

const cors: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export const onRequestOptions = (): Response => new Response(null, { status: 204, headers: cors });

const SAMPLE: ValidationReport = {
  riskScore: 25,
  executionSafe: false,
  errors: [
    {
      id: 'HALLUCINATED_COLUMN',
      severity: 'error',
      title: 'Column not found',
      description: 'Column `lifetime_value` does not exist on table `users`.',
      fix: 'Remove the column or add it to the schema.',
    },
  ],
  warnings: [],
  suggestions: [],
  processingMs: 12,
  source: 'cursor',
};

export const onRequestPost = async (context: { request: Request }): Promise<Response> => {
  let body: { webhook_url?: string; report?: ValidationReport; source?: string; dialect?: string; permalink_url?: string };
  try {
    body = (await context.request.json()) as typeof body;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { 'content-type': 'application/json', ...cors } });
  }
  if (!body.webhook_url) {
    return new Response(JSON.stringify({ error: 'webhook_url is required' }), { status: 400, headers: { 'content-type': 'application/json', ...cors } });
  }

  const payload = buildSlackPayload(body.report ?? SAMPLE, {
    source: body.source,
    dialect: body.dialect ?? 'postgresql',
    permalinkUrl: body.permalink_url,
  });
  const httpStatus = await deliverWebhook(body.webhook_url, payload);
  const ok = httpStatus >= 200 && httpStatus < 300;

  return new Response(JSON.stringify({ status: ok ? 'delivered' : 'failed', http_status: httpStatus }), {
    status: ok ? 200 : 502,
    headers: { 'content-type': 'application/json', ...cors },
  });
};
