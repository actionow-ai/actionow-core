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

// --- Embeddings (OpenAI-compatible /v1/embeddings) -------------------------

/**
 * Wire request body for `POST /v1/embeddings` (OpenAI-compatible). `input` is a
 * single string OR a string array (the OpenAI contract also admits token-id
 * arrays, which this relay does not surface). The relay resolves `model` → a
 * channel → the provider's `/v1/embeddings`, and bills per INPUT token only.
 */
export const embeddingsRequestSchema = z.object({
  model: z.string(),
  input: z.union([z.string(), z.array(z.string())]),
  /** OpenAI `encoding_format`; passed through to the upstream verbatim when set. */
  encodingFormat: z.enum(['float', 'base64']).optional(),
  /** OpenAI `dimensions` (output vector length); passed through when set. */
  dimensions: z.number().int().positive().optional(),
  /** OpenAI `user` opaque end-user identifier; passed through when set. */
  user: z.string().optional(),
});
export type EmbeddingsRequest = z.infer<typeof embeddingsRequestSchema>;

/** One embedding entry in the OpenAI `data[]` array. */
export const embeddingSchema = z.object({
  object: z.literal('embedding'),
  index: z.number().int().nonnegative(),
  embedding: z.array(z.number()),
});
export type Embedding = z.infer<typeof embeddingSchema>;

/** OpenAI embeddings response shape. `usage` carries INPUT tokens only. */
export const embeddingsResponseSchema = z.object({
  object: z.literal('list'),
  data: z.array(embeddingSchema),
  model: z.string(),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
  }),
});
export type EmbeddingsResponse = z.infer<typeof embeddingsResponseSchema>;

/**
 * The dialect-neutral embeddings result a {@link ProviderAdapter}'s `embed`
 * returns: one vector per input string (`vectors[i]` ↔ `input[i]`) plus the
 * input-token usage (camelCase, mirroring {@link ChatUsage}; embeddings have no
 * output tokens). The relay renders this back to the OpenAI `data[]`/`usage`
 * wire shape and meters the settle off `inputTokens`.
 */
export interface EmbeddingsResult {
  vectors: number[][];
  usage: { inputTokens: number };
}

// --- Rerank (Cohere/Jina-style /v1/rerank) ---------------------------------

/**
 * Wire request body for `POST /v1/rerank` (Cohere/Jina-compatible). The relay
 * resolves `model` → a channel → the provider's `/rerank`, scoring each of
 * `documents` against `query`, and bills per INPUT token only (query + every
 * document — the same `model_token` book as embeddings, INPUT side only).
 *
 * The Cohere/Jina wire field is the snake_case `top_n`; a `preprocess` accepts it
 * (and the camelCase `topN`) and normalizes to the IR's `topN`, so a downstream
 * Cohere/Jina SDK works unchanged while the contract stays camelCase.
 */
export const rerankRequestSchema = z.preprocess(
  (raw) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
    const rec = raw as Record<string, unknown>;
    if (!('topN' in rec) && 'top_n' in rec) {
      const { top_n: topN, ...rest } = rec;
      return { ...rest, topN };
    }
    return rec;
  },
  z.object({
    model: z.string(),
    query: z.string(),
    documents: z.array(z.string()).min(1),
    /** Return only the top-N results by relevance; absent → all documents, ranked. */
    topN: z.number().int().positive().optional(),
  }),
);
export type RerankRequest = z.infer<typeof rerankRequestSchema>;

/** One reranked document in the response `results[]` array. */
export const rerankResultItemSchema = z.object({
  /** The 0-based index into the original `documents` array. */
  index: z.number().int().nonnegative(),
  /** The provider's relevance score for this document (typically 0..1). */
  relevance_score: z.number(),
  /** Echo of the document text; present only when the caller asked the provider to return it. */
  document: z.string().optional(),
});
export type RerankResultItem = z.infer<typeof rerankResultItemSchema>;

/** Cohere/Jina rerank response shape. `usage` carries INPUT tokens only. */
export const rerankResponseSchema = z.object({
  model: z.string(),
  results: z.array(rerankResultItemSchema),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
  }),
});
export type RerankResponse = z.infer<typeof rerankResponseSchema>;

/**
 * The dialect-neutral rerank result a {@link ProviderAdapter}'s `rerank` returns:
 * a ranked subset of the input documents (each carrying its original `index` +
 * `relevanceScore`, optionally the echoed `document`) plus the input-token usage
 * (camelCase; rerank has no output tokens). The relay renders this back to the
 * Cohere/Jina `results[]`/`usage` wire shape and meters the settle off
 * `inputTokens`.
 */
export interface RerankResult {
  results: { index: number; relevanceScore: number; document?: string }[];
  usage: { inputTokens: number };
}

// --- Moderation (OpenAI-style /v1/moderations) -----------------------------

/**
 * Wire request body for `POST /v1/moderations` (OpenAI-compatible). `input` is a
 * single string OR a string array. The relay resolves `model` → a channel → the
 * provider's `/moderations`, and bills per INPUT token only (the same
 * `model_token` book as embeddings, INPUT side only) — feeding the compliance moat.
 */
export const moderationRequestSchema = z.object({
  model: z.string(),
  input: z.union([z.string(), z.array(z.string())]),
});
export type ModerationRequest = z.infer<typeof moderationRequestSchema>;

/** One moderation verdict in the response `results[]` array (one per input). */
export const moderationResultItemSchema = z.object({
  /** Whether ANY category tripped its threshold for this input. */
  flagged: z.boolean(),
  /** Per-category boolean verdicts (provider-defined category keys). */
  categories: z.record(z.string(), z.boolean()),
  /** Per-category confidence scores (0..1), keyed identically to `categories`. */
  category_scores: z.record(z.string(), z.number()),
});
export type ModerationResultItem = z.infer<typeof moderationResultItemSchema>;

/** OpenAI moderations response shape. Billed on INPUT tokens (no `usage` block in the OpenAI wire). */
export const moderationResponseSchema = z.object({
  id: z.string(),
  model: z.string(),
  results: z.array(moderationResultItemSchema),
});
export type ModerationResponse = z.infer<typeof moderationResponseSchema>;

/**
 * The dialect-neutral moderation result a {@link ProviderAdapter}'s `moderate`
 * returns: one verdict per input string (`results[i]` ↔ `input[i]`) plus the
 * input-token usage (camelCase; moderation has no output tokens). The relay
 * renders this back to the OpenAI `results[]` wire shape (synthesizing the `id`)
 * and meters the settle off `inputTokens`.
 */
export interface ModerationResult {
  results: {
    flagged: boolean;
    categories: Record<string, boolean>;
    categoryScores: Record<string, number>;
  }[];
  usage: { inputTokens: number };
}
