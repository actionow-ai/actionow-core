// apps/api/src/gateway/chat-ir-bridge.ts
//
// model-supply-greenfield 批次5 slice6 — the OUTPUT-side bridge from the new
// gateway IR (GatewayResponse / StreamFrame, §6 aspect-⑤ normalized shapes) to
// the llm-protocol chat IR (ChatResponse / ChatStreamEvent), so the Anthropic
// and Gemini surface renderers REUSE the existing llm-protocol dialect
// renderers verbatim (`renderAnthropicChat` / `renderAnthropicMessagesStream`
// / `renderGeminiChat` / `renderGeminiGenerateContentStream`) instead of
// re-deriving wire framing.
//
// `GatewayResponse.output` for chat is dialect-authored (§6): the openai
// dialect surfaces the `choices` array, the anthropic dialect the content
// blocks, the gemini dialect `{text, toolCalls?, finishReason?}`. This bridge
// recognizes those three shapes plus a bare string — the openai-render.ts
// dispatch, projected onto the IR instead of the OpenAI wire — and an
// unrecognized shape degrades to a JSON-stringified text message (never a
// throw, never a silent empty body).
import type {
  ChatResponse,
  ChatStreamEvent,
  ChatUsage,
  ContentPart,
  GatewayError,
  GatewayUsage,
  Message,
  StopReason,
  StreamFrame,
  ToolCall,
  UnifiedErrorCode,
} from '@actionow/contracts';
import { applyUsageBreakdown } from '@actionow/contracts';

// --- small structural readers -----------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const asStr = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

function parseArgs(raw: unknown): Record<string, unknown> {
  if (isPlainObject(raw)) return raw;
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isPlainObject(parsed)) return parsed;
    } catch {
      // fall through — malformed argument JSON degrades to {}.
    }
  }
  return {};
}

// --- usage (GatewayUsage metrics → IR ChatUsage) ------------------------------------------

/** snake_case metered vector (§9.2) → the IR camelCase usage (totals + breakdown). */
export function chatUsageOf(usage: GatewayUsage | undefined): ChatUsage {
  const metrics = usage?.metrics ?? {};
  return applyUsageBreakdown(
    {
      inputTokens: metrics.input_tokens ?? 0,
      outputTokens: metrics.output_tokens ?? 0,
    },
    metrics,
  );
}

// --- non-streaming output → ChatResponse ---------------------------------------------------

/**
 * One aspect-⑤ normalized chat output (+ usage) → the llm-protocol
 * {@link ChatResponse} IR the per-dialect non-streaming renderers consume.
 * Reusable for §5 idempotent replays (task-row output/usage).
 */
export function chatResponseOf(output: unknown, usage: GatewayUsage | undefined): ChatResponse {
  const { content, toolCalls, stopReason } = normalizeOutput(output);
  const message: Message = { role: 'assistant', content };
  if (toolCalls.length > 0) message.toolCalls = toolCalls;
  return { message, stopReason, usage: chatUsageOf(usage) };
}

interface NormalizedChatOutput {
  content: ContentPart[];
  toolCalls: ToolCall[];
  stopReason: StopReason;
}

function normalizeOutput(output: unknown): NormalizedChatOutput {
  if (Array.isArray(output) && output.length > 0) {
    const items: unknown[] = output;
    // openai dialect: output IS the choices array (items carry `message`).
    if (items.every((c) => isPlainObject(c) && 'message' in c)) {
      return fromOpenAIChoice(items[0] as Record<string, unknown>);
    }
    // anthropic dialect: output = the content blocks array (`type` discriminated).
    if (items.every((b) => isPlainObject(b) && 'type' in b)) {
      return fromAnthropicBlocks(items as Record<string, unknown>[]);
    }
  }
  // gemini dialect: output = { text, toolCalls?, finishReason? }.
  if (isPlainObject(output) && typeof output.text === 'string') {
    return fromGeminiOutput(output);
  }
  const text = typeof output === 'string' ? output : JSON.stringify(output ?? null);
  return { content: [{ kind: 'text', text }], toolCalls: [], stopReason: 'stop' };
}

