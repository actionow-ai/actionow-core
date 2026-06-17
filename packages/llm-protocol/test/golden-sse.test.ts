import type { ChatStreamEvent } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import { renderAnthropicMessagesStream } from '../src/anthropic/index.js';
import { renderGeminiGenerateContentStream } from '../src/gemini/index.js';
import { renderOpenAIChatStream } from '../src/openai/index.js';

// eslint-disable-next-line @typescript-eslint/require-await
async function* events(evs: ChatStreamEvent[]): AsyncIterable<ChatStreamEvent> {
  for (const e of evs) yield e;
}

async function collect(it: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const s of it) out += s;
  return out;
}

/**
 * Replace the only non-deterministic fields — a per-stream uuid `id`
 * (`chatcmpl-<uuid>` / `msg_<uuid>`) and the unix `created` timestamp — so the
 * byte-exact wire shape of each dialect's SSE can be locked in a snapshot.
 */
function normalize(out: string): string {
  return out
    .replace(/"(chatcmpl-|msg_)[A-Za-z0-9-]+"/g, '"$1<id>"')
    .replace(/"created":\d+/g, '"created":<created>');
}

/**
 * The single deterministic event sequence every dialect renders (§A14): a
 * message start, two text deltas (`A`/`B`), a usage event, a `stop`, and the
 * terminal `done`. Locking the rendered bytes per dialect catches any silent
 * framing regression a future refactor might introduce.
 */
const golden: ChatStreamEvent[] = [
  { type: 'message_start' },
  { type: 'content_delta', text: 'A' },
  { type: 'content_delta', text: 'B' },
  { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } },
  { type: 'stop', stopReason: 'stop' },
  { type: 'done' },
];

describe('golden SSE snapshots', () => {
  it('OpenAI: chat.completion.chunk frames ending in [DONE]', async () => {
    const out = normalize(await collect(renderOpenAIChatStream(events(golden), 'gpt-4o')));
    expect(out).toMatchInlineSnapshot(`
      "data: {"id":"chatcmpl-<id>","object":"chat.completion.chunk","created":<created>,"model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

      data: {"id":"chatcmpl-<id>","object":"chat.completion.chunk","created":<created>,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"A"},"finish_reason":null}]}

      data: {"id":"chatcmpl-<id>","object":"chat.completion.chunk","created":<created>,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"B"},"finish_reason":null}]}

      data: {"id":"chatcmpl-<id>","object":"chat.completion.chunk","created":<created>,"model":"gpt-4o","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}

      data: {"id":"chatcmpl-<id>","object":"chat.completion.chunk","created":<created>,"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

      data: [DONE]

      "
    `);
  });

  it('Anthropic: typed message events (message_start … message_stop)', async () => {
    const out = normalize(
      await collect(renderAnthropicMessagesStream(events(golden), 'claude-3-5-sonnet')),
    );
    expect(out).toMatchInlineSnapshot(`
      "event: message_start
      data: {"type":"message_start","message":{"id":"msg_<id>","type":"message","role":"assistant","model":"claude-3-5-sonnet","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}}

      event: content_block_start
      data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

      event: content_block_delta
      data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"A"}}

      event: content_block_delta
      data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"B"}}

      event: content_block_stop
      data: {"type":"content_block_stop","index":0}

      event: message_delta
      data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}

      event: message_stop
      data: {"type":"message_stop"}

      "
    `);
  });

  it('Gemini: generateContent candidate chunks (alt=sse, no [DONE])', async () => {
    const out = normalize(await collect(renderGeminiGenerateContentStream(events(golden))));
    expect(out).toMatchInlineSnapshot(`
      "data: {"candidates":[{"content":{"role":"model","parts":[{"text":"A"}]},"index":0}]}

      data: {"candidates":[{"content":{"role":"model","parts":[{"text":"B"}]},"index":0}]}

      data: {"candidates":[{"content":{"role":"model","parts":[]},"index":0,"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"totalTokenCount":7}}

      "
    `);
  });
});
