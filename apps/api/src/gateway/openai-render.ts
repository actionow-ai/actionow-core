// apps/api/src/gateway/openai-render.ts
//
// model-supply-greenfield 批次5 slice3 — the OpenAI-wire OUTPUT stage of the
// chat/embeddings facade (§5 OpenAI 兼容基座): GatewayResponse → the
// `chat.completion` / embeddings `list` JSON, StreamFrame → the
// `chat.completion.chunk` SSE frames (terminated `data: [DONE]`; an error
// frame ends the stream WITHOUT [DONE] — v0.0.9 semantics), and GatewayError →
// the OpenAI `{error:{message,type,param,code}}` envelope.
//
// `GatewayResponse.output` for chat is the SPI aspect-⑤ normalized payload,
// whose exact shape is dialect-authored (§6): the openai dialect surfaces the
// `choices` array, the anthropic dialect surfaces the content blocks, the
// gemini dialect surfaces `{text, toolCalls?, finishReason?}`. This renderer
// recognizes those three shapes plus a bare string and renders each to the
// SAME OpenAI wire; an unrecognized shape degrades to a JSON-stringified text
// message (never a throw, never a silent empty body).
import { randomUUID } from 'node:crypto';

import type { GatewayError, GatewayResponse, GatewayUsage, StreamFrame } from '@actionow/contracts';
import type { Response } from 'express';

import { statusForGatewayError } from './gateway-error.js';

// --- small structural readers ---------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const asStr = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

// --- usage (IR metrics → OpenAI usage) --------------------------------------------------

/**
 * GatewayUsage.metrics (snake_case metered vector, §9.2) → the OpenAI wire
 * `usage`: totals always; the cached/reasoning/audio breakdown surfaces only
 * when metered (back-compat plain shape otherwise — the llm-protocol
 * openAiUsage 范式).
 */
export function openaiUsageOf(usage: GatewayUsage): Record<string, unknown> {
  const m = usage.metrics;
  const prompt = m.input_tokens ?? 0;
  const completion = m.output_tokens ?? 0;
  const out: Record<string, unknown> = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
  const promptDetails: Record<string, number> = {};
  if (m.cached_input_tokens !== undefined) promptDetails.cached_tokens = m.cached_input_tokens;
  if (m.audio_input_tokens !== undefined) promptDetails.audio_tokens = m.audio_input_tokens;
  if (Object.keys(promptDetails).length > 0) out.prompt_tokens_details = promptDetails;
  const completionDetails: Record<string, number> = {};
  if (m.reasoning_tokens !== undefined) completionDetails.reasoning_tokens = m.reasoning_tokens;
  if (m.audio_output_tokens !== undefined) completionDetails.audio_tokens = m.audio_output_tokens;
  if (Object.keys(completionDetails).length > 0) out.completion_tokens_details = completionDetails;
  return out;
}

// --- chat.completion (non-streaming) -----------------------------------------------------

/**
 * Render one sync chat GatewayResponse as an OpenAI `chat.completion` object.
 * `model` echoes the REQUESTED external name (GatewayResponse.model — the new
 * world routes offerings, never silently substitutes another model).
 */
export function renderChatCompletion(response: GatewayResponse): Record<string, unknown> {
  return renderChatCompletionOf(response.output, response.usage, response.model);
}

/** The chat.completion assembly, reusable for §5 idempotent replays (task-row output/usage). */
export function renderChatCompletionOf(
  output: unknown,
  usage: GatewayUsage | undefined,
  model: string,
): Record<string, unknown> {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: choicesOf(output),
    usage: openaiUsageOf(usage ?? { metrics: {}, billingDims: {}, estimated: true }),
  };
}

/** Dispatch the normalized chat output shape → OpenAI `choices[]`. */
function choicesOf(output: unknown): unknown[] {
  if (Array.isArray(output)) {
    const items: unknown[] = output;
    if (items.length === 0) return [];
    // openai dialect: output IS the choices array (items carry `message`).
    if (items.every((c) => isPlainObject(c) && 'message' in c)) {
      return items.map((choice, index) => ({
        index,
        ...(choice as Record<string, unknown>),
      }));
    }
    // anthropic dialect: output = the content blocks array (`type` discriminated).
    if (items.every((b) => isPlainObject(b) && 'type' in b)) {
      return [anthropicBlocksToChoice(items as Record<string, unknown>[])];
    }
  }
  // gemini dialect: output = { text, toolCalls?, finishReason? }.
  if (isPlainObject(output) && typeof output.text === 'string') {
    return [geminiOutputToChoice(output)];
  }
  const text = typeof output === 'string' ? output : JSON.stringify(output ?? null);
  return [textChoice(text, 'stop')];
}

