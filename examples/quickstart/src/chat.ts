import { consumeSse, SSE_DONE } from '@actionow/sdk';

/**
 * Chat relay via the OpenAI-compatible endpoint `POST /v1/chat/completions`,
 * authenticated with an END-USER's `ak_…` key so the spend and governance limits
 * are attributed to that subject. The wire format IS OpenAI's, so an existing
 * OpenAI client works by just pointing `baseURL` at core + using the `ak_` key.
 *
 * This endpoint is not in the generated OpenAPI surface (the body is the raw
 * OpenAI shape, not a zod-validated contract), so we call it with `fetch`. For
 * streaming we reuse the SDK's `consumeSse` frame reader.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Blocking chat: returns the assistant's full message text. */
export async function chat(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
): Promise<string> {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages }),
  });
  if (!res.ok) {
    throw new Error(`chat failed: ${String(res.status)} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return body.choices?.[0]?.message?.content ?? '';
}

/**
 * Streaming chat: yields the incremental assistant text deltas as they arrive.
 * Set `stream: true`; core emits OpenAI `chat.completion.chunk` SSE frames ending
 * with the `data: [DONE]` sentinel. `consumeSse` turns the byte stream into
 * frames; we parse each `data` as a chunk and surface its delta content.
 *
 * Because the pre-flight credit hold runs BEFORE the first SSE byte, an
 * insufficient-credits / invalid-input failure surfaces as a real non-2xx HTTP
 * error here (not as an in-band error frame), so check `res.ok` first.
 */
export async function* chatStream(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
): AsyncGenerator<string, void, undefined> {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
      accept: 'text/event-stream',
    },
    body: JSON.stringify({ model, messages, stream: true }),
  });
  if (!res.ok) {
    throw new Error(`chatStream failed: ${String(res.status)} ${await res.text()}`);
  }

  for await (const frame of consumeSse(res)) {
    if (frame.data === SSE_DONE) break; // end-of-stream sentinel
    const chunk = JSON.parse(frame.data) as {
      choices?: { delta?: { content?: string } }[];
    };
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta !== undefined && delta.length > 0) yield delta;
  }
}
