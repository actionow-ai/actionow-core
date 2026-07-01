import type {
  AdapterContext,
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  ContentPart,
  EmbeddingsRequest,
  EmbeddingsResult,
  Message,
  ModerationRequest,
  ModerationResult,
  ProviderModel,
  RerankRequest,
  RerankResult,
  StopReason,
  StreamEvent,
  SubmitInput,
  SubmitResult,
  ToolCall,
  TranscriptionInput,
  TranscriptionResult,
  TranscriptionSegment,
  UnifiedError,
  UsageVector,
} from '@actionow/contracts';
import { dropUnsupportedBody, vectorToChatUsage } from '@actionow/contracts';

import { AdapterError, httpStatusToUnified } from './errors.js';
import { asArray, asNumber, asRecord, asString, parseJsonRecord } from './internal/json.js';
import { parseSse } from './internal/sse.js';
import { openStream, streamErrorEvent } from './internal/stream.js';
import type { AdapterCapabilities, ProviderAdapter } from './types.js';

const PROVIDER = 'openai';
const DEFAULT_ENDPOINT = 'https://api.openai.com/v1';

/** Spread `proxyUrl` into a request when the channel set one. */
function withProxy(ctx: AdapterContext): { proxyUrl?: string } {
  return ctx.proxyUrl === undefined ? {} : { proxyUrl: ctx.proxyUrl };
}

const CAPABILITIES: AdapterCapabilities = {
  tools: true,
  vision: true,
  audio: false,
  json: true,
  stream: true,
};

/** Map an IR content part to an OpenAI chat content part. */
function irPartToOpenAi(part: ContentPart): Record<string, unknown> {
  if (part.kind === 'text') {
    return { type: 'text', text: part.text };
  }
  if (part.kind === 'image') {
    // OpenAI's image_url accepts an https URL or a `data:<mime>;base64,<payload>`
    // data URI — a raw base64 payload is rejected. A `base64` source carries the
    // bare payload, so wrap it; `url`/`file_id` pass their value through.
    const url =
      part.source === 'base64'
        ? `data:${part.mime ?? 'application/octet-stream'};base64,${part.data}`
        : part.data;
    return { type: 'image_url', image_url: { url } };
  }
  // audio/file have no representation in this OpenAI chat adapter. REJECT rather
  // than stringify the payload (the old `{type:'text', text: part.data}` dumped
  // raw base64/URL into the prompt — corrupting the request and billing
  // megabytes of base64 as input text). The normalize gate only admits a part
  // kind here if the resolved MODEL claims to support it, so reaching this branch
  // means the served channel's adapter can't honor that claim — a clear error.
  throw new AdapterError({
    code: 'invalid_input',
    message: `openai chat adapter cannot represent ${part.kind} content`,
    retryable: false,
  });
}

/** Build the OpenAI `messages[]` entry for one IR message. */
function irMessageToOpenAi(msg: Message): Record<string, unknown> {
  const out: Record<string, unknown> = { role: msg.role };

  if (msg.role === 'tool') {
    // Tool results carry a flat string content + the originating call id.
    const text = msg.content
      .filter((p): p is Extract<ContentPart, { kind: 'text' }> => p.kind === 'text')
      .map((p) => p.text)
      .join('');
    out.content = text;
    if (msg.toolCallId !== undefined) {
      out.tool_call_id = msg.toolCallId;
    }
    return out;
  }

  // For assistant turns with tool calls and no content, OpenAI expects null.
  const textParts = msg.content.filter(
    (p): p is Extract<ContentPart, { kind: 'text' }> => p.kind === 'text',
  );
  const hasNonText = msg.content.some((p) => p.kind !== 'text');
  if (hasNonText) {
    out.content = msg.content.map(irPartToOpenAi);
  } else if (textParts.length > 0) {
    out.content = textParts.map((p) => p.text).join('');
  } else {
    out.content = msg.toolCalls !== undefined && msg.toolCalls.length > 0 ? null : '';
  }

  if (msg.toolCalls !== undefined && msg.toolCalls.length > 0) {
    out.tool_calls = msg.toolCalls.map((c) => ({
      id: c.id,
      type: 'function',
      function: { name: c.name, arguments: JSON.stringify(c.arguments) },
    }));
  }
  if (msg.name !== undefined) {
    out.name = msg.name;
  }
  return out;
}

