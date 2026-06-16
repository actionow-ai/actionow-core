import type {
  ChatParams,
  ChatRequest,
  ContentPart,
  Message,
  ToolCall,
  ToolDef,
} from '@actionow/contracts';

const DEFAULT_MAX_TOKENS = 1024;

/**
 * Render an IR {@link ChatRequest} into an Anthropic Messages REQUEST body (the
 * inverse of `parseAnthropicChat`). Pure: no network, no SDK runtime. The IR's
 * camelCase shape is mapped to Anthropic's wire dialect.
 *
 * A leading `system`-role message is hoisted into the top-level `system` string
 * (Anthropic carries the system prompt outside `messages`). Non-system messages
 * become `{role, content: block[]}`: text→`{type:'text'}`, image→
 * `{type:'image', source:{...}}`, an assistant message's `toolCalls`→`tool_use`
 * blocks, and a `tool`-role message→a `user` message holding a `tool_result`
 * block. `tools`→`[{name, description?, input_schema}]`; `max_tokens` defaults
 * to {@link DEFAULT_MAX_TOKENS}.
 */
export function renderAnthropicRequest(ir: ChatRequest, model: string): Record<string, unknown> {
  let system: string | undefined;
  const messages: Record<string, unknown>[] = [];

  for (const message of ir.messages) {
    if (system === undefined && message.role === 'system') {
      system = collectText(message.content);
      continue;
    }
    messages.push(renderMessage(message));
  }

  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: ir.params?.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
  };

  if (system !== undefined) {
    body.system = system;
  }

  if (ir.tools !== undefined) {
    body.tools = ir.tools.map(renderTool);
  }

  const toolChoice = renderToolChoice(ir.toolChoice);
  if (toolChoice !== undefined) {
    body.tool_choice = toolChoice;
  }

  applyParams(body, ir.params);

  return body;
}

/** Join an IR content array's text parts into a single string. */
function collectText(content: ContentPart[]): string {
  return content.flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('');
}

/**
 * Map one IR {@link Message} → an Anthropic message object. A `tool`-role IR
 * message becomes a `user` message carrying a single `tool_result` block; other
 * roles map their content parts to blocks, with assistant `toolCalls` appended
 * as `tool_use` blocks.
 */
function renderMessage(message: Message): Record<string, unknown> {
  if (message.role === 'tool') {
    return { role: 'user', content: [renderToolResult(message)] };
  }

  const content: Record<string, unknown>[] = [];
  for (const part of message.content) {
    const block = renderContentPart(part);
    if (block !== undefined) {
      content.push(block);
    }
  }
  for (const call of message.toolCalls ?? []) {
    content.push(renderToolUse(call));
  }

  return { role: message.role, content };
}

/** Map a `tool`-role IR {@link Message} → an Anthropic `tool_result` block. */
function renderToolResult(message: Message): Record<string, unknown> {
  const block: Record<string, unknown> = {
    type: 'tool_result',
    content: collectText(message.content),
  };
  if (message.toolCallId !== undefined) {
    block.tool_use_id = message.toolCallId;
  }
  return block;
}

/** Map an IR {@link ToolCall} → an Anthropic `tool_use` block. */
function renderToolUse(call: ToolCall): Record<string, unknown> {
  return { type: 'tool_use', id: call.id, name: call.name, input: call.arguments };
}

/** Map one IR {@link ContentPart} → an Anthropic content block. */
function renderContentPart(part: ContentPart): Record<string, unknown> | undefined {
  if (part.kind === 'text') {
    return { type: 'text', text: part.text };
  }
  if (part.kind === 'image') {
    return { type: 'image', source: renderImageSource(part) };
  }
  return undefined;
}

/**
 * Map an IR image part → an Anthropic image `source`. A `base64` source carries
 * `media_type` + `data`; any other source maps to a `url` source.
 */
function renderImageSource(part: Extract<ContentPart, { kind: 'image' }>): Record<string, unknown> {
  if (part.source === 'base64') {
    const source: Record<string, unknown> = { type: 'base64', data: part.data };
    if (part.mime !== undefined) {
      source.media_type = part.mime;
    }
    return source;
  }
  return { type: 'url', url: part.data };
}

/** Map an IR {@link ToolDef} → an Anthropic `tools[]` entry. */
function renderTool(tool: ToolDef): Record<string, unknown> {
  const out: Record<string, unknown> = { name: tool.name, input_schema: tool.parameters };
  if (tool.description !== undefined) {
    out.description = tool.description;
  }
  return out;
}

/** Map an IR `toolChoice` → an Anthropic `tool_choice` object. */
function renderToolChoice(choice: ChatRequest['toolChoice']): Record<string, unknown> | undefined {
  if (choice === undefined) {
    return undefined;
  }
  if (choice === 'auto') {
    return { type: 'auto' };
  }
  if (choice === 'required') {
    return { type: 'any' };
  }
  if (choice === 'none') {
    // Anthropic has no explicit `none`; omit to fall back to the default.
    return undefined;
  }
  return { type: 'tool', name: choice.name };
}

/** Map IR {@link ChatParams} → Anthropic sampling fields on `body`. */
function applyParams(body: Record<string, unknown>, params: ChatParams | undefined): void {
  if (params === undefined) {
    return;
  }
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
