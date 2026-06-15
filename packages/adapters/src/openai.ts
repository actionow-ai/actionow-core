import type { SubmitInput, SubmitResult, UnifiedError, UsageVector } from '@actionow/contracts';

import { AdapterError, httpStatusToUnified } from './errors.js';
import { asArray, asNumber, asRecord, asString } from './internal/json.js';
import type { ProviderAdapter } from './types.js';

const PROVIDER = 'openai';
const DEFAULT_ENDPOINT = 'https://api.openai.com/v1';

interface ChatMessage {
  role: string;
  content: string;
}

/**
 * Resolve the chat `messages[]` from the unified inputs.
 *
 * Accepts a literal `messages` array of `{role, content}`, OR a `prompt`/`input`
 * string that is wrapped as a single `user` turn. Throws `invalid_input` when
 * neither is supplied.
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
    message: 'openai inputs require a "messages" array or a "prompt"/"input" string',
    upstream: { provider: PROVIDER },
    retryable: false,
  });
}

/** Extract `{input_tokens, output_tokens}` from an OpenAI `usage` block. */
function extractUsage(raw: unknown): UsageVector {
  const usage = asRecord(asRecord(raw)?.usage);
  return {
    input_tokens: asNumber(usage?.prompt_tokens) ?? 0,
    output_tokens: asNumber(usage?.completion_tokens) ?? 0,
  };
}

/** Map an OpenAI error body to a {@link UnifiedError}. Falls back by status. */
function mapErrorBody(status: number, raw: unknown): UnifiedError {
  const error = asRecord(asRecord(raw)?.error);
  const rawCode = asString(error?.code) ?? asString(error?.type);
  return httpStatusToUnified(PROVIDER, status, rawCode);
}

export const openaiAdapter: ProviderAdapter = {
  providerType: PROVIDER,

  async submit(input: SubmitInput): Promise<SubmitResult> {
    const { ctx, inputs } = input;
    const messages = buildMessages(inputs);
    const endpoint = ctx.endpoint ?? DEFAULT_ENDPOINT;

    const body: Record<string, unknown> = {
      model: ctx.model,
      messages,
    };
    const maxTokens = asNumber(inputs.max_tokens);
    if (maxTokens !== undefined) {
      body.max_tokens = maxTokens;
    }

    const res = await ctx.http.request({
      method: 'POST',
      url: `${endpoint}/chat/completions`,
      headers: { Authorization: `Bearer ${ctx.apiKey ?? ''}` },
      body,
    });

    if (!res.ok) {
      throw new AdapterError(mapErrorBody(res.status, res.body));
    }

    const choice = asRecord(asArray(asRecord(res.body)?.choices)?.[0]);
    const text = asString(asRecord(choice?.message)?.content);
    if (text === undefined) {
      throw new AdapterError({
        code: 'upstream_error',
        message: 'openai response did not contain choices[0].message.content',
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
