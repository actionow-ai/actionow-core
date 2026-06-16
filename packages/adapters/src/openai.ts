import type {
  AdapterContext,
  StreamEvent,
  SubmitInput,
  SubmitResult,
  UnifiedError,
  UsageVector,
} from '@actionow/contracts';

import { AdapterError, httpStatusToUnified } from './errors.js';
import { asArray, asNumber, asRecord, asString, parseJsonRecord } from './internal/json.js';
import { parseSse } from './internal/sse.js';
import { openStream, streamErrorEvent } from './internal/stream.js';
import type { ProviderAdapter } from './types.js';

const PROVIDER = 'openai';
const DEFAULT_ENDPOINT = 'https://api.openai.com/v1';

/** Spread `proxyUrl` into a request when the channel set one. */
function withProxy(ctx: AdapterContext): { proxyUrl?: string } {
  return ctx.proxyUrl === undefined ? {} : { proxyUrl: ctx.proxyUrl };
}

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
      ...withProxy(ctx),
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

  async *stream(input: SubmitInput, ctx: AdapterContext): AsyncIterable<StreamEvent> {
    const messages = buildMessages(input.inputs);
    const endpoint = ctx.endpoint ?? DEFAULT_ENDPOINT;

    const body: Record<string, unknown> = {
      model: ctx.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    const maxTokens = asNumber(input.inputs.max_tokens);
    if (maxTokens !== undefined) {
      body.max_tokens = maxTokens;
    }

    const res = await openStream(ctx, PROVIDER, {
      method: 'POST',
      url: `${endpoint}/chat/completions`,
      headers: { Authorization: `Bearer ${ctx.apiKey ?? ''}` },
      body,
      ...withProxy(ctx),
    });

    if (!res.ok) {
      yield streamErrorEvent(PROVIDER, res.status);
      return;
    }

    // Default usage to zero so a `done` event is always emitted with a vector.
    let usage: UsageVector = { input_tokens: 0, output_tokens: 0 };

    for await (const frame of parseSse(res.lines)) {
      const data = frame.data;
      if (data === '[DONE]') {
        break;
      }
      const obj = parseJsonRecord(data);
      if (obj === undefined) {
        continue;
      }

      // A trailing chunk carries usage with an empty `choices` array.
      const chunkUsage = asRecord(obj.usage);
      if (chunkUsage !== undefined) {
        usage = {
          input_tokens: asNumber(chunkUsage.prompt_tokens) ?? 0,
          output_tokens: asNumber(chunkUsage.completion_tokens) ?? 0,
        };
        yield { kind: 'usage', usage };
      }

      const choice = asRecord(asArray(obj.choices)?.[0]);
      const text = asString(asRecord(choice?.delta)?.content);
      if (text !== undefined && text.length > 0) {
        yield { kind: 'delta', text };
      }
    }

    yield { kind: 'done', usage };
  },

  extractUsage,

  mapError(raw: unknown): UnifiedError {
    return mapErrorBody(500, raw);
  },
};