/** Translate an IR `ChatRequest` into an OpenAI chat-completions body. */
function buildChatBody(
  ir: ChatRequest,
  ctx: AdapterContext,
  stream: boolean,
): Record<string, unknown> {
  // Spread the typed-open passthrough bag FIRST so every first-class/critical
  // field set below overrides it — `extra` can never clobber model/messages/
  // stream/tools/etc. (penalties, top_k, n, logprobs, logit_bias,
  // parallel_tool_calls, prompt_cache_key, service_tier, … ride through here).
  const body: Record<string, unknown> = { ...(ir.extra ?? {}) };
  body.model = ctx.model ?? ir.model;
  body.messages = ir.messages.map(irMessageToOpenAi);
  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  if (ir.tools !== undefined && ir.tools.length > 0) {
    body.tools = ir.tools.map((t) => {
      const fn: Record<string, unknown> = { name: t.name, parameters: t.parameters };
      if (t.description !== undefined) {
        fn.description = t.description;
      }
      return { type: 'function', function: fn };
    });
  }
  if (ir.toolChoice !== undefined) {
    body.tool_choice =
      typeof ir.toolChoice === 'string'
        ? ir.toolChoice
        : { type: 'function', function: { name: ir.toolChoice.name } };
  }
  const params = ir.params;
  if (params !== undefined) {
    if (params.temperature !== undefined) {
      body.temperature = params.temperature;
    }
    if (params.topP !== undefined) {
      body.top_p = params.topP;
    }
    if (params.maxOutputTokens !== undefined) {
      body.max_tokens = params.maxOutputTokens;
    }
    if (params.stop !== undefined) {
      body.stop = params.stop;
    }
    if (params.seed !== undefined) {
      body.seed = params.seed;
    }
    if (params.responseFormat !== undefined && params.responseFormat !== 'text') {
      // Forward the full strict json_schema body when present; otherwise the bare type.
      if (params.responseFormat === 'json_schema' && params.jsonSchema !== undefined) {
        body.response_format = {
          type: 'json_schema',
          json_schema: { name: 'response', schema: params.jsonSchema, strict: true },
        };
      } else {
        body.response_format = { type: params.responseFormat };
      }
    }
    if (params.reasoningEffort !== undefined) {
      body.reasoning_effort = params.reasoningEffort;
    }
  }
  // Stage ④ — prune known-standard sampling keys this model does not declare,
  // per the frozen profile's dropPolicy. A passthrough/empty profile returns the
  // SAME body reference (byte-for-byte identical to today). Never drops a
  // non-standard `extra` key (top_k, prompt_cache_key, …). The `error` policy is
  // enforced by the engine BEFORE dispatch; here we only apply the prune.
  return dropUnsupportedBody(body, ctx.paramProfile).body;
}

/** Map an OpenAI `finish_reason` to an IR {@link StopReason}. */
function mapFinishReason(raw: string | undefined): StopReason {
  switch (raw) {
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}

/** Parse an OpenAI `message.tool_calls[]` array into IR {@link ToolCall}s. */
function parseToolCalls(raw: unknown): ToolCall[] {
  const arr = asArray(raw);
  if (arr === undefined) {
    return [];
  }
  const calls: ToolCall[] = [];
  for (const entry of arr) {
    const rec = asRecord(entry);
    const fn = asRecord(rec?.function);
    const name = asString(fn?.name);
    if (name === undefined) {
      continue;
    }
    calls.push({
      id: asString(rec?.id) ?? '',
      name,
      arguments: parseJsonRecord(asString(fn?.arguments) ?? '') ?? {},
    });
  }
  return calls;
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

/** Coerce an OpenAI `data[].embedding` value into a `number[]` (non-numbers dropped). */
function parseEmbedding(raw: unknown): number[] {
  const arr = asArray(raw);
  if (arr === undefined) return [];
  return arr.map((v) => asNumber(v)).filter((n): n is number => n !== undefined);
}

/** Parse an OpenAI `verbose_json` transcription `segments[]` array into IR segments. */
function parseSegments(raw: unknown): TranscriptionSegment[] {
  const arr = asArray(raw);
  if (arr === undefined) return [];
  const out: TranscriptionSegment[] = [];
  for (const entry of arr) {
    const rec = asRecord(entry);
    const text = asString(rec?.text);
    if (text === undefined) continue;
    const seg: TranscriptionSegment = { text };
    const id = asNumber(rec?.id);
    if (id !== undefined) seg.id = id;
    const start = asNumber(rec?.start);
    if (start !== undefined) seg.start = start;
    const end = asNumber(rec?.end);
    if (end !== undefined) seg.end = end;
    out.push(seg);
  }
  return out;
}

/** Narrow an unknown to a `boolean`, defaulting to `false`. */
function asBool(x: unknown): boolean {
  return typeof x === 'boolean' ? x : false;
}

/** Coerce a JSON record of unknown values into a `Record<string, boolean>`. */
function asBoolRecord(raw: unknown): Record<string, boolean> {
  const rec = asRecord(raw);
  if (rec === undefined) return {};
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(rec)) out[k] = asBool(v);
  return out;
}

/** Coerce a JSON record of unknown values into a `Record<string, number>` (non-numbers dropped). */
function asNumberRecord(raw: unknown): Record<string, number> {
  const rec = asRecord(raw);
  if (rec === undefined) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(rec)) {
    const n = asNumber(v);
    if (n !== undefined) out[k] = n;
  }
  return out;
}