function fromOpenAIChoice(choice: Record<string, unknown>): NormalizedChatOutput {
  const message = isPlainObject(choice.message) ? choice.message : {};
  const content: ContentPart[] = [];
  const text = asStr(message.content);
  if (text !== undefined && text.length > 0) content.push({ kind: 'text', text });

  const toolCalls: ToolCall[] = [];
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (!isPlainObject(call)) continue;
      const fn = isPlainObject(call.function) ? call.function : {};
      toolCalls.push({
        id: asStr(call.id) ?? `call_${String(toolCalls.length)}`,
        name: asStr(fn.name) ?? '',
        arguments: parseArgs(fn.arguments),
      });
    }
  }

  return { content, toolCalls, stopReason: mapOpenAIFinish(asStr(choice.finish_reason)) };
}

function mapOpenAIFinish(reason: string | undefined): StopReason {
  if (reason === 'length') return 'length';
  if (reason === 'tool_calls') return 'tool_calls';
  if (reason === 'content_filter') return 'content_filter';
  return 'stop';
}

function fromAnthropicBlocks(blocks: Record<string, unknown>[]): NormalizedChatOutput {
  const content: ContentPart[] = [];
  const toolCalls: ToolCall[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      content.push({ kind: 'text', text: asStr(block.text) ?? '' });
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: asStr(block.id) ?? `call_${String(toolCalls.length)}`,
        name: asStr(block.name) ?? '',
        arguments: isPlainObject(block.input) ? block.input : {},
      });
    }
  }
  return { content, toolCalls, stopReason: toolCalls.length > 0 ? 'tool_calls' : 'stop' };
}

function fromGeminiOutput(output: Record<string, unknown>): NormalizedChatOutput {
  const content: ContentPart[] = [];
  const text = asStr(output.text) ?? '';
  if (text.length > 0) content.push({ kind: 'text', text });

  const toolCalls: ToolCall[] = [];
  if (Array.isArray(output.toolCalls)) {
    for (const call of output.toolCalls) {
      if (!isPlainObject(call)) continue;
      const name = asStr(call.name) ?? '';
      toolCalls.push({
        id: asStr(call.id) ?? `call_${name}`,
        name,
        arguments: isPlainObject(call.args) ? call.args : parseArgs(call.arguments),
      });
    }
  }

  const stopReason: StopReason =
    toolCalls.length > 0
      ? 'tool_calls'
      : asStr(output.finishReason) === 'MAX_TOKENS'
        ? 'length'
        : 'stop';
  return { content, toolCalls, stopReason };
}

// --- StreamFrame → ChatStreamEvent ----------------------------------------------------------

/**
 * The IR StreamFrame sequence → llm-protocol {@link ChatStreamEvent}s, so the
 * per-dialect SSE renderers consume the new gateway's frames unchanged.
 * Delta payload shapes recognized (dialect aspect-⑤ authored, §6 — the
 * openai-render.ts `deltaOf` dispatch): a text string; OpenAI
 * `{tool_calls:[…]}` fragments; anthropic `{index, toolUse:{id,name}}` starts
 * + `{index, argumentsDelta}` slices; gemini `{functionCall:{name,args}}`
 * whole calls. Unrecognized object payloads are skipped (administrative).
 *
 * `message_start` is emitted lazily before the first content-bearing event
 * (execute()'s pre-commit guarantees the first frame is never an error);
 * a terminal `done` emits usage (when carried) then `stop`; an `error` frame
 * maps the gateway taxonomy onto the IR {@link UnifiedErrorCode} and ends the
 * event stream (each dialect renderer emits its own wire error frame). An
 * upstream end WITHOUT a done frame closes honestly with a `stop`.
 */
