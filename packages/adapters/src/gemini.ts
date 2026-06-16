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

const PROVIDER = 'gemini';
const DEFAULT_ENDPOINT = 'https://generativelanguage.googleapis.com';

/** Spread `proxyUrl` into a request when the channel set one. */
function withProxy(ctx: AdapterContext): { proxyUrl?: string } {
  return ctx.proxyUrl === undefined ? {} : { proxyUrl: ctx.proxyUrl };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: { text: string }[];
}

/** Map a unified chat role to a Gemini content role (`assistant` → `model`). */
function toGeminiRole(role: string | undefined): 'user' | 'model' {
  return role === 'model' || role === 'assistant' ? 'model' : 'user';
}

/**
 * Build Gemini `contents[]` from unified inputs. Accepts a literal `messages`
 * array (mapped role+content → role+parts), OR a `prompt`/`input` string. Throws
 * `invalid_input` when neither is supplied.
 */
function buildContents(inputs: Record<string, unknown>): GeminiContent[] {
  const messages = asArray(inputs.messages);
  if (messages !== undefined) {
    return messages.map((m): GeminiContent => {
      const rec = asRecord(m);
      return {
        role: toGeminiRole(asString(rec?.role)),
        parts: [{ text: asString(rec?.content) ?? '' }],
      };
    });
  }

  const prompt = asString(inputs.prompt) ?? asString(inputs.input);
  if (prompt !== undefined) {
    return [{ role: 'user', parts: [{ text: prompt }] }];
  }

  throw new AdapterError({
    code: 'invalid_input',
    message: 'gemini inputs require a "messages" array or a "prompt"/"input" string',
    upstream: { provider: PROVIDER },
    retryable: false,
  });
}

/** Extract `{input_tokens, output_tokens}` from `usageMetadata`. */
function extractUsage(raw: unknown): UsageVector {
  const meta = asRecord(asRecord(raw)?.usageMetadata);
  return {
    input_tokens: asNumber(meta?.promptTokenCount) ?? 0,
    output_tokens: asNumber(meta?.candidatesTokenCount) ?? 0,
  };
}

/** Map a Gemini error body to a {@link UnifiedError}. Falls back by status. */
function mapErrorBody(status: number, raw: unknown): UnifiedError {
  const error = asRecord(asRecord(raw)?.error);
  const rawCode = asString(error?.status);
  return httpStatusToUnified(PROVIDER, status, rawCode);
}

export const geminiAdapter: ProviderAdapter = {
  providerType: PROVIDER,

  async submit(input: SubmitInput): Promise<SubmitResult> {
    const { ctx, inputs } = input;
    const contents = buildContents(inputs);
    const endpoint = ctx.endpoint ?? DEFAULT_ENDPOINT;
    const key = encodeURIComponent(ctx.apiKey ?? '');

    const res = await ctx.http.request({
      method: 'POST',
      url: `${endpoint}/v1beta/models/${ctx.model ?? ''}:generateContent?key=${key}`,
      body: { contents },
      ...withProxy(ctx),
    });

    if (!res.ok) {
      throw new AdapterError(mapErrorBody(res.status, res.body));
    }

    const candidate = asRecord(asArray(asRecord(res.body)?.candidates)?.[0]);
    const part = asRecord(asArray(asRecord(candidate?.content)?.parts)?.[0]);
    const text = asString(part?.text);
    if (text === undefined) {
      throw new AdapterError({
        code: 'upstream_error',
        message: 'gemini response did not contain candidates[0].content.parts[0].text',
        upstream: { provider: PROVIDER },
        retryable: false,
      });
    }

    return { kind: 'sync', output: { text }, usage: extractUsage(res.body) };
  },

  async *stream(input: SubmitInput, ctx: AdapterContext): AsyncIterable<StreamEvent> {
    const contents = buildContents(input.inputs);
    const endpoint = ctx.endpoint ?? DEFAULT_ENDPOINT;
    const key = encodeURIComponent(ctx.apiKey ?? '');

    const res = await openStream(ctx, PROVIDER, {
      method: 'POST',
      url: `${endpoint}/v1beta/models/${ctx.model ?? ''}:streamGenerateContent?alt=sse&key=${key}`,
      body: { contents },
      ...withProxy(ctx),
    });

    if (!res.ok) {
      yield streamErrorEvent(PROVIDER, res.status);
      return;
    }

    // Each chunk may carry usageMetadata; the latest seen is the final usage.
    let usage: UsageVector = { input_tokens: 0, output_tokens: 0 };

    for await (const frame of parseSse(res.lines)) {
      const obj = parseJsonRecord(frame.data);
      if (obj === undefined) {
        continue;
      }

      const meta = asRecord(obj.usageMetadata);
      if (meta !== undefined) {
        usage = {
          input_tokens: asNumber(meta.promptTokenCount) ?? 0,
          output_tokens: asNumber(meta.candidatesTokenCount) ?? 0,
        };
      }

      const candidate = asRecord(asArray(obj.candidates)?.[0]);
      const part = asRecord(asArray(asRecord(candidate?.content)?.parts)?.[0]);
      const text = asString(part?.text);
      if (text !== undefined && text.length > 0) {
        yield { kind: 'delta', text };
      }
    }

    yield { kind: 'usage', usage };
    yield { kind: 'done', usage };
  },

  extractUsage,

  mapError(raw: unknown): UnifiedError {
    return mapErrorBody(500, raw);
  },
};
