import type {
  ChatParams,
  ChatRequest,
  ContentPart,
  Message,
  ToolCall,
  ToolDef,
} from '@actionow/contracts';

/**
 * Render an IR {@link ChatRequest} into a Gemini `generateContent` REQUEST body
 * (the inverse of `parseGeminiChat`). Pure: no network, no SDK runtime. Takes NO
 * `model` argument — Gemini carries the model in the request URL path, not the
 * body.
 *
 * A leading `system`-role message is hoisted into the top-level
 * `systemInstruction:{parts:[{text}]}`. Non-system messages become
 * `contents:[{role, parts:[...]}]` with the IR `assistant` role mapped to
 * Gemini's `model` role: text→`{text}`, base64 image→`{inlineData}`,
 * `toolCalls`→`{functionCall}`, and a `tool`-role message→a `user` turn holding
 * a `{functionResponse}` part. `tools`→`[{functionDeclarations:[...]}]`.
 */
export function renderGeminiRequest(ir: ChatRequest): Record<string, unknown> {
  let systemInstruction: Record<string, unknown> | undefined;
  const contents: Record<string, unknown>[] = [];

  for (const message of ir.messages) {
    if (systemInstruction === undefined && message.role === 'system') {
      systemInstruction = { parts: [{ text: collectText(message.content) }] };
      continue;
    }
    contents.push(renderContent(message));
  }

  const body: Record<string, unknown> = { contents };

  if (systemInstruction !== undefined) {
    body.systemInstruction = systemInstruction;
  }

  if (ir.tools !== undefined) {
    body.tools = [{ functionDeclarations: ir.tools.map(renderTool) }];
  }

  const toolConfig = renderToolConfig(ir.toolChoice);
  if (toolConfig !== undefined) {
    body.toolConfig = toolConfig;
  }

  const generationConfig = renderGenerationConfig(ir.params);
  if (generationConfig !== undefined) {
    body.generationConfig = generationConfig;
  }

  return body;
}

/** Join an IR content array's text parts into a single string. */
function collectText(content: ContentPart[]): string {
  return content.flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('');
}

/** Map the IR role to a Gemini content role (`assistant` → `model`). */
function toWireRole(role: Message['role']): string {
  return role === 'assistant' ? 'model' : 'user';
}

/**
 * Map one IR {@link Message} → a Gemini `contents[]` turn. A `tool`-role IR
 * message becomes a `user` turn carrying a single `functionResponse` part;
 * other roles map their parts (and any assistant `toolCalls`) to Gemini parts.
 */
function renderContent(message: Message): Record<string, unknown> {
  if (message.role === 'tool') {
    return { role: 'user', parts: [renderFunctionResponse(message)] };
  }

  const parts: Record<string, unknown>[] = [];
  for (const part of message.content) {
    const mapped = renderContentPart(part);
    if (mapped !== undefined) {
      parts.push(mapped);
    }
  }
  for (const call of message.toolCalls ?? []) {
    parts.push(renderFunctionCall(call));
  }

  return { role: toWireRole(message.role), parts };
}

/**
 * Map a `tool`-role IR {@link Message} → a Gemini `functionResponse` part. The
 * tool text content (a JSON-stringified result from the parser) is decoded back
 * to an object when possible; otherwise it is wrapped under a `result` key.
 */
function renderFunctionResponse(message: Message): Record<string, unknown> {
  const text = collectText(message.content);
  return {
    functionResponse: {
      name: message.name ?? '',
      response: decodeResponse(text),
    },
  };
}

/** Decode a tool-result string to an object, wrapping non-objects under `result`. */
function decodeResponse(text: string): Record<string, unknown> {
  if (text.length === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { result: parsed };
  } catch {
    return { result: text };
  }
}

/** Map an IR {@link ToolCall} → a Gemini `functionCall` part. */
function renderFunctionCall(call: ToolCall): Record<string, unknown> {
  return { functionCall: { name: call.name, args: call.arguments } };
}

/** Map one IR {@link ContentPart} → a Gemini part. */
function renderContentPart(part: ContentPart): Record<string, unknown> | undefined {
  if (part.kind === 'text') {
    return { text: part.text };
  }
  if (part.kind === 'image' && part.source === 'base64') {
    const inlineData: Record<string, unknown> = { data: part.data };
    if (part.mime !== undefined) {
      inlineData.mimeType = part.mime;
    }
    return { inlineData };
  }
  if (part.kind === 'file' && part.source === 'url') {
    const fileData: Record<string, unknown> = { fileUri: part.data };
    if (part.mime !== undefined) {
      fileData.mimeType = part.mime;
    }
    return { fileData };
  }
  return undefined;
}

/** Map an IR {@link ToolDef} → a Gemini `functionDeclarations[]` entry. */
function renderTool(tool: ToolDef): Record<string, unknown> {
  const out: Record<string, unknown> = { name: tool.name, parameters: tool.parameters };
  if (tool.description !== undefined) {
    out.description = tool.description;
  }
  return out;
}

/** Map an IR `toolChoice` → a Gemini `toolConfig.functionCallingConfig`. */
function renderToolConfig(choice: ChatRequest['toolChoice']): Record<string, unknown> | undefined {
  if (choice === undefined || typeof choice !== 'string') {
    return undefined;
  }
  const mode = choice === 'auto' ? 'AUTO' : choice === 'required' ? 'ANY' : 'NONE';
  return { functionCallingConfig: { mode } };
}

/** Map IR {@link ChatParams} → a Gemini `generationConfig`. */
function renderGenerationConfig(
  params: ChatParams | undefined,
): Record<string, unknown> | undefined {
  if (params === undefined) {
    return undefined;
  }
  const config: Record<string, unknown> = {};

  if (params.temperature !== undefined) {
    config.temperature = params.temperature;
  }
  if (params.topP !== undefined) {
    config.topP = params.topP;
  }
  if (params.maxOutputTokens !== undefined) {
    config.maxOutputTokens = params.maxOutputTokens;
  }
  if (params.stop !== undefined) {
    config.stopSequences = params.stop;
  }
  if (params.responseFormat === 'json_object' || params.responseFormat === 'json_schema') {
    config.responseMimeType = 'application/json';
  }

  return Object.keys(config).length > 0 ? config : undefined;
}
