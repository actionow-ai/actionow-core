import type { ChatUsage } from './useChatStream';

/**
 * One row in the displayed transcript. A superset of the persisted `MessageView`
 * plus client-only fields (`ttftMs`, `streaming`, `error`) that aren't stored.
 * `id` is a stable React key (the persisted message id, or a local uuid for an
 * optimistic/streaming row).
 */
export interface ChatRow {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  reasoning?: string | null;
  usage?: ChatUsage | null;
  /** Client-measured total latency (ms) of an assistant turn. */
  latencyMs?: number | null;
  /** Client-measured time-to-first-token (ms) of an assistant turn (not persisted). */
  ttftMs?: number | null;
  model?: string | null;
  /** This assistant row failed (renders as an error bubble with a retry). */
  error?: boolean;
  /** This assistant row is actively streaming (renders the live cursor, hides actions). */
  streaming?: boolean;
}

export type { ChatUsage };