/** Conventional ~4 bytes/token GPT-family divisor for a local input-token estimate. */
const BYTES_PER_TOKEN = 4;

/**
 * A deterministic local input-token count for rerank/moderation upstreams that
 * return no usage block: `ceil(totalBytes / 4)`, floored at the number of
 * non-empty strings so a short input still costs at least one token. INPUT only.
 */
function countInputTokens(query: string, parts: readonly string[]): number {
  const strings = [query, ...parts].filter((s) => s.length > 0);
  const bytes = strings.reduce((sum, s) => sum + s.length, 0);
  return Math.max(strings.length, Math.ceil(bytes / BYTES_PER_TOKEN));
}

/**
 * Fold OpenAI's usage-breakdown sub-objects into the snake_case vector keys,
 * ONLY when the upstream reports them: `completion_tokens_details.reasoning_tokens`
 * → reasoning; `prompt_tokens_details.cached_tokens` → cachedInput;
 * `prompt_tokens_details.audio_tokens` → audioInput;
 * `completion_tokens_details.audio_tokens` → audioOutput. A present-but-zero count
 * is preserved (the provider broke it out); an absent sub-object leaves the key
 * unset so the vector stays additive.
 */
function addOpenAiBreakdown(vector: UsageVector, usage: Record<string, unknown> | undefined): void {
  const promptDetails = asRecord(usage?.prompt_tokens_details);
  const completionDetails = asRecord(usage?.completion_tokens_details);
  const reasoning = asNumber(completionDetails?.reasoning_tokens);
  if (reasoning !== undefined) vector.reasoning_tokens = reasoning;
  const cached = asNumber(promptDetails?.cached_tokens);
  if (cached !== undefined) vector.cached_input_tokens = cached;
  const audioIn = asNumber(promptDetails?.audio_tokens);
  if (audioIn !== undefined) vector.audio_input_tokens = audioIn;
  const audioOut = asNumber(completionDetails?.audio_tokens);
  if (audioOut !== undefined) vector.audio_output_tokens = audioOut;
}

/** Extract `{input_tokens, output_tokens}` (+ breakdown) from an OpenAI `usage` block. */
function extractUsage(raw: unknown): UsageVector {
  const usage = asRecord(asRecord(raw)?.usage);
  const vector: UsageVector = {
    input_tokens: asNumber(usage?.prompt_tokens) ?? 0,
    output_tokens: asNumber(usage?.completion_tokens) ?? 0,
  };
  addOpenAiBreakdown(vector, usage);
  return vector;
}

/** Map an OpenAI error body to a {@link UnifiedError}. Falls back by status. */
function mapErrorBody(status: number, raw: unknown): UnifiedError {
  const error = asRecord(asRecord(raw)?.error);
  const rawCode = asString(error?.code) ?? asString(error?.type);
  return httpStatusToUnified(PROVIDER, status, rawCode);
}

