import { error, type Env } from '../../_shared';

// Shared server-side Anthropic client for Layer 2 (explanation/assistance only;
// AI never makes a detection decision). Pure fetch(), no SDK, because Node SDKs
// crash the Workers runtime. The key lives only in env.ANTHROPIC_API_KEY, a Pages
// secret, and never reaches the browser bundle.
//
// Logging rule: status, latency and model only. Never request or response
// bodies, since they carry customer SQL and the model's output.

export const ANTHROPIC_MODEL = 'claude-sonnet-4-6';
export const ANTHROPIC_VERSION = '2023-06-01';
export const ANTHROPIC_TIMEOUT_MS = 30_000;
const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CallAnthropicOptions {
  system?: string;
  messages: AnthropicMessage[];
  maxTokens: number;
  model?: string;
  timeoutMs?: number;
}

export type AnthropicFailure = 'not_configured' | 'timeout' | 'rate_limited' | 'upstream_error' | 'unreachable';

export type AnthropicResult =
  | { ok: true; text: string }
  | { ok: false; reason: AnthropicFailure; status?: number };

function logCall(model: string, status: number | string, startedAt: number): void {
  console.log(JSON.stringify({ event: 'anthropic_call', model, status, latencyMs: Date.now() - startedAt }));
}

export async function callAnthropic(
  env: Pick<Env, 'ANTHROPIC_API_KEY'>,
  opts: CallAnthropicOptions,
): Promise<AnthropicResult> {
  if (!env.ANTHROPIC_API_KEY) return { ok: false, reason: 'not_configured' };

  const model = opts.model ?? ANTHROPIC_MODEL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? ANTHROPIC_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const res = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: opts.maxTokens,
        ...(opts.system ? { system: opts.system } : {}),
        messages: opts.messages,
      }),
      signal: controller.signal,
    });
    logCall(model, res.status, startedAt);

    if (!res.ok) {
      return { ok: false, reason: res.status === 429 ? 'rate_limited' : 'upstream_error', status: res.status };
    }
    const data = (await res.json()) as { content?: { type?: string; text?: string }[] };
    const text = (data.content ?? [])
      .filter((b) => typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
    return { ok: true, text };
  } catch (e) {
    const aborted = (e as { name?: string })?.name === 'AbortError';
    logCall(model, aborted ? 'timeout' : 'unreachable', startedAt);
    return { ok: false, reason: aborted ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

// Every Anthropic failure (missing key, timeout, 429, 5xx, other upstream
// errors) reaches the user as a readable 503. Never a 500, a stack, or the
// upstream body.
export function aiUnavailable(message: string): Response {
  return error(503, message);
}
