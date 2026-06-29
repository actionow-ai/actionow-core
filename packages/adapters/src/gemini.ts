import type {
  AdapterContext,
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  ContentPart,
  Message,
  ProviderModel,
  StopReason,
  StreamEvent,
  SubmitInput,
  SubmitResult,
  ToolCall,
  UnifiedError,
  UsageVector,
} from '@actionow/contracts';
import { vectorToChatUsage } from '@actionow/contracts';

import { AdapterError, httpStatusToUnified } from './errors.js';
import { asArray, asNumber, asRecord, asString, parseJsonRecord } from './internal/json.js';
import { parseSse } from './internal/sse.js';
import { openStream, streamErrorEvent } from './internal/stream.js';
import type { AdapterCapabilities, ProviderAdapter } from './types.js';

const PROVIDER = 'gemini';
const DEFAULT_ENDPOINT = 'https://generativelanguage.googleapis.com';

/** Spread `proxyUrl` into a request when the channel set one. */
function withProxy(ctx: AdapterContext): { proxyUrl?: string } {
  return ctx.proxyUrl === undefined ? {} : { proxyUrl: ctx.proxyUrl };
}

const CAPABILITIES: AdapterCapabilities = {
  tools: true,
  vision: true,
  audio: true,
  json: true,
  stream: true,
};

/** Map an IR content part to a Gemini part. */
function irPartToGeminiPart(part: ContentPart): Record<string, unknown> {
  if (part.kind === 'text') {
    return { text: part.text };
  }
  // image/audio/file → inlineData (base64) when available; otherwise a text passthrough.
  if (part.source === 'base64') {
    return { inlineData: { mimeType: part.mime ?? 'application/octet-stream', data: part.data } };
  }
  if (part.source === 'url') {
    return { fileData: { mimeType: part.mime ?? 'application/octet-stream', fileUri: part.data } };
  }
  return { text: part.data };
}

/** Build a Gemini `contents[]` entry for one IR (non-system) message. */
function irMessageToContent(msg: Message): Record<string, unknown> {
  const role = msg.role === 'assistant' || msg.role === 'tool' ? 'model' : 'user';
  if (msg.role === 'tool') {
    return {
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: msg.name ?? msg.toolCallId ?? '',
            response: { content: msg.content.map(irPartToGeminiPart) },
          },
        },
      ],
    };
  }
  const parts: Record<string, unknown>[] = msg.content.map(irPartToGeminiPart);
  if (msg.toolCalls !== undefined) {
    for (const call of msg.toolCalls) {
      parts.push({ functionCall: { name: call.name, args: call.arguments } });
    }
  }
  return { role, parts };
}

/** Translate an IR `ChatRequest` into a Gemini generateContent body. */
function buildChatBody(ir: ChatRequest): Record<string, unknown> {
  const systemParts: Record<string, unknown>[] = [];
  const contents: Record<string, unknown>[] = [];
  for (const m of ir.messages) {
    if (m.role === 'system') {
      for (const p of m.content) {
        systemParts.push(irPartToGeminiPart(p));
      }
    } else {
      contents.push(irMessageToContent(m));
    }
  }

  const body: Record<string, unknown> = { contents };
  if (systemParts.length > 0) {
    body.systemInstruction = { parts: systemParts };
  }
  if (ir.tools !== undefined && ir.tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: ir.tools.map((t) => {
          const decl: Record<string, unknown> = { name: t.name, parameters: t.parameters };
          if (t.description !== undefined) {
            decl.description = t.description;
          }
          return decl;
        }),
      },
    ];
  }
  const params = ir.params;
  if (params !== undefined) {
    const gen: Record<string, unknown> = {};
    if (params.temperature !== undefined) {
      gen.temperature = params.temperature;
    }
    if (params.topP !== undefined) {
      gen.topP = params.topP;
    }
    if (params.maxOutputTokens !== undefined) {
      gen.maxOutputTokens = params.maxOutputTokens;
    }
    if (params.stop !== undefined) {
      gen.stopSequences = params.stop;
    }
    if (params.responseFormat === 'json_object' || params.responseFormat === 'json_schema') {
      gen.responseMimeType = 'application/json';
    }
    if (Object.keys(gen).length > 0) {
      body.generationConfig = gen;
    }
  }
  return body;
}

