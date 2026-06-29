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
import { asArray, asNumber, asRecord, asString, collectExtra } from '../internal/json.js';

/**
 * Top-level Anthropic body keys the parser already promotes to first-class IR
 * fields, plus transport/consumed keys the adapter rebuilds (`system` is hoisted
 * into a leading IR message — it must NOT re-enter the body via `extra`).
 * `thinking`/`output_config` carry reasoning controls the parser lifts into
 * `params.reasoning*` and the adapter re-emits, so they are excluded too.
 * Anything else (top_k, metadata, container, service_tier, cache_control, …)
 * sweeps into `ir.extra`.
 */
const ANTHROPIC_KNOWN_KEYS: ReadonlySet<string> = new Set([
  'model',
  'messages',
  'system',
  'stream',
  'tools',
  'tool_choice',
  'temperature',
  'top_p',
  'max_tokens',
  'stop_sequences',
  'thinking',
  'output_config',
]);

/** Map an Anthropic `output_config.effort` string to the normalized IR enum. */
function parseEffort(raw: unknown): ChatParams['reasoningEffort'] {
  const v = asString(raw);
  // Anthropic adds `max` (above xhigh); clamp it to the IR's top `xhigh`.
  if (v === 'max') return 'xhigh';
  if (v === 'low' || v === 'medium' || v === 'high' || v === 'xhigh' || v === 'minimal') {
    return v;
  }
  return undefined;
}

/**
 * Parse an Anthropic Messages request body (typed `unknown`) into the neutral
 * IR `ChatRequest`. Pure: no network, no SDK runtime. Anthropic's wire dialect
 * is mapped to the IR's camelCase shape.
 *
 * Anthropic carries the system prompt as a top-level `system` (a string OR an
 * array of `{type:'text',text}` blocks), NOT as a message — it is hoisted into
 * a leading system-role IR message. A `tool_use` content block becomes the
 * assistant message's `toolCalls`; a `tool_result` block becomes its own IR
 * `tool`-role message.
 *
 * Throws `ProtocolError('invalid_input', ...)` when `messages` is missing/not an
 * array or any field fails the assembled-IR `chatRequestSchema` validation
 * (e.g. an unknown role).
 */
