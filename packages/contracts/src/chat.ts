import { z } from 'zod';

import type { UnifiedError } from './adapter.js';

export const CHAT_ROLES = ['system', 'user', 'assistant', 'tool'] as const;
export type ChatRole = (typeof CHAT_ROLES)[number];

/** A JSON Schema object (tool parameters / structured-output schema). */
export type JsonSchema = Record<string, unknown>;
const jsonSchema: z.ZodType<JsonSchema> = z.record(z.string(), z.unknown());

export const textPartSchema = z.object({ kind: z.literal('text'), text: z.string() });
export const imagePartSchema = z.object({
  kind: z.literal('image'),
  source: z.enum(['url', 'base64', 'file_id']),
  /** The URL, base64 payload, or provider file id, per `source`. */
  data: z.string(),
  mime: z.string().optional(),
});
export const audioPartSchema = z.object({
  kind: z.literal('audio'),
  source: z.enum(['url', 'base64', 'file_id']),
  data: z.string(),
  mime: z.string().optional(),
});
export const filePartSchema = z.object({
  kind: z.literal('file'),
  source: z.enum(['url', 'base64', 'file_id']),
  data: z.string(),
  mime: z.string().optional(),
});
export const contentPartSchema = z.discriminatedUnion('kind', [
  textPartSchema,
  imagePartSchema,
  audioPartSchema,
  filePartSchema,
]);
export type ContentPart = z.infer<typeof contentPartSchema>;

export const toolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
});
export type ToolCall = z.infer<typeof toolCallSchema>;

export const toolDefSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  parameters: jsonSchema,
});
export type ToolDef = z.infer<typeof toolDefSchema>;

export const messageSchema = z.object({
  role: z.enum(CHAT_ROLES),
  content: z.array(contentPartSchema),
  toolCalls: z.array(toolCallSchema).optional(),
  toolCallId: z.string().optional(),
  name: z.string().optional(),
});
export type Message = z.infer<typeof messageSchema>;

export const RESPONSE_FORMATS = ['text', 'json_object', 'json_schema'] as const;
export const chatParamsSchema = z.object({
  temperature: z.number().optional(),
  topP: z.number().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  stop: z.array(z.string()).optional(),
  seed: z.number().int().optional(),
  responseFormat: z.enum(RESPONSE_FORMATS).optional(),
  jsonSchema: jsonSchema.optional(),
});
export type ChatParams = z.infer<typeof chatParamsSchema>;

export const TOOL_CHOICES = ['auto', 'none', 'required'] as const;
export const chatRequestSchema = z.object({
  model: z.string(),
  messages: z.array(messageSchema),
  tools: z.array(toolDefSchema).optional(),
  toolChoice: z.union([z.enum(TOOL_CHOICES), z.object({ name: z.string() })]).optional(),
  params: chatParamsSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;

export const STOP_REASONS = ['stop', 'length', 'tool_calls', 'content_filter', 'error'] as const;
export type StopReason = (typeof STOP_REASONS)[number];

/** Token usage in the IR's canonical camelCase shape. */
export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResponse {
  message: Message;
  stopReason: StopReason;
  usage: ChatUsage;
}

/**
 * IR-level streaming event. `tool_call_delta` carries an incremental tool-call
 * (index + optional id/name on the first chunk, then `argumentsDelta` slices).
 */
export type ChatStreamEvent =
  | { type: 'message_start' }
  | { type: 'content_delta'; text: string }
  | {
      type: 'tool_call_delta';
      index: number;
      id?: string;
      name?: string;
      argumentsDelta?: string;
    }
  | { type: 'usage'; usage: ChatUsage }
  | { type: 'stop'; stopReason: StopReason }
  | { type: 'done' }
  | { type: 'error'; error: UnifiedError };