export const openaiAdapter: ProviderAdapter = {
  providerType: PROVIDER,
  capabilities: CAPABILITIES,

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

      // A trailing chunk carries usage with an empty `choices` array; route it
      // through `extractUsage` so the breakdown rides into the vector too.
      const chunkUsage = asRecord(obj.usage);
      if (chunkUsage !== undefined) {
        usage = extractUsage(obj);
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

  async chat(ir: ChatRequest, ctx: AdapterContext): Promise<ChatResponse> {
    const endpoint = ctx.endpoint ?? DEFAULT_ENDPOINT;
    const body = buildChatBody(ir, ctx, false);

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
    const message = asRecord(choice?.message);
    const content: ContentPart[] = [];
    const text = asString(message?.content);
    if (text !== undefined && text.length > 0) {
      content.push({ kind: 'text', text });
    }
    const toolCalls = parseToolCalls(message?.tool_calls);

    const irMessage: Message = { role: 'assistant', content };
    if (toolCalls.length > 0) {
      irMessage.toolCalls = toolCalls;
    }

    return {
      message: irMessage,
      stopReason: mapFinishReason(asString(choice?.finish_reason)),
      // Build the camelCase IR usage from the snake_case vector (totals +
      // breakdown) so reasoning/cached/audio counts surface on the response.
      usage: vectorToChatUsage(extractUsage(res.body)),
    };
  },

  async embed(req: EmbeddingsRequest, ctx: AdapterContext): Promise<EmbeddingsResult> {
    const endpoint = ctx.endpoint ?? DEFAULT_ENDPOINT;
    const body: Record<string, unknown> = {
      model: ctx.model ?? req.model,
      input: req.input,
    };
    if (req.encodingFormat !== undefined) body.encoding_format = req.encodingFormat;
    if (req.dimensions !== undefined) body.dimensions = req.dimensions;
    if (req.user !== undefined) body.user = req.user;

    const res = await ctx.http.request({
      method: 'POST',
      url: `${endpoint}/embeddings`,
      headers: { Authorization: `Bearer ${ctx.apiKey ?? ''}` },
      body,
      ...withProxy(ctx),
    });

    if (!res.ok) {
      throw new AdapterError(mapErrorBody(res.status, res.body));
    }

    const data = asArray(asRecord(res.body)?.data);
    if (data === undefined) {
      throw new AdapterError({
        code: 'upstream_error',
        message: 'openai embeddings response did not contain a data array',
        upstream: { provider: PROVIDER },
        retryable: false,
      });
    }
    // Preserve provider order by `index` (defaults to position) so vectors[i] ↔ input[i].
    const vectors: number[][] = data
      .map((entry) => {
        const rec = asRecord(entry);
        const index = asNumber(rec?.index) ?? 0;
        return { index, embedding: parseEmbedding(rec?.embedding) };
      })
      .sort((a, b) => a.index - b.index)
      .map((e) => e.embedding);

    const usage = asRecord(asRecord(res.body)?.usage);
    return {
      vectors,
      usage: { inputTokens: asNumber(usage?.prompt_tokens) ?? 0 },
    };
  },

  async rerank(req: RerankRequest, ctx: AdapterContext): Promise<RerankResult> {
    const endpoint = ctx.endpoint ?? DEFAULT_ENDPOINT;
    const body: Record<string, unknown> = {
      model: ctx.model ?? req.model,
      query: req.query,
      documents: req.documents,
      // Cohere/Jina echo each document text back when asked; surface it so the
      // relay can pass it through verbatim.
      return_documents: true,
    };
    if (req.topN !== undefined) body.top_n = req.topN;

    const res = await ctx.http.request({
      method: 'POST',
      url: `${endpoint}/rerank`,
      headers: { Authorization: `Bearer ${ctx.apiKey ?? ''}` },
      body,
      ...withProxy(ctx),
    });

    if (!res.ok) {
      throw new AdapterError(mapErrorBody(res.status, res.body));
    }

    const results = asArray(asRecord(res.body)?.results);
    if (results === undefined) {
      throw new AdapterError({
        code: 'upstream_error',
        message: 'rerank response did not contain a results array',
        upstream: { provider: PROVIDER },
        retryable: false,
      });
    }
    const items = results.map((entry) => {
      const rec = asRecord(entry);
      const index = asNumber(rec?.index) ?? 0;
      const relevanceScore = asNumber(rec?.relevance_score) ?? 0;
      // Cohere returns `document.text`; Jina returns a flat `document` string.
      const docText = asString(rec?.document) ?? asString(asRecord(rec?.document)?.text);
      const item: RerankResult['results'][number] = { index, relevanceScore };
      if (docText !== undefined) item.document = docText;
      return item;
    });

    // Cohere/Jina expose token usage under `meta.billed_units.{search_units,tokens}`
    // or a flat `usage`; fall back to a deterministic local count when absent so the
    // settle is always input-token-priced.
    const meta = asRecord(asRecord(res.body)?.meta);
    const billed = asRecord(meta?.billed_units);
    const usageTokens =
      asNumber(asRecord(asRecord(res.body)?.usage)?.total_tokens) ??
      asNumber(billed?.tokens) ??
      countInputTokens(req.query, req.documents);
    return { results: items, usage: { inputTokens: usageTokens } };
  },

  async moderate(req: ModerationRequest, ctx: AdapterContext): Promise<ModerationResult> {
    const endpoint = ctx.endpoint ?? DEFAULT_ENDPOINT;
    const res = await ctx.http.request({
      method: 'POST',
      url: `${endpoint}/moderations`,
      headers: { Authorization: `Bearer ${ctx.apiKey ?? ''}` },
      body: { model: ctx.model ?? req.model, input: req.input },
      ...withProxy(ctx),
    });

    if (!res.ok) {
      throw new AdapterError(mapErrorBody(res.status, res.body));
    }

    const results = asArray(asRecord(res.body)?.results);
    if (results === undefined) {
      throw new AdapterError({
        code: 'upstream_error',
        message: 'moderation response did not contain a results array',
        upstream: { provider: PROVIDER },
        retryable: false,
      });
    }
    const verdicts = results.map((entry) => {
      const rec = asRecord(entry);
      return {
        flagged: asBool(rec?.flagged),
        categories: asBoolRecord(rec?.categories),
        categoryScores: asNumberRecord(rec?.category_scores),
      };
    });

    // OpenAI's moderations endpoint returns NO usage block, so meter on a
    // deterministic local input-token estimate (~4 bytes/token) — input only.
    const inputs = Array.isArray(req.input) ? req.input : [req.input];
    return { results: verdicts, usage: { inputTokens: countInputTokens('', inputs) } };
  },

  async transcribe(req: TranscriptionInput, ctx: AdapterContext): Promise<TranscriptionResult> {
    const endpoint = ctx.endpoint ?? DEFAULT_ENDPOINT;

    // Build the multipart upstream request from the uploaded bytes. ALWAYS request
    // `verbose_json` upstream (regardless of the CLIENT's requested format) so the
    // response carries the `duration` the settle bills on; the relay re-shapes the
    // client response itself. The Blob wraps the bytes with the upload's
    // content-type so the upstream sniffs the codec correctly.
    const form = new FormData();
    // Copy the bytes into a fresh ArrayBuffer-backed view so the Blob constructor
    // accepts it (a `Uint8Array<ArrayBufferLike>` — which may be SharedArrayBuffer-
    // backed — is not a valid `BlobPart`). This also detaches the upload buffer.
    const bytes = new Uint8Array(req.file.byteLength);
    bytes.set(req.file);
    const blob = new Blob([bytes], {
      type: req.contentType ?? 'application/octet-stream',
    });
    form.append('file', blob, req.filename);
    form.append('model', ctx.model ?? req.model);
    form.append('response_format', 'verbose_json');
    if (req.language !== undefined) form.append('language', req.language);
    if (req.prompt !== undefined) form.append('prompt', req.prompt);
    if (req.temperature !== undefined) form.append('temperature', String(req.temperature));

    const res = await ctx.http.request({
      method: 'POST',
      url: `${endpoint}/audio/transcriptions`,
      // No content-type header: the fetch egress sets the multipart boundary itself.
      headers: { Authorization: `Bearer ${ctx.apiKey ?? ''}` },
      body: form,
      ...withProxy(ctx),
    });

    if (!res.ok) {
      throw new AdapterError(mapErrorBody(res.status, res.body));
    }

    const body = asRecord(res.body);
    const text = asString(body?.text);
    if (text === undefined) {
      throw new AdapterError({
        code: 'upstream_error',
        message: 'openai transcription response did not contain a text field',
        upstream: { provider: PROVIDER },
        retryable: false,
      });
    }
    const result: TranscriptionResult = {
      text,
      // `duration` is the BILLED dimension; when the upstream omits it the relay
      // falls back to the hold estimate (so STT can never settle free).
      usage: { audioSeconds: asNumber(body?.duration) ?? 0 },
    };
    const duration = asNumber(body?.duration);
    if (duration !== undefined) result.duration = duration;
    const language = asString(body?.language);
    if (language !== undefined) result.language = language;
    const segments = parseSegments(body?.segments);
    if (segments.length > 0) result.segments = segments;
    return result;
  },

  async *streamChat(ir: ChatRequest, ctx: AdapterContext): AsyncIterable<ChatStreamEvent> {
    const endpoint = ctx.endpoint ?? DEFAULT_ENDPOINT;
    const body = buildChatBody(ir, ctx, true);

    const res = await openStream(ctx, PROVIDER, {
      method: 'POST',
      url: `${endpoint}/chat/completions`,
      headers: { Authorization: `Bearer ${ctx.apiKey ?? ''}` },
      body,
      ...withProxy(ctx),
    });

    if (!res.ok) {
      yield { type: 'error', error: httpStatusToUnified(PROVIDER, res.status) };
      return;
    }

    let started = false;

    for await (const frame of parseSse(res.lines)) {
      const data = frame.data;
      if (data === '[DONE]') {
        break;
      }
      const obj = parseJsonRecord(data);
      if (obj === undefined) {
        continue;
      }

      if (!started) {
        started = true;
        yield { type: 'message_start' };
      }

      const choice = asRecord(asArray(obj.choices)?.[0]);
      const delta = asRecord(choice?.delta);

      const text = asString(delta?.content);
      if (text !== undefined && text.length > 0) {
        yield { type: 'content_delta', text };
      }

      const toolDeltas = asArray(delta?.tool_calls);
      if (toolDeltas !== undefined) {
        for (const entry of toolDeltas) {
          const rec = asRecord(entry);
          const fn = asRecord(rec?.function);
          const event: Extract<ChatStreamEvent, { type: 'tool_call_delta' }> = {
            type: 'tool_call_delta',
            index: asNumber(rec?.index) ?? 0,
          };
          const id = asString(rec?.id);
          if (id !== undefined) {
            event.id = id;
          }
          const name = asString(fn?.name);
          if (name !== undefined) {
            event.name = name;
          }
          const argsDelta = asString(fn?.arguments);
          if (argsDelta !== undefined) {
            event.argumentsDelta = argsDelta;
          }
          yield event;
        }
      }

      const finish = asString(choice?.finish_reason);
      if (finish !== undefined) {
        yield { type: 'stop', stopReason: mapFinishReason(finish) };
      }

      // A trailing chunk carries usage with an empty `choices` array. Route it
      // through `extractUsage` so the breakdown (reasoning/cached/audio) rides
      // into the IR `usage` event alongside the totals.
      const usage = asRecord(obj.usage);
      if (usage !== undefined) {
        yield { type: 'usage', usage: vectorToChatUsage(extractUsage(obj)) };
      }
    }

    yield { type: 'done' };
  },

  /**
   * Model discovery for `sync-models`: `GET {endpoint}/models` (OpenAI + any
   * OpenAI-compatible relay). Returns every listed id as a {@link ProviderModel}
   * — the relay/operator prunes non-chat entries (this adapter also fronts
   * openai-compatible upstreams whose ids aren't `gpt-*`, so no name filter).
   */
  async listModels(ctx: AdapterContext): Promise<ProviderModel[]> {
    const endpoint = ctx.endpoint ?? DEFAULT_ENDPOINT;
    const res = await ctx.http.request({
      method: 'GET',
      url: `${endpoint}/models`,
      headers: { Authorization: `Bearer ${ctx.apiKey ?? ''}` },
      ...withProxy(ctx),
    });
    if (!res.ok) {
      throw new AdapterError(mapErrorBody(res.status, res.body));
    }
    const data = asArray(asRecord(res.body)?.data) ?? [];
    return data
      .map((raw): ProviderModel | undefined => {
        const id = asString(asRecord(raw)?.id);
        if (id === undefined) return undefined;
        // Drop unambiguously non-chat OpenAI models (embeddings/audio/image/
        // moderation) so a chat resource's sync stays clean. These substrings
        // never appear in openai-COMPATIBLE relay chat ids (deepseek/mimo/etc.),
        // so relays are unaffected.
        if (/embedding|whisper|tts-|dall-e|moderation|image-1/.test(id)) return undefined;
        return { id, displayName: id };
      })
      .filter((m): m is ProviderModel => m !== undefined);
  },

  extractUsage,

  mapError(raw: unknown): UnifiedError {
    return mapErrorBody(500, raw);
  },
};