export async function* chatEventsOf(
  frames: AsyncIterable<StreamFrame>,
): AsyncIterable<ChatStreamEvent> {
  let started = false;
  let sawToolCall = false;
  let geminiCallIndex = 0;

  function* start(): Generator<ChatStreamEvent> {
    if (!started) {
      started = true;
      yield { type: 'message_start' };
    }
  }

  function* finish(usage: GatewayUsage | undefined): Generator<ChatStreamEvent> {
    yield* start();
    if (usage !== undefined) yield { type: 'usage', usage: chatUsageOf(usage) };
    yield { type: 'stop', stopReason: sawToolCall ? 'tool_calls' : 'stop' };
  }

  for await (const frame of frames) {
    switch (frame.kind) {
      case 'delta': {
        const events = deltaEventsOf(frame.payload, () => geminiCallIndex++);
        for (const event of events) {
          if (event.type === 'tool_call_delta') sawToolCall = true;
          yield* start();
          yield event;
        }
        break;
      }
      case 'usage':
        yield { type: 'usage', usage: chatUsageOf(frame.usage) };
        break;
      case 'done':
        yield* finish(frame.usage);
        return;
      case 'error':
        yield {
          type: 'error',
          error: {
            code: unifiedErrorCodeOf(frame.error.code),
            message: frame.error.message,
            retryable: frame.error.retryable,
          },
        };
        return;
    }
  }
  yield* finish(undefined);
}

/** One IR delta payload → zero or more chat events (empty = administrative, skip). */
function deltaEventsOf(payload: unknown, nextGeminiIndex: () => number): ChatStreamEvent[] {
  if (typeof payload === 'string') {
    return payload.length > 0 ? [{ type: 'content_delta', text: payload }] : [];
  }
  if (!isPlainObject(payload)) return [];
  // openai dialect: verbatim chunk tool_calls fragments.
  if (Array.isArray(payload.tool_calls)) {
    const events: ChatStreamEvent[] = [];
    for (const item of payload.tool_calls) {
      if (!isPlainObject(item)) continue;
      const fn = isPlainObject(item.function) ? item.function : {};
      const event: ChatStreamEvent = {
        type: 'tool_call_delta',
        index: typeof item.index === 'number' ? item.index : 0,
      };
      const id = asStr(item.id);
      if (id !== undefined) event.id = id;
      const name = asStr(fn.name);
      if (name !== undefined) event.name = name;
      const args = asStr(fn.arguments);
      if (args !== undefined) event.argumentsDelta = args;
      events.push(event);
    }
    return events;
  }
  // anthropic dialect: content_block_start (tool_use) → id+name opener.
  if (isPlainObject(payload.toolUse)) {
    const event: ChatStreamEvent = {
      type: 'tool_call_delta',
      index: typeof payload.index === 'number' ? payload.index : 0,
    };
    const id = asStr(payload.toolUse.id);
    if (id !== undefined) event.id = id;
    const name = asStr(payload.toolUse.name);
    if (name !== undefined) event.name = name;
    return [event];
  }
  // anthropic dialect: input_json_delta → arguments slice.
  if (typeof payload.argumentsDelta === 'string') {
    return [
      {
        type: 'tool_call_delta',
        index: typeof payload.index === 'number' ? payload.index : 0,
        argumentsDelta: payload.argumentsDelta,
      },
    ];
  }
  // gemini dialect: whole functionCall per chunk.
  if (isPlainObject(payload.functionCall)) {
    const name = asStr(payload.functionCall.name) ?? 'function';
    return [
      {
        type: 'tool_call_delta',
        index: nextGeminiIndex(),
        id: `call_${name}`,
        name,
        argumentsDelta: JSON.stringify(payload.functionCall.args ?? {}),
      },
    ];
  }
  return [];
}

/** Frozen gateway taxonomy → the IR {@link UnifiedErrorCode} the stream events carry. */
export function unifiedErrorCodeOf(code: GatewayError['code']): UnifiedErrorCode {
  switch (code) {
    case 'invalid_input':
    case 'unsupported_parameter':
    case 'conflict':
      return 'invalid_input';
    case 'unauthorized':
      return 'unauthorized';
    case 'forbidden':
      return 'forbidden';
    case 'model_not_found':
    case 'task_not_found':
      return 'resource_not_found';
    case 'insufficient_credits':
      return 'insufficient_credits';
    case 'rate_limited':
      return 'rate_limited';
    case 'content_filtered':
      return 'content_filtered';
    case 'upstream_error':
      return 'upstream_error';
    case 'upstream_timeout':
      return 'upstream_timeout';
    case 'task_failed':
      return 'job_failed';
    case 'internal_error':
      return 'internal_error';
  }
}
