import {
  type ChatParams,
  type ChatRequest,
  chatRequestSchema,
  type ContentPart,
  type Message,
  type ToolCall,
  type ToolDef,
} from '@actionow/contracts';

import { ProtocolError } from '../errors.js';
import { asArray, asNumber, asRecord, asString, parseJsonRecord } from '../internal/json.js';

/**
 * Parse an OpenAI ChatCompletions request body (typed `unknown`) into the
 * neutral IR `ChatRequest`. Pure: no network, no SDK runtime. Wire field names
 * (OpenAI's snake_case dialect) are mapped to the IR's camelCase shape.
 *
 * Throws `ProtocolError('invalid_input', ...)` when `messages` is missing/not an
 * array or any field fails the assembled-IR `chatRequestSchema` validation
 * (e.g. an unknown role).
 */
export function parseOpenAIChat(wire: unknown): ChatRequest {
  const body = asRecord(wire);
  const rawMessages = asArray(body?.messages);
  if (body === undefined || rawMessages === undefined) {
    throw new ProtocolError('invalid_input', 'openai request requires a "messages" array');
  }

  const messages = rawMessages.map(parseMessage);

  const ir: ChatRequest = {
    model: asString(body.model) ?? '',
    messages,
  };

  const tools = parseTools(body.tools);
  if (tools !== undefined) {
    ir.tools = tools;
  }

  const toolChoice = parseToolChoice(body.tool_choice);
  if (toolChoice !== undefined) {
    ir.toolChoice = toolChoice;
  }

  const params = parseParams(body);
  if (params !== undefined) {
    ir.params = params;
  }

  const result = chatRequestSchema.safeParse(ir);
  if (!result.success) {
    throw new ProtocolError('invalid_input', `invalid openai request: ${result.error.message}`);
  }
  return result.data;
}

/** Map one OpenAI message object → IR {@link Message}. */
function parseMessage(raw: unknown): Message {
  const rec = asRecord(raw);
  const message: Message = {
    // `role` is validated downstream by `chatRequestSchema`; pass through as-is.
    role: (asString(rec?.role) ?? '') as Message['role'],
    content: parseContent(rec?.content),
  };

  const toolCalls = parseToolCalls(rec?.tool_calls);
  if (toolCalls !== undefined) {
    message.toolCalls = toolCalls;
  }

  const toolCallId = asString(rec?.tool_call_id);
  if (toolCallId !== undefined) {
    message.toolCallId = toolCallId;
  }

  const name = asString(rec?.name);
  if (name !== undefined) {
    message.name = name;
  }

  return message;
}

/**
 * Map an OpenAI `content` (string, array of parts, or null) → IR content parts.
 * A string becomes a single text part; `null`/absent becomes an empty array.
 */
function parseContent(raw: unknown): ContentPart[] {
  const asStr = asString(raw);
  if (asStr !== undefined) {
    return [{ kind: 'text', text: asStr }];
  }

  const parts = asArray(raw);
  if (parts === undefined) {
    return [];
  }

  const out: ContentPart[] = [];
  for (const part of parts) {
    const mapped = parseContentPart(part);
    if (mapped !== undefined) {
      out.push(mapped);
    }
  }
  return out;
}

/** Map one OpenAI content-part object → IR {@link ContentPart}. */
function parseContentPart(raw: unknown): ContentPart | undefined {
  const rec = asRecord(raw);
  const type = asString(rec?.type);

  if (type === 'text') {
    return { kind: 'text', text: asString(rec?.text) ?? '' };
  }

  if (type === 'image_url') {
    const url = asString(recordImageUrl(rec)) ?? '';
    return parseImageUrl(url);
  }

  return undefined;
}

/** Read `image_url.url` from a content part (OpenAI nests the url one level). */
function recordImageUrl(rec: Record<string, unknown> | undefined): unknown {
  return asRecord(rec?.image_url)?.url;
}

/**
 * Map an OpenAI image url → IR image part. A `data:<mime>;base64,<data>` URL is
 * decoded to `source:'base64'` with its mime + payload extracted; any other URL
 * is passed through as `source:'url'`.
 */
function parseImageUrl(url: string): ContentPart {
  if (url.startsWith('data:')) {
    const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
    if (match) {
      return { kind: 'image', source: 'base64', data: match[2] ?? '', mime: match[1] };
    }
  }
  return { kind: 'image', source: 'url', data: url };
}

/** Map an OpenAI assistant `tool_calls[]` → IR {@link ToolCall}[]. */
function parseToolCalls(raw: unknown): ToolCall[] | undefined {
  const arr = asArray(raw);
  if (arr === undefined) {
    return undefined;
  }
  return arr.map((call): ToolCall => {
    const rec = asRecord(call);
    const fn = asRecord(rec?.function);
    return {
      id: asString(rec?.id) ?? '',
      name: asString(fn?.name) ?? '',
      arguments: parseJsonRecord(asString(fn?.arguments) ?? '') ?? {},
    };
  });
}

/** Map OpenAI `tools[].function` → IR {@link ToolDef}[]. */
function parseTools(raw: unknown): ToolDef[] | undefined {
  const arr = asArray(raw);
  if (arr === undefined) {
    return undefined;
  }
  return arr.map((tool): ToolDef => {
    const fn = asRecord(asRecord(tool)?.function);
    return {
      name: asString(fn?.name) ?? '',
      description: asString(fn?.description),
      parameters: asRecord(fn?.parameters) ?? {},
    };
  });
}

/** Map OpenAI `tool_choice` → IR `'auto'|'none'|'required'` or `{name}`. */
function parseToolChoice(raw: unknown): ChatRequest['toolChoice'] {
  const asStr = asString(raw);
  if (asStr === 'auto' || asStr === 'none' || asStr === 'required') {
    return asStr;
  }
  const name = asString(asRecord(asRecord(raw)?.function)?.name);
  if (name !== undefined) {
    return { name };
  }
  return undefined;
}

/** Map OpenAI sampling/format fields → IR {@link ChatParams}. */
function parseParams(body: Record<string, unknown>): ChatParams | undefined {
  const params: ChatParams = {};

  const temperature = asNumber(body.temperature);
  if (temperature !== undefined) {
    params.temperature = temperature;
  }

  const topP = asNumber(body.top_p);
  if (topP !== undefined) {
    params.topP = topP;
  }

  const maxOutputTokens = asNumber(body.max_tokens);
  if (maxOutputTokens !== undefined) {
    params.maxOutputTokens = maxOutputTokens;
  }

  const stop = asArray(body.stop)?.flatMap((s) => {
    const str = asString(s);
    return str === undefined ? [] : [str];
  });
  if (stop !== undefined) {
    params.stop = stop;
  }

  const seed = asNumber(body.seed);
  if (seed !== undefined) {
    params.seed = seed;
  }

  const responseFormat = asString(asRecord(body.response_format)?.type);
  if (
    responseFormat === 'text' ||
    responseFormat === 'json_object' ||
    responseFormat === 'json_schema'
  ) {
    params.responseFormat = responseFormat;
  }

  return Object.keys(params).length > 0 ? params : undefined;
}