function textChoice(content: string | null, finishReason: string): Record<string, unknown> {
  return { index: 0, message: { role: 'assistant', content }, finish_reason: finishReason };
}

function anthropicBlocksToChoice(blocks: Record<string, unknown>[]): Record<string, unknown> {
  const text = blocks
    .filter((b) => b.type === 'text')
    .map((b) => asStr(b.text) ?? '')
    .join('');
  const toolCalls = blocks
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({
      id: asStr(b.id) ?? `call_${randomUUID()}`,
      type: 'function',
      function: { name: asStr(b.name) ?? '', arguments: JSON.stringify(b.input ?? {}) },
    }));
  const message: Record<string, unknown> = {
    role: 'assistant',
    // OpenAI uses null content for pure tool-call turns.
    content: text.length === 0 && toolCalls.length > 0 ? null : text,
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return {
    index: 0,
    message,
    finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
  };
}

function geminiOutputToChoice(output: Record<string, unknown>): Record<string, unknown> {
  const calls = Array.isArray(output.toolCalls) ? output.toolCalls : [];
  const toolCalls = calls.filter(isPlainObject).map((call) => ({
    id: asStr(call.id) ?? `call_${asStr(call.name) ?? 'function'}`,
    type: 'function',
    function: { name: asStr(call.name) ?? '', arguments: JSON.stringify(call.args ?? {}) },
  }));
  const text = asStr(output.text) ?? '';
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: text.length === 0 && toolCalls.length > 0 ? null : text,
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return {
    index: 0,
    message,
    finish_reason:
      toolCalls.length > 0 ? 'tool_calls' : mapGeminiFinish(asStr(output.finishReason)),
  };
}

function mapGeminiFinish(reason: string | undefined): string {
  return reason === 'MAX_TOKENS' ? 'length' : 'stop';
}

// --- chat.completion.chunk (streaming) ----------------------------------------------------

/**
 * Render the IR StreamFrame sequence as OpenAI `chat.completion.chunk` SSE
 * strings. Stateful across frames (one id/created; role-opening delta exactly
 * once); `usage` frames are stashed and emitted as the empty-choices trailing
 * usage chunk after the finish chunk (the stream_options.include_usage wire
 * shape); a terminal `done` emits finish → usage → `data: [DONE]`; an `error`
 * frame emits the OpenAI error frame and ends WITHOUT [DONE] (v0.0.9 — SDKs
 * must never mistake a truncated stream for a clean stop).
 *
 * Delta payload shapes recognized (dialect aspect-⑤ authored, §6): a text
 * string; OpenAI `{tool_calls:[…]}` fragments (verbatim); anthropic
 * `{index, toolUse:{id,name}}` starts + `{index, argumentsDelta}` argument
 * slices; gemini `{functionCall:{name,args}}` whole calls. Unrecognized
 * object payloads are skipped (administrative), never a throw.
 */
export async function* renderChatCompletionChunks(
  frames: AsyncIterable<StreamFrame>,
  model: string,
): AsyncIterable<string> {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let roleSent = false;
  let sawToolCall = false;
  let geminiCallIndex = 0;
  let stashedUsage: GatewayUsage | undefined;

  const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
    sseData({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });

  function* openRole(): Generator<string> {
    if (!roleSent) {
      roleSent = true;
      yield chunk({ role: 'assistant', content: '' }, null);
    }
  }

  function* finishAndUsage(usage: GatewayUsage | undefined): Generator<string> {
    yield* openRole();
    yield chunk({}, sawToolCall ? 'tool_calls' : 'stop');
    const finalUsage = usage ?? stashedUsage;
    if (finalUsage !== undefined) {
      yield sseData({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [],
        usage: openaiUsageOf(finalUsage),
      });
    }
    yield 'data: [DONE]\n\n';
  }

  for await (const frame of frames) {
    switch (frame.kind) {
      case 'delta': {
        const rendered = deltaOf(frame.payload, () => geminiCallIndex++);
        if (rendered === undefined) break;
        if (rendered.tool_calls !== undefined) sawToolCall = true;
        yield* openRole();
        yield chunk(rendered, null);
        break;
      }
      case 'usage':
        stashedUsage = frame.usage;
        break;
      case 'done':
        yield* finishAndUsage(frame.usage);
        return;
      case 'error':
        yield sseData({
          error: {
            message: frame.error.message,
            type: openaiErrorTypeOf(frame.error.code),
            param: null,
            code: frame.error.code,
          },
        });
        return; // no [DONE] — the error frame terminates the stream.
    }
  }
  // Upstream ended without a done frame — close honestly (finish + [DONE]).
  yield* finishAndUsage(undefined);
}

