import type {
  AdapterContext,
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  ContentPart,
  Message,
  StopReason,
  StreamEvent,
  SubmitInput,
  SubmitResult,
  ToolCall,
  UnifiedError,
  UsageVector,
} from '@actionow/contracts';

import { AdapterError, httpStatusToUnified } from './errors.js';
import { asArray, asNumber, asRecord, asString, parseJsonRecord } from './internal/json.js';
import { parseSse } from './internal/sse.js';
import { openStream, streamErrorEvent } from './internal/stream.js';
import type { AdapterCapabilities, ProviderAdapter } from './types.js';

const PROVIDER = 'anthropic';
const DEFAULT_ENDPOINT = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 1024;

/** Spread `proxyUrl` into a request when the channel set one. */
function withProxy(ctx: AdapterContext): { proxyUrl?: string } {
  return ctx.proxyUrl === undefined ? {} : { proxyUrl: ctx.proxyUrl };
}

const CAPABILITIES: AdapterCapabilities = {
  tools: true,
  vision: true,
  audio: false,
  json: false,
  stream: true,
};

/** Join all text parts of an IR message into one string. */
function joinText(content: ContentPart[]): string {
  return content
    .filter((p): p is Extract<ContentPart, { kind: 'text' }> => p.kind === 'text')
    .map((p) => p.text)
    .join('');
}

/** Map an IR content part to an Anthropic content block. */
function irPartToBlock(part: ContentPart): Record<string, unknown> {
  if (part.kind === 'text') {
    return { type: 'text', text: part.text };
  }
  if (part.kind === 'image') {
    if (part.source === 'url') {
      return { type: 'image', source: { type: 'url', url: part.data } };
    }
    return {
      type: 'image',
      source: { type: 'base64', media_type: part.mime ?? 'image/png', data: part.data },
    };
  }
  return { type: 'text', text: part.data };
}

/** Build the Anthropic `messages[]` (system is hoisted to a top-level param). */
function irMessageToAnthropic(msg: Message): Record<string, unknown> {
  if (msg.role === 'tool') {
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: msg.toolCallId ?? '',
          content: joinText(msg.content),
        },
      ],
    };
  }

  const blocks: Record<string, unknown>[] = msg.content.map(irPartToBlock);
  if (msg.toolCalls !== undefined) {
    for (const call of msg.toolCalls) {
      blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
    }
  }
  return { role: msg.role === 'assistant' ? 'assistant' : 'user', content: blocks };
}

/** Translate an IR `ChatRequest` into an Anthropic messages body. */
function buildChatBody(
  ir: ChatRequest,
  ctx: AdapterContext,
  stream: boolean,
): Record<string, unknown> {
  const systemTexts: string[] = [];
  const turns: Message[] = [];
  for (const m of ir.messages) {
    if (m.role === 'system') {
      systemTexts.push(joinText(m.content));
    } else {
      turns.push(m);
    }
  }

  const body: Record<string, unknown> = {
    model: ctx.model ?? ir.model,
    max_tokens: ir.params?.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
    messages: turns.map(irMessageToAnthropic),
  };
  if (stream) {
    body.stream = true;
  }
  if (systemTexts.length > 0) {
    body.system = systemTexts.join('\n');
  }
  if (ir.tools !== undefined && ir.tools.length > 0) {
    body.tools = ir.tools.map((t) => {
      const tool: Record<string, unknown> = { name: t.name, input_schema: t.parameters };
      if (t.description !== undefined) {
        tool.description = t.description;
      }
      return tool;
    });
  }
  if (ir.toolChoice !== undefined) {
    body.tool_choice =
      typeof ir.toolChoice === 'string'
        ? { type: ir.toolChoice === 'required' ? 'any' : ir.toolChoice }
        : { type: 'tool', name: ir.toolChoice.name };
  }
  const params = ir.params;
  if (params !== undefined) {
    if (params.temperature !== undefined) {
      body.temperature = params.temperature;
    }
    if (params.topP !== undefined) {
      body.top_p = params.topP;
    }
    if (params.stop !== undefined) {
      body.stop_sequences = params.stop;
    }
  }
  return body;
}

