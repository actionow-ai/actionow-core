import { config } from '@/config';

/**
 * Direct `/v1/chat/completions` client for the playground. This is the DATA
 * PLANE: it authenticates with an `ak_` API key (console JWTs are rejected
 * there), so it deliberately bypasses `apiFetch`. Streaming is hand-parsed
 * from the OpenAI-compatible SSE wire (EventSource cannot set headers).
 */

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatTokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

export interface ChatOutcome {
  content: string;
  usage: ChatTokenUsage | null;
  /** The model that actually served the call (`servedModel` after fallback), when reported. */
  model: string | null;
}

export class ChatCallError extends Error {
  readonly status?: number;
  readonly code?: string;

  constructor(message: string, options: { status?: number; code?: string } = {}) {
    super(message);
    this.name = 'ChatCallError';
    this.status = options.status;
    this.code = options.code;
  }
}

interface WireErrorEnvelope {
  error?: { message?: string; code?: string; type?: string };
}

interface WireChunk {
  model?: string;
  error?: { message?: string; code?: string };
  choices?: { delta?: { content?: string }; message?: { content?: string } }[];
  usage?: ChatTokenUsage | null;
}

function chatUrl(): string {
  return `${config.apiBaseUrl}/v1/chat/completions`;
}

function headers(apiKey: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` };
}

async function toChatError(response: Response): Promise<ChatCallError> {
  let envelope: WireErrorEnvelope | undefined;
  try {
    envelope = (await response.json()) as WireErrorEnvelope;
  } catch {
    envelope = undefined;
  }
  return new ChatCallError(envelope?.error?.message ?? `HTTP ${String(response.status)}`, {
    status: response.status,
    code: envelope?.error?.code,
  });
}

/** Non-streaming call: one `chat.completion` JSON response. */
export async function chatComplete(options: {
  apiKey: string;
  model: string;
  messages: ChatTurn[];
  signal: AbortSignal;
}): Promise<ChatOutcome> {
  const response = await fetch(chatUrl(), {
    method: 'POST',
    headers: headers(options.apiKey),
    body: JSON.stringify({ model: options.model, messages: options.messages }),
    signal: options.signal,
  });
  if (!response.ok) throw await toChatError(response);
  const payload = (await response.json()) as WireChunk;
  return {
    content: payload.choices?.[0]?.message?.content ?? '',
    usage: payload.usage ?? null,
    model: payload.model ?? null,
  };
}

/**
 * Streaming call: `chat.completion.chunk` SSE frames terminated by
 * `data: [DONE]`. A mid-stream failure arrives as `data: {"error":{…}}` and the
 * stream then ends WITHOUT `[DONE]` — so EOF before `[DONE]` is always treated
 * as a failure (`code: 'stream_truncated'` when no error frame was seen).
 * `onDelta` receives the full accumulated text after each content delta, so the
 * caller keeps the partial transcript on user abort.
 */
export async function chatStream(options: {
  apiKey: string;
  model: string;
  messages: ChatTurn[];
  signal: AbortSignal;
  onDelta: (text: string) => void;
}): Promise<ChatOutcome> {
  const response = await fetch(chatUrl(), {
    method: 'POST',
    headers: headers(options.apiKey),
    body: JSON.stringify({
      model: options.model,
      messages: options.messages,
      stream: true,
      stream_options: { include_usage: true },
    }),
    signal: options.signal,
  });
  if (!response.ok) throw await toChatError(response);
  if (response.body === null) throw new ChatCallError('', { code: 'stream_truncated' });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let usage: ChatTokenUsage | null = null;
  let servedModel: string | null = null;
  let done = false;

  /** Returns `true` when the event is the `[DONE]` terminator. */
  const handleEvent = (data: string): boolean => {
    if (data === '[DONE]') return true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return false;
    }
    const chunk = parsed as WireChunk;
    if (chunk.error !== undefined) {
      throw new ChatCallError(chunk.error.message ?? chunk.error.code ?? '', {
        code: chunk.error.code,
      });
    }
    if (typeof chunk.model === 'string' && chunk.model !== '') servedModel = chunk.model;
    const delta = chunk.choices?.[0]?.delta?.content;
    if (typeof delta === 'string' && delta !== '') {
      content += delta;
      options.onDelta(content);
    }
    if (chunk.usage !== undefined && chunk.usage !== null) usage = chunk.usage;
    return false;
  };

  /** Drains complete lines from the buffer; returns `true` once `[DONE]` is seen. */
  const consume = (final: boolean): boolean => {
    let newlineAt = buffer.indexOf('\n');
    while (newlineAt !== -1) {
      const line = buffer.slice(0, newlineAt).replace(/\r$/, '');
      buffer = buffer.slice(newlineAt + 1);
      if (line.startsWith('data:') && handleEvent(line.slice(5).trimStart())) return true;
      newlineAt = buffer.indexOf('\n');
    }
    if (final) {
      const tail = buffer.replace(/\r$/, '');
      buffer = '';
      if (tail.startsWith('data:') && handleEvent(tail.slice(5).trimStart())) return true;
    }
    return false;
  };

  try {
    for (;;) {
      const { value, done: eof } = await reader.read();
      if (eof) break;
      buffer += decoder.decode(value, { stream: true });
      if (consume(false)) {
        done = true;
        break;
      }
    }
    if (!done) {
      buffer += decoder.decode();
      done = consume(true);
    }
  } finally {
    if (done) await reader.cancel().catch(() => undefined);
  }

  if (!done) throw new ChatCallError('', { code: 'stream_truncated' });
  return { content, usage, model: servedModel };
}

/** `true` when the error is a user-initiated AbortController abort. */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