/** One IR delta payload → an OpenAI chunk `delta` object (undefined = administrative, skip). */
function deltaOf(
  payload: unknown,
  nextGeminiIndex: () => number,
): Record<string, unknown> | undefined {
  if (typeof payload === 'string') {
    return payload.length > 0 ? { content: payload } : undefined;
  }
  if (!isPlainObject(payload)) return undefined;
  // openai dialect: verbatim chunk tool_calls fragments.
  if (Array.isArray(payload.tool_calls)) return { tool_calls: payload.tool_calls };
  // anthropic dialect: content_block_start (tool_use) → id+name opener.
  if (isPlainObject(payload.toolUse)) {
    const call: Record<string, unknown> = {
      index: typeof payload.index === 'number' ? payload.index : 0,
      type: 'function',
      function: { name: asStr(payload.toolUse.name) ?? '', arguments: '' },
    };
    const callId = asStr(payload.toolUse.id);
    if (callId !== undefined) call.id = callId;
    return { tool_calls: [call] };
  }
  // anthropic dialect: input_json_delta → arguments slice.
  if (typeof payload.argumentsDelta === 'string') {
    return {
      tool_calls: [
        {
          index: typeof payload.index === 'number' ? payload.index : 0,
          type: 'function',
          function: { arguments: payload.argumentsDelta },
        },
      ],
    };
  }
  // gemini dialect: whole functionCall per chunk.
  if (isPlainObject(payload.functionCall)) {
    const name = asStr(payload.functionCall.name) ?? 'function';
    return {
      tool_calls: [
        {
          index: nextGeminiIndex(),
          id: `call_${name}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(payload.functionCall.args ?? {}) },
        },
      ],
    };
  }
  return undefined;
}

function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

// --- embeddings list ------------------------------------------------------------------------

/**
 * Render one sync embeddings GatewayResponse as the OpenAI `list` wire shape.
 * The openai dialect's normalized output IS the upstream `data[]` (items
 * `{object,index,embedding}`); bare vectors (number[][]) are wrapped for
 * dialects that normalize to raw vectors. `usage` bills INPUT tokens only.
 */
export function renderEmbeddingsList(response: GatewayResponse): Record<string, unknown> {
  return renderEmbeddingsListOf(response.output, response.usage, response.model);
}

/** The embeddings `list` assembly, reusable for §5 idempotent replays (task-row output/usage). */
export function renderEmbeddingsListOf(
  output: unknown,
  usage: GatewayUsage | undefined,
  model: string,
): Record<string, unknown> {
  const raw: unknown[] = Array.isArray(output) ? output : [];
  const data = raw.map((item, index) => {
    if (isPlainObject(item) && 'embedding' in item) {
      return {
        object: 'embedding',
        index: typeof item.index === 'number' ? item.index : index,
        embedding: item.embedding,
      };
    }
    return { object: 'embedding', index, embedding: item };
  });
  const prompt = usage?.metrics.input_tokens ?? 0;
  return {
    object: 'list',
    data,
    model,
    usage: { prompt_tokens: prompt, total_tokens: prompt },
  };
}

// --- OpenAI error envelope --------------------------------------------------------------------

/** Frozen gateway taxonomy → the OpenAI wire error `type` string. */
export function openaiErrorTypeOf(code: string): string {
  switch (code) {
    case 'invalid_input':
    case 'unsupported_parameter':
    case 'model_not_found':
    case 'task_not_found':
    case 'conflict':
    case 'content_filtered':
      return 'invalid_request_error';
    case 'unauthorized':
      return 'authentication_error';
    case 'forbidden':
      return 'permission_error';
    case 'insufficient_credits':
      return 'insufficient_quota';
    case 'rate_limited':
      return 'rate_limit_error';
    default:
      return 'server_error';
  }
}

/**
 * Write one gateway error in the OpenAI `{error:{message,type,param,code}}`
 * envelope: HTTP status from the frozen taxonomy (conflict→409,
 * rate_limited→429 + Retry-After, model_not_found→404,
 * insufficient_credits→402, unsupported_parameter→400 …), the request id on
 * the `x-request-id` header (OpenAI wire convention — never in the body).
 */
export function sendOpenAIError(res: Response, error: GatewayError, requestId: string): void {
  const status = statusForGatewayError(error.code);
  if (status === 429 && error.retryAfterMs !== undefined) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))));
  }
  res.setHeader('x-request-id', requestId);
  res.status(status).json({
    error: {
      message: error.message,
      type: openaiErrorTypeOf(error.code),
      param: paramOf(error),
      code: error.code,
    },
  });
}

/** Surface the offending canonical param when the error carries one (§4 rule 4 details). */
function paramOf(error: GatewayError): string | null {
  const param = error.details?.param;
  return typeof param === 'string' ? param : null;
}
