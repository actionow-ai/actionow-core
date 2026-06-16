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
import { asArray, asNumber, asRecord, asString } from '../internal/json.js';

/**
 * Parse a Gemini `generateContent` request body (typed `unknown`) into the
 * neutral IR `ChatRequest`. Pure: no network, no SDK runtime. Gemini's wire
 * dialect is mapped to the IR's camelCase shape.
 *
 * The `model` is supplied separately because Gemini carries it in the request
 * URL path (`/v1beta/models/{model}:generateContent`), not the body.
 *
 * Gemini carries the system prompt as a top-level `systemInstruction` (a
 * `{parts:[{text}]}` object), NOT as a turn — it is hoisted into a leading
 * system-role IR message. Gemini's `model` role maps to the IR `assistant`
 * role; `user` stays `user`. A `functionCall` part becomes the message's
 * `toolCalls` (Gemini carries no call id, so a stable `call_<name>_<index>` id
 * is synthesized); a `functionResponse` part becomes its own `tool`-role IR
 * message whose `toolCallId` references the most recent matching synthesized id.
 *
 * Throws `ProtocolError('invalid_input', ...)` when `contents` is missing/not an
 * array or any field fails the assembled-IR `chatRequestSchema` validation
 * (e.g. an unknown role).
 */
export function parseGeminiChat(wire: unknown, model: string): ChatRequest {
  const body = asRecord(wire);
  const rawContents = asArray(body?.contents);
  if (body === undefined || rawContents === undefined) {
    throw new ProtocolError('invalid_input', 'gemini request requires a "contents" array');
  }

  const messages: Message[] = [];

  const systemText = parseSystemInstruction(body.systemInstruction);
  if (systemText !== undefined) {
    messages.push({ role: 'system', content: [{ kind: 'text', text: systemText }] });
  }

  // Track synthesized tool-call ids by function name so a later
  // `functionResponse` can reference the matching call.
  const callIdsByName = new Map<string, string>();
  for (const raw of rawContents) {
    messages.push(...parseContent(raw, callIdsByName));
  }

  const ir: ChatRequest = {
    model,
    messages,
  };

  const tools = parseTools(body.tools);
  if (tools !== undefined) {
    ir.tools = tools;
  }

  const toolChoice = parseToolChoice(body.toolConfig);
  if (toolChoice !== undefined) {
    ir.toolChoice = toolChoice;
  }

  const params = parseParams(asRecord(body.generationConfig));
  if (params !== undefined) {
    ir.params = params;
  }

  const result = chatRequestSchema.safeParse(ir);
  if (!result.success) {
    throw new ProtocolError('invalid_input', `invalid gemini request: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Read the top-level `systemInstruction` ({@code {parts:[{text}]}}) into a
 * single string. Returns `undefined` when absent/empty.
 */
function parseSystemInstruction(raw: unknown): string | undefined {
  const parts = asArray(asRecord(raw)?.parts);
  if (parts === undefined) {
    return undefined;
  }
  const text = parts
    .flatMap((part) => {
      const t = asString(asRecord(part)?.text);
      return t === undefined ? [] : [t];
    })
    .join('');
  return text.length > 0 ? text : undefined;
}

/** Map a Gemini content role to an IR role (`model` → `assistant`). */
function toIrRole(role: string | undefined): Message['role'] {
  if (role === 'model') {
    return 'assistant';
  }
  // `user` stays `user`; any other value is passed through for schema validation.
  return (role ?? '') as Message['role'];
}

/**
 * Map one Gemini `content` turn → one or more IR {@link Message}s. A
 * `functionResponse` part is hoisted into its own `tool`-role message; the
 * remaining parts form the original message (with any `functionCall` parts
 * collected as `toolCalls`).
 */
function parseContent(raw: unknown, callIdsByName: Map<string, string>): Message[] {
  const rec = asRecord(raw);
  const role = toIrRole(asString(rec?.role));

  const parts = asArray(rec?.parts);
  if (parts === undefined) {
    return [{ role, content: [] }];
  }

  const out: Message[] = [];
  const content: ContentPart[] = [];
  const toolCalls: ToolCall[] = [];

  parts.forEach((part, index) => {
    const partRec = asRecord(part);

    const functionCall = asRecord(partRec?.functionCall);
    if (functionCall !== undefined) {
      const name = asString(functionCall.name) ?? '';
      const id = `call_${name}_${String(index)}`;
      callIdsByName.set(name, id);
      toolCalls.push({ id, name, arguments: asRecord(functionCall.args) ?? {} });
      return;
    }

    const functionResponse = asRecord(partRec?.functionResponse);
    if (functionResponse !== undefined) {
      out.push(parseFunctionResponse(functionResponse, callIdsByName));
      return;
    }

    const mapped = parseContentPart(partRec);
    if (mapped !== undefined) {
      content.push(mapped);
    }
  });

  // Drop an empty carrier (e.g. a user turn that held only functionResponse
  // parts), so a hoisted tool message takes the slot rather than trailing an
  // empty one.
  if (content.length === 0 && toolCalls.length === 0 && out.length > 0) {
    return out;
  }

  const message: Message = { role, content };
  if (toolCalls.length > 0) {
    message.toolCalls = toolCalls;
  }
  // The carrier message leads; hoisted tool messages follow.
  return [message, ...out];
}

/**
 * Map a Gemini `functionResponse` part → an IR `tool`-role {@link Message}. The
 * `toolCallId` references the synthesized id of the matching `functionCall`
 * (matched by name); `name` is carried through.
 */
function parseFunctionResponse(
  rec: Record<string, unknown>,
  callIdsByName: Map<string, string>,
): Message {
  const name = asString(rec.name) ?? '';
  const message: Message = {
    role: 'tool',
    content: [{ kind: 'text', text: JSON.stringify(rec.response ?? {}) }],
    name,
  };
  const toolCallId = callIdsByName.get(name);
  if (toolCallId !== undefined) {
    message.toolCallId = toolCallId;
  }
  return message;
}

/**
 * Map one non-function Gemini part → IR {@link ContentPart}. `text` → text part;
 * `inlineData` → base64 image part; `fileData` → url file part.
 */
function parseContentPart(rec: Record<string, unknown> | undefined): ContentPart | undefined {
  const text = asString(rec?.text);
  if (text !== undefined) {
    return { kind: 'text', text };
  }

  const inlineData = asRecord(rec?.inlineData);
  if (inlineData !== undefined) {
    const part: ContentPart = {
      kind: 'image',
      source: 'base64',
      data: asString(inlineData.data) ?? '',
    };
    const mime = asString(inlineData.mimeType);
    if (mime !== undefined) {
      part.mime = mime;
    }
    return part;
  }

  const fileData = asRecord(rec?.fileData);
  if (fileData !== undefined) {
    const part: ContentPart = {
      kind: 'file',
      source: 'url',
      data: asString(fileData.fileUri) ?? '',
    };
    const mime = asString(fileData.mimeType);
    if (mime !== undefined) {
      part.mime = mime;
    }
    return part;
  }

  return undefined;
}

/** Map Gemini `tools[].functionDeclarations[]` → IR {@link ToolDef}[]. */
function parseTools(raw: unknown): ToolDef[] | undefined {
  const arr = asArray(raw);
  if (arr === undefined) {
    return undefined;
  }
  const tools: ToolDef[] = [];
  for (const tool of arr) {
    const declarations = asArray(asRecord(tool)?.functionDeclarations);
    if (declarations === undefined) {
      continue;
    }
    for (const declaration of declarations) {
      const rec = asRecord(declaration);
      tools.push({
        name: asString(rec?.name) ?? '',
        description: asString(rec?.description),
        parameters: asRecord(rec?.parameters) ?? {},
      });
    }
  }
  return tools.length > 0 ? tools : undefined;
}

/**
 * Map Gemini `toolConfig.functionCallingConfig.mode`
 * (`AUTO|ANY|NONE`) → IR `'auto'`/`'required'`/`'none'`.
 */
function parseToolChoice(raw: unknown): ChatRequest['toolChoice'] {
  const mode = asString(asRecord(asRecord(raw)?.functionCallingConfig)?.mode);
  if (mode === 'AUTO') {
    return 'auto';
  }
  if (mode === 'ANY') {
    return 'required';
  }
  if (mode === 'NONE') {
    return 'none';
  }
  return undefined;
}

/** Map Gemini `generationConfig` fields → IR {@link ChatParams}. */
function parseParams(config: Record<string, unknown> | undefined): ChatParams | undefined {
  if (config === undefined) {
    return undefined;
  }
  const params: ChatParams = {};

  const temperature = asNumber(config.temperature);
  if (temperature !== undefined) {
    params.temperature = temperature;
  }

  const topP = asNumber(config.topP);
  if (topP !== undefined) {
    params.topP = topP;
  }

  const maxOutputTokens = asNumber(config.maxOutputTokens);
  if (maxOutputTokens !== undefined) {
    params.maxOutputTokens = maxOutputTokens;
  }

  const stop = asArray(config.stopSequences)?.flatMap((s) => {
    const str = asString(s);
    return str === undefined ? [] : [str];
  });
  if (stop !== undefined) {
    params.stop = stop;
  }

  if (asString(config.responseMimeType) === 'application/json') {
    params.responseFormat = 'json_object';
  }

  return Object.keys(params).length > 0 ? params : undefined;
}
