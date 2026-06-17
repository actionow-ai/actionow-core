/**
 * Pure IR <-> OpenAI **Responses** API translation for the codex-oauth adapter.
 *
 * ChatGPT's private Codex backend speaks the OpenAI Responses API (NOT Chat
 * Completions), so this file hand-rolls the wire mapping inline — adapters may
 * not import `@actionow/llm-protocol`. Only the IR contracts types and the
 * internal `json` narrowing helpers are used here. The transport +
 * impersonation that wraps these three functions lands in S2.6b.
 *
 * Field names are built to the documented Responses shapes; any uncertain ones
 * carry a `// VERIFY` note for the real-token / e2e pass to confirm.
 */
import type {
  AdapterContext,
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  ChatUsage,
  ContentPart,
  Message,
  StopReason,
  ToolCall,
  ToolDef,
  UnifiedError,
  UsageVector,
} from '@actionow/contracts';

import { AdapterError, httpStatusToUnified } from './errors.js';
import { asArray, asNumber, asRecord, asString, parseJsonRecord } from './internal/json.js';
import { parseSse } from './internal/sse.js';
import { openStream } from './internal/stream.js';
import type { AdapterCapabilities, ProviderAdapter } from './types.js';

/**
 * The codex backend rejects a request with an absent/empty `instructions`
 * field (HTTP 400 `{"detail":"Instructions are required"}`), so we always send
 * a non-empty value — this default applies when the IR has no system text.
 */
const CODEX_DEFAULT_INSTRUCTIONS = 'You are a helpful assistant.';

/** Options for {@link irToResponsesBody}. */
export interface ResponsesBodyOpts {
  /** Whether to request an SSE stream (sets `stream`). */
  stream: boolean;
  /**
   * Optional upstream model name override. When set (e.g. from a per-channel
   * `ctx.model`), it wins over `ir.model` so a channel can pin the upstream to
   * a supported model name.
   */
  model?: string;
}

/**
 * A Responses request body. `input` is always an array; `store` is always
 * false; `instructions` is always present and non-empty (the codex backend
 * rejects an absent/empty one).
 */
export interface ResponsesBody {
  model: string;
  instructions: string;
  input: Record<string, unknown>[];
  stream: boolean;
  store: false;
  tools?: Record<string, unknown>[];
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
}

/** Join all text parts of an IR message into one string. */
function joinText(content: ContentPart[]): string {
  return content
    .filter((p): p is Extract<ContentPart, { kind: 'text' }> => p.kind === 'text')
    .map((p) => p.text)
    .join('');
}

/**
 * Map an IR content part to a Responses message-content entry.
 *
 * `role` selects the text variant: assistant turns use `output_text`, every
 * other (user) turn uses `input_text`. A base64 image is wrapped as a
 * `data:<mime>;base64,<payload>` URI (a bare payload is rejected); url/file_id
 * pass through. audio/file have no first-class Responses entry — pass the text.
 */
function irPartToContent(part: ContentPart, role: 'user' | 'assistant'): Record<string, unknown> {
  if (part.kind === 'text') {
    return { type: role === 'assistant' ? 'output_text' : 'input_text', text: part.text };
  }
  if (part.kind === 'image') {
    const url =
      part.source === 'base64'
        ? `data:${part.mime ?? 'application/octet-stream'};base64,${part.data}`
        : part.data;
    return { type: 'input_image', image_url: url };
  }
  return { type: role === 'assistant' ? 'output_text' : 'input_text', text: part.data };
}

/** Map a single IR ToolDef to a Responses `tools[]` (flat function) entry. */
function irToolToResponses(tool: ToolDef): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: 'function',
    name: tool.name,
    parameters: tool.parameters,
  };
  if (tool.description !== undefined) {
    out.description = tool.description;
  }
  return out;
}

/**
 * Append the Responses `input[]` items for one non-system IR message.
 *
 * - user/assistant text+image -> a `message` item with a content array.
 * - assistant `toolCalls` -> one `function_call` item each.
 * - a `tool` result (carries `toolCallId`) -> a `function_call_output` item.
 */
