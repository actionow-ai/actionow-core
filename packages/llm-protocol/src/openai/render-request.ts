import type {
  ChatParams,
  ChatRequest,
  ContentPart,
  Message,
  ToolCall,
  ToolDef,
} from '@actionow/contracts';

/**
 * Render an IR {@link ChatRequest} into an OpenAI ChatCompletions REQUEST body
 * (the inverse of `parseOpenAIChat`). Pure: no network, no SDK runtime. The IR's
 * camelCase shape is mapped to OpenAI's snake_case wire dialect.
 *
 * The system prompt stays a `system`-role message (OpenAI carries it inline).
 * Each `Message.content` collapses to a plain string when it holds only text
 * parts, or to an array of `{type:'text'|'image_url'}` parts when any non-text
 * part is present. `toolCalls`→`tool_calls`, `toolCallId`→`tool_call_id`,
 * `tools`→`[{type:'function', function:{...}}]`.
 */
export function renderOpenAIRequest(ir: ChatRequest, model: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: ir.messages.map(renderMessage),
  };

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

/** Map one IR {@link Message} → an OpenAI message object. */
function renderMessage(message: Message): Record<string, unknown> {
  const out: Record<string, unknown> = {
    role: message.role,
    content: renderContent(message.content),
  };

  if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
    out.tool_calls = message.toolCalls.map(renderToolCall);
  }

  if (message.toolCallId !== undefined) {
    out.tool_call_id = message.toolCallId;
  }

  if (message.name !== undefined) {
    out.name = message.name;
  }

  return out;
}

/**
 * Map IR content parts → an OpenAI `content`. Collapses to a plain string when
 * every part is text; otherwise emits an array of `{type:'text'|'image_url'}`
 * parts (non-text/-image parts are dropped, mirroring the parser's coverage).
 */
function renderContent(content: ContentPart[]): string | Record<string, unknown>[] {
  const hasNonText = content.some((part) => part.kind !== 'text');
  if (!hasNonText) {
    return content.flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('');
  }

  const out: Record<string, unknown>[] = [];
  for (const part of content) {
    const mapped = renderContentPart(part);
    if (mapped !== undefined) {
      out.push(mapped);
    }
  }
  return out;
}

/** Map one IR {@link ContentPart} → an OpenAI content-part object. */
function renderContentPart(part: ContentPart): Record<string, unknown> | undefined {
  if (part.kind === 'text') {
    return { type: 'text', text: part.text };
  }
  if (part.kind === 'image') {
    return { type: 'image_url', image_url: { url: renderImageUrl(part) } };
  }
  return undefined;
}

/**
 * Map an IR image part → an OpenAI `image_url.url`. A `base64` source becomes a
 * `data:<mime>;base64,<data>` URL; a `url`/`file_id` source passes its data
 * through.
 */
function renderImageUrl(part: Extract<ContentPart, { kind: 'image' }>): string {
  if (part.source === 'base64') {
    const mime = part.mime ?? 'application/octet-stream';
    return `data:${mime};base64,${part.data}`;
  }
  return part.data;
}

/** Map an IR {@link ToolCall} → an OpenAI assistant `tool_calls[]` entry. */
function renderToolCall(call: ToolCall): Record<string, unknown> {
  return {
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
  };
}

/** Map an IR {@link ToolDef} → an OpenAI `tools[]` entry. */
function renderTool(tool: ToolDef): Record<string, unknown> {
  const fn: Record<string, unknown> = { name: tool.name, parameters: tool.parameters };
  if (tool.description !== undefined) {
    fn.description = tool.description;
  }
  return { type: 'function', function: fn };
}

/** Map an IR `toolChoice` → an OpenAI `tool_choice`. */
function renderToolChoice(choice: ChatRequest['toolChoice']): unknown {
  if (choice === undefined) {
    return undefined;
  }
  if (typeof choice === 'string') {
    return choice;
  }
  return { type: 'function', function: { name: choice.name } };
}

/** Map IR {@link ChatParams} → OpenAI sampling/format fields on `body`. */
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
  if (params.maxOutputTokens !== undefined) {
    body.max_tokens = params.maxOutputTokens;
  }
  if (params.stop !== undefined) {
    body.stop = params.stop;
  }
  if (params.seed !== undefined) {
    body.seed = params.seed;
  }

  const responseFormat = renderResponseFormat(params);
  if (responseFormat !== undefined) {
    body.response_format = responseFormat;
  }
}

/** Map IR `responseFormat`/`jsonSchema` → an OpenAI `response_format` object. */
function renderResponseFormat(params: ChatParams): Record<string, unknown> | undefined {
  if (params.responseFormat === undefined) {
    return undefined;
  }
  if (params.responseFormat === 'json_schema' && params.jsonSchema !== undefined) {
    return { type: 'json_schema', json_schema: { schema: params.jsonSchema } };
  }
  return { type: params.responseFormat };
}