export function parseAnthropicChat(wire: unknown): ChatRequest {
  const body = asRecord(wire);
  const rawMessages = asArray(body?.messages);
  if (body === undefined || rawMessages === undefined) {
    throw new ProtocolError('invalid_input', 'anthropic request requires a "messages" array');
  }

  const messages: Message[] = [];

  const systemText = parseSystem(body.system);
  if (systemText !== undefined) {
    messages.push({ role: 'system', content: [{ kind: 'text', text: systemText }] });
  }

  for (const raw of rawMessages) {
    messages.push(...parseMessage(raw));
  }

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

  const extra = collectExtra(body, ANTHROPIC_KNOWN_KEYS);
  if (extra !== undefined) {
    ir.extra = extra;
  }

  const result = chatRequestSchema.safeParse(ir);
  if (!result.success) {
    throw new ProtocolError('invalid_input', `invalid anthropic request: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Read the top-level `system` (a string or an array of `{type:'text',text}`
 * blocks) into a single string. Returns `undefined` when absent/empty.
 */
function parseSystem(raw: unknown): string | undefined {
  const asStr = asString(raw);
  if (asStr !== undefined) {
    return asStr;
  }
  const blocks = asArray(raw);
  if (blocks === undefined) {
    return undefined;
  }
  const text = blocks
    .flatMap((block) => {
      const t = asString(asRecord(block)?.text);
      return t === undefined ? [] : [t];
    })
    .join('');
  return text.length > 0 ? text : undefined;
}

/**
 * Map one Anthropic message → one or more IR {@link Message}s. A `tool_result`
 * block is hoisted into its own `tool`-role message; the remaining blocks form
 * the original message (with any `tool_use` blocks collected as `toolCalls`).
 */
function parseMessage(raw: unknown): Message[] {
  const rec = asRecord(raw);
  // `role` is validated downstream by `chatRequestSchema`; pass through as-is.
  const role = (asString(rec?.role) ?? '') as Message['role'];

  const contentStr = asString(rec?.content);
  if (contentStr !== undefined) {
    return [{ role, content: [{ kind: 'text', text: contentStr }] }];
  }

  const blocks = asArray(rec?.content);
  if (blocks === undefined) {
    return [{ role, content: [] }];
  }

  const out: Message[] = [];
  const content: ContentPart[] = [];
  const toolCalls: ToolCall[] = [];

  for (const block of blocks) {
    const blockRec = asRecord(block);
    const type = asString(blockRec?.type);

    if (type === 'tool_result') {
      out.push(parseToolResult(blockRec));
      continue;
    }

    if (type === 'tool_use') {
      toolCalls.push({
        id: asString(blockRec?.id) ?? '',
        name: asString(blockRec?.name) ?? '',
        arguments: asRecord(blockRec?.input) ?? {},
      });
      continue;
    }

    const part = parseContentPart(blockRec, type);
    if (part !== undefined) {
      content.push(part);
    }
  }

  // Drop an empty carrier (e.g. a user turn that held only tool_result blocks),
  // so a hoisted tool message takes the slot rather than trailing an empty one.
  if (content.length === 0 && toolCalls.length === 0 && out.length > 0) {
    return out;
  }

  const message: Message = { role, content };
  if (toolCalls.length > 0) {
    message.toolCalls = toolCalls;
  }
  // The carrier message leads; hoisted tool_result messages follow.
  return [message, ...out];
}

/** Map an Anthropic `tool_result` block → an IR `tool`-role {@link Message}. */
function parseToolResult(rec: Record<string, unknown> | undefined): Message {
  return {
    role: 'tool',
    content: parseToolResultContent(rec?.content),
    toolCallId: asString(rec?.tool_use_id) ?? '',
  };
}

/**
 * Map a `tool_result` `content` (a string or an array of text blocks) → IR
 * content parts.
 */
function parseToolResultContent(raw: unknown): ContentPart[] {
  const asStr = asString(raw);
  if (asStr !== undefined) {
    return [{ kind: 'text', text: asStr }];
  }
  const blocks = asArray(raw);
  if (blocks === undefined) {
    return [];
  }
  return blocks.flatMap((block) => {
    const t = asString(asRecord(block)?.text);
    return t === undefined ? [] : [{ kind: 'text', text: t } satisfies ContentPart];
  });
}

/** Map one non-tool Anthropic content block → IR {@link ContentPart}. */
function parseContentPart(
  rec: Record<string, unknown> | undefined,
  type: string | undefined,
): ContentPart | undefined {
  if (type === 'text') {
    return { kind: 'text', text: asString(rec?.text) ?? '' };
  }
  if (type === 'image') {
    return parseImage(asRecord(rec?.source));
  }
  return undefined;
}

/**
 * Map an Anthropic image `source` → IR image part. A `base64` source carries
 * `media_type` + `data`; a `url` source carries `url`.
 */
function parseImage(source: Record<string, unknown> | undefined): ContentPart | undefined {
  const sourceType = asString(source?.type);
  if (sourceType === 'base64') {
    const part: ContentPart = {
      kind: 'image',
      source: 'base64',
      data: asString(source?.data) ?? '',
    };
    const mime = asString(source?.media_type);
    if (mime !== undefined) {
      part.mime = mime;
    }
    return part;
  }
  if (sourceType === 'url') {
    return { kind: 'image', source: 'url', data: asString(source?.url) ?? '' };
  }
  return undefined;
}

/** Map Anthropic `tools[]` (`name`/`description`/`input_schema`) → IR {@link ToolDef}[]. */
function parseTools(raw: unknown): ToolDef[] | undefined {
  const arr = asArray(raw);
  if (arr === undefined) {
    return undefined;
  }
  return arr.map((tool): ToolDef => {
    const rec = asRecord(tool);
    return {
      name: asString(rec?.name) ?? '',
      description: asString(rec?.description),
      parameters: asRecord(rec?.input_schema) ?? {},
    };
  });
}

/**
 * Map Anthropic `tool_choice` (`{type:'auto'|'any'|'tool', name?}`) → IR
 * `'auto'`/`'required'` or `{name}`.
 */
function parseToolChoice(raw: unknown): ChatRequest['toolChoice'] {
  const rec = asRecord(raw);
  const type = asString(rec?.type);
  if (type === 'auto') {
    return 'auto';
  }
  if (type === 'any') {
    return 'required';
  }
  if (type === 'tool') {
    const name = asString(rec?.name);
    if (name !== undefined) {
      return { name };
    }
  }
  return undefined;
}

/** Map Anthropic sampling fields → IR {@link ChatParams}. */
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

  const stop = asArray(body.stop_sequences)?.flatMap((s) => {
    const str = asString(s);
    return str === undefined ? [] : [str];
  });
  if (stop !== undefined) {
    params.stop = stop;
  }

  // Reasoning: a `thinking.budget_tokens` budget takes precedence; otherwise the
  // `output_config.effort` enum (both lifted off the body so the adapter re-emits
  // them from the normalized IR rather than leaking the raw shapes via `extra`).
  const budget = asNumber(asRecord(body.thinking)?.budget_tokens);
  if (budget !== undefined && budget > 0) {
    params.reasoningBudgetTokens = budget;
  }
  const effort = parseEffort(asRecord(body.output_config)?.effort);
  if (effort !== undefined) {
    params.reasoningEffort = effort;
  }

  return Object.keys(params).length > 0 ? params : undefined;
}