function pushInputItems(items: Record<string, unknown>[], msg: Message): void {
  if (msg.role === 'tool') {
    // VERIFY: Responses tool-result item is `function_call_output {call_id, output}`.
    items.push({
      type: 'function_call_output',
      call_id: msg.toolCallId ?? '',
      output: joinText(msg.content),
    });
    return;
  }

  const role = msg.role === 'assistant' ? 'assistant' : 'user';
  if (msg.content.length > 0) {
    items.push({
      type: 'message',
      role,
      content: msg.content.map((p) => irPartToContent(p, role)),
    });
  }

  if (msg.toolCalls !== undefined) {
    for (const call of msg.toolCalls) {
      // VERIFY: Responses tool-call item is `function_call {call_id, name, arguments}`.
      items.push({
        type: 'function_call',
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      });
    }
  }
}

/**
 * Translate an IR {@link ChatRequest} into an OpenAI Responses request body.
 *
 * All `system` messages are concatenated into top-level `instructions` (the
 * Responses upstream rejects a system role inside `input`); when the IR carries
 * no system text we fall back to {@link CODEX_DEFAULT_INSTRUCTIONS} because the
 * codex backend rejects an absent/empty `instructions`. `store` is always
 * false; `stream` follows the caller's opts; `model` is `opts.model ?? ir.model`
 * so a per-channel override (`ctx.model`) reaches the upstream.
 */
export function irToResponsesBody(ir: ChatRequest, opts: ResponsesBodyOpts): ResponsesBody {
  const systemTexts: string[] = [];
  const input: Record<string, unknown>[] = [];
  for (const msg of ir.messages) {
    if (msg.role === 'system') {
      systemTexts.push(joinText(msg.content));
    } else {
      pushInputItems(input, msg);
    }
  }

  const body: ResponsesBody = {
    model: opts.model ?? ir.model,
    // Always non-empty: the codex backend rejects an absent/empty instructions.
    instructions: systemTexts.length > 0 ? systemTexts.join('\n') : CODEX_DEFAULT_INSTRUCTIONS,
    input,
    stream: opts.stream,
    store: false,
  };
  if (ir.tools !== undefined && ir.tools.length > 0) {
    body.tools = ir.tools.map(irToolToResponses);
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
      body.max_output_tokens = params.maxOutputTokens;
    }
  }
  return body;
}

/** Read `{input_tokens, output_tokens}` from a Responses `usage` block into IR usage. */
function usageFrom(raw: unknown): ChatUsage {
  const usage = asRecord(raw);
  return {
    inputTokens: asNumber(usage?.input_tokens) ?? 0,
    outputTokens: asNumber(usage?.output_tokens) ?? 0,
  };
}

/**
 * Parse a non-stream Responses reply into an IR {@link ChatResponse}.
 *
 * `output[]` carries `message` items (with `output_text` content) and
 * `function_call` items (whose `arguments` are a JSON string). stopReason:
 * a function_call present -> 'tool_calls'; `incomplete_details.reason ===
 * 'max_output_tokens'` -> 'length'; otherwise 'stop'.
 */
export function parseResponsesResponse(wire: unknown): ChatResponse {
  const root = asRecord(wire);
  const output = asArray(root?.output) ?? [];

  const content: ContentPart[] = [];
  const toolCalls: ToolCall[] = [];
  for (const item of output) {
    const rec = asRecord(item);
    const type = asString(rec?.type);
    if (type === 'message') {
      for (const part of asArray(rec?.content) ?? []) {
        const partRec = asRecord(part);
        if (asString(partRec?.type) === 'output_text') {
          const text = asString(partRec?.text);
          if (text !== undefined) {
            content.push({ kind: 'text', text });
          }
        }
      }
    } else if (type === 'function_call') {
      const name = asString(rec?.name);
      if (name !== undefined) {
        toolCalls.push({
          id: asString(rec?.call_id) ?? '',
          name,
          arguments: parseJsonRecord(asString(rec?.arguments) ?? '') ?? {},
        });
      }
    }
  }

  const message: Message = { role: 'assistant', content };
  if (toolCalls.length > 0) {
    message.toolCalls = toolCalls;
  }

  return {
    message,
    stopReason: responseStopReason(root, toolCalls.length > 0),
    usage: usageFrom(root?.usage),
  };
}