/** Map a Gemini `finishReason` to an IR {@link StopReason}. */
function mapFinishReason(raw: string | undefined): StopReason {
  switch (raw) {
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
      return 'content_filter';
    default:
      return 'stop';
  }
}

/** Parse a Gemini candidate's parts into IR content parts + tool calls. */
function parseCandidateParts(parts: unknown): { content: ContentPart[]; toolCalls: ToolCall[] } {
  const content: ContentPart[] = [];
  const toolCalls: ToolCall[] = [];
  for (const part of asArray(parts) ?? []) {
    const rec = asRecord(part);
    const text = asString(rec?.text);
    if (text !== undefined) {
      content.push({ kind: 'text', text });
      continue;
    }
    const fnCall = asRecord(rec?.functionCall);
    const name = asString(fnCall?.name);
    if (name !== undefined) {
      toolCalls.push({ id: name, name, arguments: asRecord(fnCall?.args) ?? {} });
    }
  }
  return { content, toolCalls };
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

/**
 * Fold Gemini's `usageMetadata` breakdown into the snake_case vector keys, ONLY
 * when reported: `thoughtsTokenCount` → reasoning;
 * `cachedContentTokenCount` → cachedInput. An absent field leaves the key unset
 * so the vector stays additive.
 */
function addGeminiBreakdown(vector: UsageVector, meta: Record<string, unknown> | undefined): void {
  const thoughts = asNumber(meta?.thoughtsTokenCount);
  if (thoughts !== undefined) vector.reasoning_tokens = thoughts;
  const cached = asNumber(meta?.cachedContentTokenCount);
  if (cached !== undefined) vector.cached_input_tokens = cached;
}

/** Extract `{input_tokens, output_tokens}` (+ thoughts/cache breakdown) from `usageMetadata`. */
function extractUsage(raw: unknown): UsageVector {
  const meta = asRecord(asRecord(raw)?.usageMetadata);
  const vector: UsageVector = {
    input_tokens: asNumber(meta?.promptTokenCount) ?? 0,
    output_tokens: asNumber(meta?.candidatesTokenCount) ?? 0,
  };
  addGeminiBreakdown(vector, meta);
  return vector;
}

/** Map a Gemini error body to a {@link UnifiedError}. Falls back by status. */
function mapErrorBody(status: number, raw: unknown): UnifiedError {
  const error = asRecord(asRecord(raw)?.error);
  const rawCode = asString(error?.status);
  return httpStatusToUnified(PROVIDER, status, rawCode);
}

export const geminiAdapter: ProviderAdapter = {
  providerType: PROVIDER,
  capabilities: CAPABILITIES,

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
        // Route through extractUsage so the breakdown rides into the vector.
        usage = extractUsage(obj);
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

  async chat(ir: ChatRequest, ctx: AdapterContext): Promise<ChatResponse> {
    const endpoint = ctx.endpoint ?? DEFAULT_ENDPOINT;
    const key = encodeURIComponent(ctx.apiKey ?? '');
    const model = ctx.model ?? ir.model;
    const body = buildChatBody(ir);

    const res = await ctx.http.request({
      method: 'POST',
      url: `${endpoint}/v1beta/models/${model}:generateContent?key=${key}`,
      body,
      ...withProxy(ctx),
    });

    if (!res.ok) {
      throw new AdapterError(mapErrorBody(res.status, res.body));
    }

    const candidate = asRecord(asArray(asRecord(res.body)?.candidates)?.[0]);
    const { content, toolCalls } = parseCandidateParts(asRecord(candidate?.content)?.parts);

    const irMessage: Message = { role: 'assistant', content };
    if (toolCalls.length > 0) {
      irMessage.toolCalls = toolCalls;
    }

    return {
      message: irMessage,
      stopReason: mapFinishReason(asString(candidate?.finishReason)),
      // camelCase IR usage from the snake_case vector (totals + thoughts/cache breakdown).
      usage: vectorToChatUsage(extractUsage(res.body)),
    };
  },

  async *streamChat(ir: ChatRequest, ctx: AdapterContext): AsyncIterable<ChatStreamEvent> {
    const endpoint = ctx.endpoint ?? DEFAULT_ENDPOINT;
    const key = encodeURIComponent(ctx.apiKey ?? '');
    const model = ctx.model ?? ir.model;
    const body = buildChatBody(ir);

    const res = await openStream(ctx, PROVIDER, {
      method: 'POST',
      url: `${endpoint}/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${key}`,
      body,
      ...withProxy(ctx),
    });

    if (!res.ok) {
      yield { type: 'error', error: httpStatusToUnified(PROVIDER, res.status) };
      return;
    }

    let started = false;
    // The latest full usage vector seen (totals + breakdown); mapped to IR usage below.
    let usage: UsageVector | undefined;
    let stopReason: StopReason = 'stop';
    // Stream-global tool-call counter: Gemini streams each functionCall in its
    // own SSE frame, so a per-frame index would reset to 0 and collide parallel
    // calls. Hoisted here so every functionCall across the whole stream gets a
    // distinct IR `tool_call_delta.index` (downstream renderers key on it).
    let toolIndex = 0;

    for await (const frame of parseSse(res.lines)) {
      const obj = parseJsonRecord(frame.data);
      if (obj === undefined) {
        continue;
      }

      if (!started) {
        started = true;
        yield { type: 'message_start' };
      }

      const candidate = asRecord(asArray(obj.candidates)?.[0]);
      const parts = asArray(asRecord(candidate?.content)?.parts) ?? [];
      for (const part of parts) {
        const rec = asRecord(part);
        const text = asString(rec?.text);
        if (text !== undefined && text.length > 0) {
          yield { type: 'content_delta', text };
          continue;
        }
        const fnCall = asRecord(rec?.functionCall);
        const name = asString(fnCall?.name);
        if (name !== undefined) {
          yield {
            type: 'tool_call_delta',
            index: toolIndex,
            id: name,
            name,
            argumentsDelta: JSON.stringify(asRecord(fnCall?.args) ?? {}),
          };
          toolIndex += 1;
        }
      }

      const finish = asString(candidate?.finishReason);
      if (finish !== undefined) {
        stopReason = mapFinishReason(finish);
      }

      const meta = asRecord(obj.usageMetadata);
      if (meta !== undefined) {
        // Route through extractUsage so the breakdown rides into the vector.
        usage = extractUsage(obj);
      }
    }

    if (usage !== undefined) {
      yield { type: 'usage', usage: vectorToChatUsage(usage) };
    }
    yield { type: 'stop', stopReason };
    yield { type: 'done' };
  },

  /**
   * Model discovery for `sync-models`: `GET {endpoint}/v1beta/models` (Gemini
   * model list; api key in the query). Only `generateContent`-capable models are
   * returned (excludes embedding/aqa/imagen), id stripped of the `models/` prefix.
   */
  async listModels(ctx: AdapterContext): Promise<ProviderModel[]> {
    const endpoint = ctx.endpoint ?? DEFAULT_ENDPOINT;
    const key = encodeURIComponent(ctx.apiKey ?? '');
    const res = await ctx.http.request({
      method: 'GET',
      url: `${endpoint}/v1beta/models?pageSize=1000&key=${key}`,
      ...withProxy(ctx),
    });
    if (!res.ok) {
      throw new AdapterError(mapErrorBody(res.status, res.body));
    }
    const models = asArray(asRecord(res.body)?.models) ?? [];
    return models
      .map((raw): ProviderModel | undefined => {
        const r = asRecord(raw);
        const methods = asArray(r?.supportedGenerationMethods) ?? [];
        if (!methods.includes('generateContent')) return undefined;
        const name = asString(r?.name);
        if (name === undefined) return undefined;
        const model: ProviderModel = { id: name.replace(/^models\//, '') };
        const displayName = asString(r?.displayName);
        if (displayName !== undefined) model.displayName = displayName;
        const contextWindow = asNumber(r?.inputTokenLimit);
        if (contextWindow !== undefined) model.contextWindow = contextWindow;
        return model;
      })
      .filter((m): m is ProviderModel => m !== undefined);
  },

  extractUsage,

  mapError(raw: unknown): UnifiedError {
    return mapErrorBody(500, raw);
  },
};
