import type { SubmitInput, SubmitResult, UnifiedError, UsageVector } from '@actionow/contracts';

import { AdapterError, httpStatusToUnified } from './errors.js';
import { asArray, asNumber, asRecord, asString } from './internal/json.js';
import type { ProviderAdapter } from './types.js';

const PROVIDER = 'anthropic';
const DEFAULT_ENDPOINT = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 1024;

interface ChatMessage {
  role: string;
  content: string;
}

/**
 * Resolve the `messages[]` from unified inputs. Accepts a literal `messages`
 * array, OR a `prompt`/`input` string wrapped as a single `user` turn. Throws
 * `invalid_input` when neither is supplied.
 */
function buildMessages(inputs: Record<string, unknown>): ChatMessage[] {
  const messages = asArray(inputs.messages);
  if (messages !== undefined) {
    return messages.map((m): ChatMessage => {
      const rec = asRecord(m);
      return {
        role: asString(rec?.role) ?? 'user',
        content: asString(rec?.content) ?? '',
      };
    });
  }

  const prompt = asString(inputs.prompt) ?? asString(inputs.input);
  if (prompt !== undefined) {
    return [{ role: 'user', content: prompt }];
  }

  throw new AdapterError({
    code: 'invalid_input',
    message: 'anthropic inputs require a "messages" array or a "prompt"/"input" string',
    upstream: { provider: PROVIDER },
    retryable: false,
  });
}

/** Extract `{input_tokens, output_tokens}` from an Anthropic `usage` block. */
function extractUsage(raw: unknown): UsageVector {
  const usage = asRecord(asRecord(raw)?.usage);
  return {
    input_tokens: asNumber(usage?.input_tokens) ?? 0,
    output_tokens: asNumber(usage?.output_tokens) ?? 0,
  };
}

/** Map an Anthropic error body to a {@link UnifiedError}. Falls back by status. */
function mapErrorBody(status: number, raw: unknown): UnifiedError {
  const error = asRecord(asRecord(raw)?.error);
  const rawCode = asString(error?.type);
  return httpStatusToUnified(PROVIDER, status, rawCode);
}

export const anthropicAdapter: ProviderAdapter = {
  providerType: PROVIDER,

  async submit(input: SubmitInput): Promise<SubmitResult> {
    const { ctx, inputs } = input;
    const messages = buildMessages(inputs);
    const endpoint = ctx.endpoint ?? DEFAULT_ENDPOINT;

    const body: Record<string, unknown> = {
      model: ctx.model,
      max_tokens: asNumber(inputs.max_tokens) ?? DEFAULT_MAX_TOKENS,
      messages,
    };
    const system = asString(inputs.system);
    if (system !== undefined) {
      body.system = system;
    }

    const res = await ctx.http.request({
      method: 'POST',
      url: `${endpoint}/v1/messages`,
      headers: {
        'x-api-key': ctx.apiKey ?? '',
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body,
    });

    if (!res.ok) {
      throw new AdapterError(mapErrorBody(res.status, res.body));
    }

    const block = asRecord(asArray(asRecord(res.body)?.content)?.[0]);
    const text = asString(block?.text);
    if (text === undefined) {
      throw new AdapterError({
        code: 'upstream_error',
        message: 'anthropic response did not contain content[0].text',
        upstream: { provider: PROVIDER },
        retryable: false,
      });
    }

    return { kind: 'sync', output: { text }, usage: extractUsage(res.body) };
  },

  extractUsage,

  mapError(raw: unknown): UnifiedError {
    return mapErrorBody(500, raw);
  },
};