/**
 * Fold a {@link parseResponsesSse} event stream into a {@link ChatResponse}.
 *
 * Mirrors the {@link parseResponsesResponse} (non-stream) output shape:
 * - `content_delta.text` slices concatenate into the assistant text part;
 * - `tool_call_delta` events accumulate per IR `index` (the first carries
 *   `id`/`name`, later ones carry `argumentsDelta` slices); the concatenated
 *   arguments string is JSON-parsed once at the end;
 * - the `usage` event becomes `ChatResponse.usage`;
 * - the `stop` event becomes `stopReason`;
 * - an `error` event throws an {@link AdapterError}.
 */
async function aggregateStream(events: AsyncIterable<ChatStreamEvent>): Promise<ChatResponse> {
  let text = '';
  let usage: ChatUsage = { inputTokens: 0, outputTokens: 0 };
  let stopReason: StopReason = 'stop';
  // Per IR index: id/name (from the first slice) + accumulated arguments string.
  const calls = new Map<number, { id: string; name: string; args: string }>();

  for await (const event of events) {
    switch (event.type) {
      case 'content_delta':
        text += event.text;
        break;
      case 'tool_call_delta': {
        let call = calls.get(event.index);
        if (call === undefined) {
          call = { id: '', name: '', args: '' };
          calls.set(event.index, call);
        }
        if (event.id !== undefined) {
          call.id = event.id;
        }
        if (event.name !== undefined) {
          call.name = event.name;
        }
        if (event.argumentsDelta !== undefined) {
          call.args += event.argumentsDelta;
        }
        break;
      }
      case 'usage':
        usage = event.usage;
        break;
      case 'stop':
        stopReason = event.stopReason;
        break;
      case 'error':
        throw new AdapterError(event.error);
      default:
        break;
    }
  }

  const content: ContentPart[] = [];
  if (text.length > 0) {
    content.push({ kind: 'text', text });
  }
  const toolCalls: ToolCall[] = [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => ({
      id: call.id,
      name: call.name,
      arguments: parseJsonRecord(call.args) ?? {},
    }));

  const message: Message = { role: 'assistant', content };
  if (toolCalls.length > 0) {
    message.toolCalls = toolCalls;
  }
  return { message, stopReason, usage };
}

/** Resolve the IR stopReason for a non-stream reply. */
function responseStopReason(
  root: Record<string, unknown> | undefined,
  hasToolCall: boolean,
): StopReason {
  if (hasToolCall) {
    return 'tool_calls';
  }
  const reason = asString(asRecord(root?.incomplete_details)?.reason);
  if (reason === 'max_output_tokens') {
    return 'length';
  }
  return 'stop';
}

/** Build an IR error event from a Responses failure frame. */
function errorEvent(message: string): Extract<ChatStreamEvent, { type: 'error' }> {
  const error: UnifiedError = { code: 'upstream_error', message, retryable: false };
  return { type: 'error', error };
}

/**
 * Translate a Responses SSE byte stream into IR {@link ChatStreamEvent}s.
 *
 * Responses frames are typed: `event: <type>\ndata: {json}\n\n`. We read the
 * frame's `event` name (the JSON `data.type` mirrors it) and map:
 * - `response.created` (first frame) -> a single `message_start`.
 * - `response.output_text.delta` -> `content_delta`.
 * - `response.output_item.added` of a function_call -> captures id/name +
 *   assigns a per-item IR index, surfaced on the first arguments delta.
 * - `response.function_call_arguments.delta` -> `tool_call_delta` (id/name on
 *   the first slice for that item, then bare `argumentsDelta` slices).
 * - `response.completed` -> `usage`, then `stop` ('tool_calls' if a
 *   function_call was seen, else 'stop'), then `done`.
 * - `response.failed` / `response.error` / `error` -> an `error` event.
 */