/** Map an Anthropic `stop_reason` to an IR {@link StopReason}. */
function mapStopReason(raw: string | undefined): StopReason {
  switch (raw) {
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    default:
      return 'stop';
  }
}

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
  capabilities: CAPABILITIES,

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
      ...withProxy(ctx),
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

  async *stream(input: SubmitInput, ctx: AdapterContext): AsyncIterable<StreamEvent> {
    const messages = buildMessages(input.inputs);
    const endpoint = ctx.endpoint ?? DEFAULT_ENDPOINT;

    const body: Record<string, unknown> = {
      model: ctx.model,
      max_tokens: asNumber(input.inputs.max_tokens) ?? DEFAULT_MAX_TOKENS,
      messages,
      stream: true,
    };
    const system = asString(input.inputs.system);
    if (system !== undefined) {
      body.system = system;
    }

    const res = await openStream(ctx, PROVIDER, {
      method: 'POST',
      url: `${endpoint}/v1/messages`,
      headers: {
        'x-api-key': ctx.apiKey ?? '',
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body,
      ...withProxy(ctx),
    });

    if (!res.ok) {
      yield streamErrorEvent(PROVIDER, res.status);
      return;
    }

    let inputTokens = 0;
    let outputTokens = 0;

    for await (const frame of parseSse(res.lines)) {
      const obj = parseJsonRecord(frame.data);
      if (obj === undefined) {
        continue;
      }
      const type = asString(obj.type);

      if (type === 'message_start') {
        // input_tokens (and an initial output count) live on message.usage.
        const usage = asRecord(asRecord(obj.message)?.usage);
        inputTokens = asNumber(usage?.input_tokens) ?? inputTokens;
        outputTokens = asNumber(usage?.output_tokens) ?? outputTokens;
      } else if (type === 'content_block_delta') {
        const text = asString(asRecord(obj.delta)?.text);
        if (text !== undefined && text.length > 0) {
          yield { kind: 'delta', text };
        }
      } else if (type === 'message_delta') {
        // Anthropic reports cumulative output_tokens here; the last wins.
        const out = asNumber(asRecord(obj.usage)?.output_tokens);
        if (out !== undefined) {
          outputTokens = out;
        }
      }
      // message_stop / ping / content_block_start|stop carry no usage/delta.
    }

    const usage: UsageVector = { input_tokens: inputTokens, output_tokens: outputTokens };
    yield { kind: 'usage', usage };
    yield { kind: 'done', usage };
  },

  async chat(ir: ChatRequest, ctx: AdapterContext): Promise<ChatResponse> {
    const endpoint = ctx.endpoint ?? DEFAULT_ENDPOINT;
    const body = buildChatBody(ir, ctx, false);

    const res = await ctx.http.request({
      method: 'POST',
      url: `${endpoint}/v1/messages`,
      headers: {
        'x-api-key': ctx.apiKey ?? '',
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body,
      ...withProxy(ctx),
    });

    if (!res.ok) {
      throw new AdapterError(mapErrorBody(res.status, res.body));
    }

    const blocks = asArray(asRecord(res.body)?.content) ?? [];
    const content: ContentPart[] = [];
    const toolCalls: ToolCall[] = [];
    for (const block of blocks) {
      const rec = asRecord(block);
      const type = asString(rec?.type);
      if (type === 'text') {
        const text = asString(rec?.text);
        if (text !== undefined) {
          content.push({ kind: 'text', text });
        }
      } else if (type === 'tool_use') {
        const name = asString(rec?.name);
        if (name !== undefined) {
          toolCalls.push({
            id: asString(rec?.id) ?? '',
            name,
            arguments: asRecord(rec?.input) ?? {},
          });
        }
      }
    }

    const irMessage: Message = { role: 'assistant', content };
    if (toolCalls.length > 0) {
      irMessage.toolCalls = toolCalls;
    }

    const usage = asRecord(asRecord(res.body)?.usage);
    return {
      message: irMessage,
      stopReason: mapStopReason(asString(asRecord(res.body)?.stop_reason)),
      usage: {
        inputTokens: asNumber(usage?.input_tokens) ?? 0,
        outputTokens: asNumber(usage?.output_tokens) ?? 0,
      },
    };
  },

  async *streamChat(ir: ChatRequest, ctx: AdapterContext): AsyncIterable<ChatStreamEvent> {
    const endpoint = ctx.endpoint ?? DEFAULT_ENDPOINT;
    const body = buildChatBody(ir, ctx, true);

    const res = await openStream(ctx, PROVIDER, {
      method: 'POST',
      url: `${endpoint}/v1/messages`,
      headers: {
        'x-api-key': ctx.apiKey ?? '',
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body,
      ...withProxy(ctx),
    });

    if (!res.ok) {
      yield { type: 'error', error: httpStatusToUnified(PROVIDER, res.status) };
      return;
    }

    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: StopReason = 'stop';

    for await (const frame of parseSse(res.lines)) {
      const obj = parseJsonRecord(frame.data);
      if (obj === undefined) {
        continue;
      }
      const type = asString(obj.type);

      if (type === 'message_start') {
        yield { type: 'message_start' };
        const usage = asRecord(asRecord(obj.message)?.usage);
        inputTokens = asNumber(usage?.input_tokens) ?? inputTokens;
        outputTokens = asNumber(usage?.output_tokens) ?? outputTokens;
      } else if (type === 'content_block_start') {
        const cb = asRecord(obj.content_block);
        if (asString(cb?.type) === 'tool_use') {
          const event: Extract<ChatStreamEvent, { type: 'tool_call_delta' }> = {
            type: 'tool_call_delta',
            index: asNumber(obj.index) ?? 0,
          };
          const id = asString(cb?.id);
          if (id !== undefined) {
            event.id = id;
          }
          const name = asString(cb?.name);
          if (name !== undefined) {
            event.name = name;
          }
          yield event;
        }
      } else if (type === 'content_block_delta') {
        const delta = asRecord(obj.delta);
        const deltaType = asString(delta?.type);
        if (deltaType === 'text_delta') {
          const text = asString(delta?.text);
          if (text !== undefined && text.length > 0) {
            yield { type: 'content_delta', text };
          }
        } else if (deltaType === 'input_json_delta') {
          const partial = asString(delta?.partial_json);
          if (partial !== undefined) {
            yield {
              type: 'tool_call_delta',
              index: asNumber(obj.index) ?? 0,
              argumentsDelta: partial,
            };
          }
        }
      } else if (type === 'message_delta') {
        const reason = asString(asRecord(obj.delta)?.stop_reason);
        if (reason !== undefined) {
          stopReason = mapStopReason(reason);
        }
        const out = asNumber(asRecord(obj.usage)?.output_tokens);
        if (out !== undefined) {
          outputTokens = out;
        }
      } else if (type === 'message_stop') {
        yield { type: 'stop', stopReason };
        yield { type: 'usage', usage: { inputTokens, outputTokens } };
        yield { type: 'done' };
        return;
      }
      // ping / content_block_stop carry no usage/delta.
    }

    // Defensive: emit terminal events if the stream ended without message_stop.
    yield { type: 'stop', stopReason };
    yield { type: 'usage', usage: { inputTokens, outputTokens } };
    yield { type: 'done' };
  },

  extractUsage,

  mapError(raw: unknown): UnifiedError {
    return mapErrorBody(500, raw);
  },
};
