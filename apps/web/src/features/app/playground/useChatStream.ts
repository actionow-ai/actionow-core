import { useCallback, useRef, useState } from 'react';

import { config } from '../../../config';

/** A turn sent upstream — only role + content (reasoning/metrics are not sent back). */
export interface ChatTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/** Token usage mapped from the OpenAI streaming `usage` chunk. */
export interface ChatUsage {
  input: number;
  output: number;
}

/** Inputs to one streamed completion. */
export interface RunChatParams {
  /** The playground API key (plaintext) for `Authorization: Bearer …`. */
  readonly key: string;
  readonly model: string;
  readonly messages: ChatTurn[];
  /** Optional sampling temperature (omitted → provider default). */
  readonly temperature?: number;
  /** Optional system prompt, prepended as a `system` turn. */
  readonly system?: string;
}

/** The terminal outcome of a `run`. `aborted` keeps whatever streamed so far. */
export type RunOutcome =
  | {
      kind: 'done';
      content: string;
      reasoning: string;
      usage: ChatUsage | null;
      ttftMs: number | null;
      totalMs: number;
    }
  | { kind: 'aborted'; content: string; reasoning: string }
  | { kind: 'error'; message: string; unauthorized: boolean };

/** The in-progress assistant text, surfaced live for the streaming bubble. */
interface LiveState {
  content: string;
  reasoning: string;
  streaming: boolean;
}

interface OpenAIDelta {
  content?: string | null;
  reasoning_content?: string | null;
}
interface OpenAIStreamChunk {
  choices?: { delta?: OpenAIDelta }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

/**
 * Streams one chat completion from the data-plane relay (`POST /v1/chat/completions`)
 * with the playground API key, parsing the OpenAI-compatible SSE by hand
 * (browsers can't set a Bearer header on `EventSource`). It accumulates
 * `delta.content` and `delta.reasoning_content` separately, captures the final
 * `usage` chunk (the request sends `stream_options.include_usage`), and measures
 * TTFT (延迟) + total (总计) client-side. `stop()` aborts and keeps the partial.
 *
 * `run` resolves with a {@link RunOutcome}; a non-2xx response is decoded as the
 * unified error envelope (a 401 sets `unauthorized` so the caller can re-mint the
 * key and retry). `live` drives the streaming bubble between calls.
 */
export function useChatStream(): {
  live: LiveState;
  run: (params: RunChatParams) => Promise<RunOutcome>;
  stop: () => void;
} {
  const [live, setLive] = useState<LiveState>({ content: '', reasoning: '', streaming: false });
  const ctrlRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    ctrlRef.current?.abort();
  }, []);

  const run = useCallback(async (params: RunChatParams): Promise<RunOutcome> => {
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setLive({ content: '', reasoning: '', streaming: true });

    const messages: ChatTurn[] =
      params.system !== undefined && params.system.trim() !== ''
        ? [{ role: 'system', content: params.system }, ...params.messages]
        : params.messages;

    const started = performance.now();
    let ttftMs: number | null = null;
    let content = '';
    let reasoning = '';
    let usage: ChatUsage | null = null;

    let res: Response;
    try {
      res = await fetch(`${config.apiBase}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${params.key}`,
          accept: 'text/event-stream',
        },
        body: JSON.stringify({
          model: params.model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        }),
        signal: ctrl.signal,
      });
    } catch (e) {
      setLive({ content: '', reasoning: '', streaming: false });
      if (ctrl.signal.aborted) return { kind: 'aborted', content: '', reasoning: '' };
      return { kind: 'error', message: errMessage(e), unauthorized: false };
    }

    // A non-2xx response is a JSON error envelope, not an event stream.
    if (!res.ok || res.body === null) {
      setLive({ content: '', reasoning: '', streaming: false });
      const { message } = await decodeError(res);
      return { kind: 'error', message, unauthorized: res.status === 401 };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep = buffer.indexOf('\n\n');
        while (sep !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const data = frameData(frame);
          if (data === null) {
            sep = buffer.indexOf('\n\n');
            continue;
          }
          if (data === '[DONE]') {
            const totalMs = performance.now() - started;
            setLive({ content, reasoning, streaming: false });
            return { kind: 'done', content, reasoning, usage, ttftMs, totalMs };
          }
          const chunk = parseChunk(data);
          if (chunk === null) {
            sep = buffer.indexOf('\n\n');
            continue;
          }
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.reasoning_content != null) reasoning += delta.reasoning_content;
          if (delta?.content != null) {
            ttftMs ??= performance.now() - started;
            content += delta.content;
          }
          if (chunk.usage != null) {
            usage = {
              input: chunk.usage.prompt_tokens ?? 0,
              output: chunk.usage.completion_tokens ?? 0,
            };
          }
          setLive({ content, reasoning, streaming: true });
          sep = buffer.indexOf('\n\n');
        }
      }
      // Stream ended without an explicit [DONE] (some relays just close).
      const totalMs = performance.now() - started;
      setLive({ content, reasoning, streaming: false });
      return { kind: 'done', content, reasoning, usage, ttftMs, totalMs };
    } catch (e) {
      setLive({ content, reasoning, streaming: false });
      if (ctrl.signal.aborted) return { kind: 'aborted', content, reasoning };
      return { kind: 'error', message: errMessage(e), unauthorized: false };
    }
  }, []);

  return { live, run, stop };
}

/** Extract the `data:` payload of one SSE frame, or null for a comment/heartbeat. */
function frameData(frame: string): string | null {
  for (const line of frame.split('\n')) {
    if (line.startsWith('data:')) return line.slice(5).trim();
  }
  return null;
}

function parseChunk(data: string): OpenAIStreamChunk | null {
  try {
    return JSON.parse(data) as OpenAIStreamChunk;
  } catch {
    return null;
  }
}

/** Decode the unified error envelope of a failed response into a message. */
async function decodeError(res: Response): Promise<{ message: string }> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    if (body.error?.message !== undefined && body.error.message !== '') {
      return { message: body.error.message };
    }
    if (body.error?.code !== undefined) return { message: body.error.code };
  } catch {
    // non-JSON body
  }
  return { message: `HTTP ${String(res.status)}` };
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