export async function* parseResponsesSse(
  lines: AsyncIterable<string>,
): AsyncIterable<ChatStreamEvent> {
  let started = false;
  let sawToolCall = false;
  // Per function_call item: stable IR index + whether we've emitted id/name yet.
  const items = new Map<string, { index: number; emittedMeta: boolean }>();
  const meta = new Map<string, { id: string; name?: string }>();
  let nextIndex = 0;

  for await (const frame of parseSse(lines)) {
    const obj = parseJsonRecord(frame.data);
    if (obj === undefined) {
      continue;
    }
    // The frame `event:` field is authoritative; the JSON `type` mirrors it.
    const type = frame.event ?? asString(obj.type);

    if (!started) {
      started = true;
      yield { type: 'message_start' };
      if (type === 'response.created') {
        continue;
      }
    }

    if (type === 'response.created') {
      continue;
    }

    if (type === 'response.output_text.delta') {
      const delta = asString(obj.delta);
      if (delta !== undefined && delta.length > 0) {
        yield { type: 'content_delta', text: delta };
      }
      continue;
    }

    if (type === 'response.output_item.added') {
      // VERIFY: correlation assumes output_item.added's item.id == the later
      // function_call_arguments.delta's item_id (per the Responses spec); confirm
      // against a real multi-tool stream on the live-token pass.
      const item = asRecord(obj.item);
      if (asString(item?.type) === 'function_call') {
        sawToolCall = true;
        const itemId = asString(item?.id) ?? asString(obj.item_id) ?? '';
        const callId = asString(item?.call_id) ?? itemId;
        const m: { id: string; name?: string } = { id: callId };
        const name = asString(item?.name);
        if (name !== undefined) {
          m.name = name;
        }
        meta.set(itemId, m);
        if (!items.has(itemId)) {
          items.set(itemId, { index: nextIndex++, emittedMeta: false });
        }
      }
      continue;
    }

    if (type === 'response.function_call_arguments.delta') {
      sawToolCall = true;
      const itemId = asString(obj.item_id) ?? '';
      let tracked = items.get(itemId);
      if (tracked === undefined) {
        tracked = { index: nextIndex++, emittedMeta: false };
        items.set(itemId, tracked);
      }
      const event: Extract<ChatStreamEvent, { type: 'tool_call_delta' }> = {
        type: 'tool_call_delta',
        index: tracked.index,
      };
      if (!tracked.emittedMeta) {
        const m = meta.get(itemId);
        if (m !== undefined) {
          event.id = m.id;
          if (m.name !== undefined) {
            event.name = m.name;
          }
        }
        tracked.emittedMeta = true;
      }
      const delta = asString(obj.delta);
      if (delta !== undefined) {
        event.argumentsDelta = delta;
      }
      yield event;
      continue;
    }

    if (type === 'response.completed') {
      const response = asRecord(obj.response);
      yield { type: 'usage', usage: usageFrom(response?.usage) };
      yield { type: 'stop', stopReason: sawToolCall ? 'tool_calls' : 'stop' };
      yield { type: 'done' };
      return;
    }

    if (type === 'response.failed' || type === 'response.error' || type === 'error') {
      const response = asRecord(obj.response);
      const message =
        asString(asRecord(response?.error)?.message) ??
        asString(asRecord(obj.error)?.message) ??
        asString(obj.message) ??
        'codex responses stream failed';
      yield errorEvent(message);
      return;
    }
    // Other frame types (response.in_progress, output_item.done, etc.) are inert.
  }

  // Defensive: emit terminal events if the stream ended without response.completed.
  yield { type: 'stop', stopReason: sawToolCall ? 'tool_calls' : 'stop' };
  yield { type: 'done' };
}

const PROVIDER = 'codex-oauth';

/** The default ChatGPT private Codex backend base (overridable per channel). */
const CODEX_DEFAULT_ENDPOINT = 'https://chatgpt.com/backend-api/codex';

/** First-party Codex CLI version impersonated on every request. */
const CODEX_VERSION = '0.125.0';

/** Codex CLI User-Agent string the private backend expects. */
const CODEX_USER_AGENT = `codex_cli_rs/${CODEX_VERSION} (Ubuntu 22.4.0; x86_64) xterm-256color`;

/** Originator header value identifying the request as the Codex CLI. */
const CODEX_ORIGINATOR = 'codex_cli_rs';

const CAPABILITIES: AdapterCapabilities = {
  tools: true,
  vision: true,
  audio: false,
  json: true,
  stream: true,
};

/** Spread `proxyUrl` into a request when the channel set one. */
function withProxy(ctx: AdapterContext): { proxyUrl?: string } {
  return ctx.proxyUrl === undefined ? {} : { proxyUrl: ctx.proxyUrl };
}

