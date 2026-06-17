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
  // audio/file have no first-class OpenAI chat representation; pass text through.
  return { type: 'text', text: part.data };
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
  const body: Record<string, unknown> = {
    model: ctx.model ?? ir.model,
    messages: ir.messages.map(irMessageToOpenAi),
  };
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
      body.response_format = { type: params.responseFormat };
    }
  }
  return body;
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

    const usage = asRecord(asRecord(res.body)?.usage);
    return {
      message: irMessage,
      stopReason: mapFinishReason(asString(choice?.finish_reason)),
      usage: {
        inputTokens: asNumber(usage?.prompt_tokens) ?? 0,
        outputTokens: asNumber(usage?.completion_tokens) ?? 0,
      },
    };
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

      // A trailing chunk carries usage with an empty `choices` array.
      const usage = asRecord(obj.usage);
      if (usage !== undefined) {
        yield {
          type: 'usage',
          usage: {
            inputTokens: asNumber(usage.prompt_tokens) ?? 0,
            outputTokens: asNumber(usage.completion_tokens) ?? 0,
          },
        };
      }
    }

    yield { type: 'done' };
  },

  extractUsage,

  mapError(raw: unknown): UnifiedError {
    return mapErrorBody(500, raw);
  },
};
