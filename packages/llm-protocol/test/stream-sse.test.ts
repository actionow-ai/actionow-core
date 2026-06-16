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
async function frames(it: AsyncIterable<string>): Promise<string[]> {
  const out = await collect(it);
  return out.split('\n\n').filter((f) => f.length > 0);
}

const happyPath: ChatStreamEvent[] = [
  { type: 'message_start' },
  { type: 'content_delta', text: 'hel' },
  { type: 'content_delta', text: 'lo' },
  { type: 'tool_call_delta', index: 0, id: 'c1', name: 'f', argumentsDelta: '{"a":1}' },
  { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } },
  { type: 'stop', stopReason: 'stop' },
  { type: 'done' },
];

const errorPath: ChatStreamEvent[] = [
  { type: 'message_start' },
  { type: 'content_delta', text: 'partial' },
  { type: 'error', error: { code: 'upstream_error', message: 'boom', retryable: false } },
];

describe('renderOpenAIChatStream', () => {
  it('emits chat.completion.chunk frames + [DONE]', async () => {
    const out = await collect(renderOpenAIChatStream(events(happyPath), 'gpt-4o'));
    const dataFrames = out.split('\n\n').filter((f) => f.startsWith('data: '));
    expect(dataFrames.at(-1)).toBe('data: [DONE]');
    expect(out).toContain('"object":"chat.completion.chunk"');
    expect(out).toContain('"delta":{"content":"hel"}');
    expect(out).toContain('"finish_reason":"stop"');
  });

  it('emits a role-bearing first delta exactly once', async () => {
    const out = await collect(renderOpenAIChatStream(events(happyPath), 'gpt-4o'));
    expect(out).toContain('"delta":{"role":"assistant","content":""}');
    // role appears only in the opening chunk, not on subsequent content deltas
    const roleCount = out.split('"role":"assistant"').length - 1;
    expect(roleCount).toBe(1);
  });

  it('emits a tool_call delta with index/id/name/arguments', async () => {
    const out = await collect(renderOpenAIChatStream(events(happyPath), 'gpt-4o'));
    expect(out).toContain(
      '"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"f","arguments":"{\\"a\\":1}"}}]}',
    );
  });

  it('emits a usage chunk only when usage is present', async () => {
    const out = await collect(renderOpenAIChatStream(events(happyPath), 'gpt-4o'));
    expect(out).toContain('"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}');
  });

  it('shares one id + created across all chunks', async () => {
    const out = await collect(renderOpenAIChatStream(events(happyPath), 'gpt-4o'));
    const ids = [...out.matchAll(/"id":"(chatcmpl-[^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(1);
  });

  it('degrades a mid-stream error to a clean stop then [DONE]', async () => {
    const out = await collect(renderOpenAIChatStream(events(errorPath), 'gpt-4o'));
    const dataFrames = out.split('\n\n').filter((f) => f.startsWith('data: '));
    expect(out).toContain('"finish_reason":"stop"');
    expect(dataFrames.at(-1)).toBe('data: [DONE]');
  });
});

describe('renderAnthropicMessagesStream', () => {
  it('emits typed events: message_start..content_block_delta..message_stop', async () => {
    const out = await collect(
      renderAnthropicMessagesStream(events(happyPath), 'claude-3-5-sonnet'),
    );
    expect(out).toContain('event: message_start');
    expect(out).toContain('event: content_block_start');
    expect(out).toContain('event: content_block_delta');
    expect(out).toContain('"text_delta"');
    expect(out).toContain('event: message_delta');
    expect(out).toContain('event: message_stop');
  });

  it('opens a text block, streams text_delta, and closes it', async () => {
    const out = await collect(
      renderAnthropicMessagesStream(events(happyPath), 'claude-3-5-sonnet'),
    );
    expect(out).toContain('"content_block":{"type":"text","text":""}');
    expect(out).toContain('"delta":{"type":"text_delta","text":"hel"}');
    expect(out).toContain('"delta":{"type":"text_delta","text":"lo"}');
    expect(out).toContain('event: content_block_stop');
  });

  it('opens a tool_use block at the next index and streams input_json_delta', async () => {
    const out = await collect(
      renderAnthropicMessagesStream(events(happyPath), 'claude-3-5-sonnet'),
    );
    expect(out).toContain(
      '"index":1,"content_block":{"type":"tool_use","id":"c1","name":"f","input":{}}',
    );
    expect(out).toContain('"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":1}"}');
  });

  it('carries stop_reason + output usage on message_delta', async () => {
    const out = await collect(
      renderAnthropicMessagesStream(events(happyPath), 'claude-3-5-sonnet'),
    );
    expect(out).toContain('"delta":{"stop_reason":"end_turn","stop_sequence":null}');
    expect(out).toContain('"usage":{"output_tokens":2}');
  });

  it('emits message_start with input usage and model', async () => {
    const out = await collect(
      renderAnthropicMessagesStream(events(happyPath), 'claude-3-5-sonnet'),
    );
    expect(out).toContain('"model":"claude-3-5-sonnet"');
    expect(out).toContain('"usage":{"input_tokens":0,"output_tokens":0}');
  });

  it('emits an error event frame on a mid-stream error', async () => {
    const out = await collect(
      renderAnthropicMessagesStream(events(errorPath), 'claude-3-5-sonnet'),
    );
    expect(out).toContain('event: error');
    expect(out).toContain('"type":"error"');
    expect(out).toContain('"type":"overloaded_error"');
    expect(out).toContain('boom');
  });
});

describe('renderGeminiGenerateContentStream', () => {
  it('emits one SSE data frame per candidate chunk', async () => {
    const out = await collect(renderGeminiGenerateContentStream(events(happyPath)));
    const dataFrames = out.split('\n\n').filter((f) => f.startsWith('data: '));
    expect(dataFrames.length).toBeGreaterThanOrEqual(2);
    expect(out).toContain('"text":"hel"');
    expect(out).toContain('"finishReason":"STOP"');
    expect(out).toContain('usageMetadata');
  });

  it('emits usageMetadata with Gemini casing on the terminal chunk', async () => {
    const out = await collect(renderGeminiGenerateContentStream(events(happyPath)));
    expect(out).toContain(
      '"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2,"totalTokenCount":5}',
    );
  });

  it('emits a functionCall part on a tool_call delta carrying a name', async () => {
    const out = await collect(renderGeminiGenerateContentStream(events(happyPath)));
    expect(out).toContain('"functionCall":{"name":"f","args":{"a":1}}');
  });

  it('has no [DONE] sentinel', async () => {
    const out = await collect(renderGeminiGenerateContentStream(events(happyPath)));
    expect(out).not.toContain('[DONE]');
  });

  it('emits a finishReason:OTHER chunk on a mid-stream error', async () => {
    const fs = await frames(renderGeminiGenerateContentStream(events(errorPath)));
    expect(fs.at(-1)).toContain('"finishReason":"OTHER"');
  });
});