/**
 * Build the first-party Codex CLI impersonation headers.
 *
 * The private Codex backend only accepts requests that present themselves as
 * the real `codex_cli_rs` client driving the operator's OWN paid ChatGPT
 * account (the OAuth access token in `ctx.apiKey`). `Chatgpt-Account-Id` comes
 * from `ctx.config.chatgptAccountId` and is set only when present
 * (exactOptionalPropertyTypes).
 */
function codexHeaders(ctx: AdapterContext, accept: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${ctx.apiKey ?? ''}`,
    'User-Agent': CODEX_USER_AGENT,
    Originator: CODEX_ORIGINATOR,
    'OpenAI-Beta': 'responses=experimental',
    version: CODEX_VERSION,
    Accept: accept,
    'Content-Type': 'application/json',
  };
  const accountId = asString(asRecord(ctx.config)?.chatgptAccountId);
  if (accountId !== undefined) {
    headers['Chatgpt-Account-Id'] = accountId;
  }
  return headers;
}

/** Extract `{input_tokens, output_tokens}` from a Responses `usage` block. */
function extractUsage(raw: unknown): UsageVector {
  const usage = asRecord(asRecord(raw)?.usage);
  return {
    input_tokens: asNumber(usage?.input_tokens) ?? 0,
    output_tokens: asNumber(usage?.output_tokens) ?? 0,
  };
}

/** Map a Codex Responses error body to a {@link UnifiedError}. Falls back by status. */
function mapErrorBody(status: number, raw: unknown): UnifiedError {
  const error = asRecord(asRecord(raw)?.error);
  const rawCode = asString(error?.code) ?? asString(error?.type);
  return httpStatusToUnified(PROVIDER, status, rawCode);
}

/**
 * The single transport for the codex backend: POST a `stream:true` Responses
 * body with `Accept: text/event-stream` and parse the SSE reply into IR
 * {@link ChatStreamEvent}s. Both `chat()` (which then aggregates) and
 * `streamChat()` go through here, since the backend is stream-only. The
 * per-channel `ctx.model` override flows into the body's `model`.
 */
async function* streamResponses(
  ir: ChatRequest,
  ctx: AdapterContext,
): AsyncIterable<ChatStreamEvent> {
  const endpoint = ctx.endpoint ?? CODEX_DEFAULT_ENDPOINT;
  const opts: ResponsesBodyOpts =
    ctx.model === undefined ? { stream: true } : { stream: true, model: ctx.model };
  const res = await openStream(ctx, PROVIDER, {
    method: 'POST',
    url: `${endpoint}/responses`,
    headers: codexHeaders(ctx, 'text/event-stream'),
    body: irToResponsesBody(ir, opts),
    ...withProxy(ctx),
  });

  if (!res.ok) {
    yield { type: 'error', error: httpStatusToUnified(PROVIDER, res.status) };
    return;
  }

  yield* parseResponsesSse(res.lines);
}

/**
 * Adapter for the ChatGPT private Codex backend over OAuth (provider type
 * `codex-oauth`). It speaks the OpenAI **Responses** API and impersonates the
 * first-party `codex_cli_rs` CLI so the operator can relay through their own
 * paid account. Pure IR<->wire translation lives in the helpers above; this
 * object only adds transport + impersonation. Chat-only — `submit` rejects.
 */
export const codexOAuthAdapter: ProviderAdapter = {
  providerType: PROVIDER,
  capabilities: CAPABILITIES,

  submit(): Promise<never> {
    return Promise.reject(
      new AdapterError({
        code: 'invalid_input',
        message: 'codex-oauth is chat-only; use the IR chat path',
        upstream: { provider: PROVIDER },
        retryable: false,
      }),
    );
  },

  async chat(ir: ChatRequest, ctx: AdapterContext): Promise<ChatResponse> {
    // The codex backend is stream-only (a non-stream request returns HTTP 400
    // `{"detail":"Stream must be set to true"}`), so the blocking path consumes
    // the SSE stream and folds it into a ChatResponse.
    return aggregateStream(streamResponses(ir, ctx));
  },

  streamChat(ir: ChatRequest, ctx: AdapterContext): AsyncIterable<ChatStreamEvent> {
    return streamResponses(ir, ctx);
  },

  extractUsage,

  mapError(raw: unknown): UnifiedError {
    return mapErrorBody(500, raw);
  },
};
