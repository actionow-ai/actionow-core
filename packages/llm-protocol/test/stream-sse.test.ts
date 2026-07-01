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

// Two distinct parallel/sequential tool calls (BUG 1): IR index 0 (`f`/`c1`)
// and IR index 1 (`g`/`c2`), each with its own partial args.
const twoToolsPath: ChatStreamEvent[] = [
  { type: 'message_start' },
  { type: 'tool_call_delta', index: 0, id: 'c1', name: 'f', argumentsDelta: '{"a":' },
  { type: 'tool_call_delta', index: 0, argumentsDelta: '1}' },
  { type: 'tool_call_delta', index: 1, id: 'c2', name: 'g', argumentsDelta: '{"b":' },
  { type: 'tool_call_delta', index: 1, argumentsDelta: '2}' },
  { type: 'stop', stopReason: 'tool_calls' },
];

// Text arriving AFTER a tool block opened (BUG 2): the trailing text must not
// delta into the closed tool block (or a never-opened index 0).
const textAfterToolPath: ChatStreamEvent[] = [
  { type: 'message_start' },
  { type: 'tool_call_delta', index: 0, id: 'c1', name: 'f', argumentsDelta: '{"a":1}' },
  { type: 'content_delta', text: 'more text' },
  { type: 'stop', stopReason: 'stop' },
];

/** Parse Anthropic typed SSE frames into `{event, data}` pairs. */
function anthropicFrames(out: string): { event: string; data: Record<string, unknown> }[] {
  return out
    .split('\n\n')
    .filter((f) => f.length > 0)
    .map((f) => {
      const m = /^event: (.+)\ndata: (.+)$/s.exec(f);
      if (m === null) throw new Error(`unparseable frame: ${f}`);
      return { event: m[1] ?? '', data: JSON.parse(m[2] ?? '{}') as Record<string, unknown> };
    });
}

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

  it('emits the usage chunk with empty choices (real include_usage shape)', async () => {
    const fs = await frames(renderOpenAIChatStream(events(happyPath), 'gpt-4o'));
    const usageFrame = fs.find((f) => f.includes('"usage":'));
    expect(usageFrame).toBeDefined();
    const obj = JSON.parse((usageFrame ?? '').slice('data: '.length)) as {
      choices: unknown[];
      usage: unknown;
    };
    expect(obj.choices).toEqual([]);
    expect(obj.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
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

  // P2-5 (stream) — the terminal chunk surfaces native_finish_reason when the IR
  // stop event carried it; omitted otherwise (non-native streams unchanged).
  it('surfaces native_finish_reason on the terminal chunk when present', async () => {
    const path: ChatStreamEvent[] = [
      { type: 'message_start' },
      { type: 'content_delta', text: 'hi' },
      { type: 'stop', stopReason: 'content_filter', nativeFinishReason: 'content_filter' },
      { type: 'done' },
    ];
    const out = await collect(renderOpenAIChatStream(events(path), 'gpt-4o'));
    expect(out).toContain('"finish_reason":"content_filter"');
    expect(out).toContain('"native_finish_reason":"content_filter"');
  });

  it('omits native_finish_reason on the terminal chunk when absent (non-breaking)', async () => {
    const out = await collect(renderOpenAIChatStream(events(happyPath), 'gpt-4o'));
    expect(out).not.toContain('native_finish_reason');
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

  it('opens a distinct tool_use block per IR tool index (two parallel tools)', async () => {
    const out = await collect(
      renderAnthropicMessagesStream(events(twoToolsPath), 'claude-3-5-sonnet'),
    );
    const fs = anthropicFrames(out);
    const toolStarts = fs.filter(
      (f) =>
        f.event === 'content_block_start' &&
        (f.data.content_block as { type?: string } | undefined)?.type === 'tool_use',
    );
    // BUG 1: there must be TWO tool_use blocks, not one collapsed block.
    expect(toolStarts.length).toBe(2);

    const blockF = toolStarts.find((f) => (f.data.content_block as { name?: string }).name === 'f');
    const blockG = toolStarts.find((f) => (f.data.content_block as { name?: string }).name === 'g');
    expect(blockF).toBeDefined();
    expect(blockG).toBeDefined();
    expect((blockF?.data.content_block as { id?: string }).id).toBe('c1');
    expect((blockG?.data.content_block as { id?: string }).id).toBe('c2');
    // Distinct block indices.
    const idxF = blockF?.data.index as number;
    const idxG = blockG?.data.index as number;
    expect(idxF).not.toBe(idxG);

    // Each tool's input_json_delta routes to its OWN block index.
    const deltasFor = (idx: number): string[] =>
      fs
        .filter(
          (f) =>
            f.event === 'content_block_delta' &&
            f.data.index === idx &&
            (f.data.delta as { type?: string }).type === 'input_json_delta',
        )
        .map((f) => (f.data.delta as { partial_json: string }).partial_json);
    expect(deltasFor(idxF).join('')).toBe('{"a":1}');
    expect(deltasFor(idxG).join('')).toBe('{"b":2}');

    // Each opened block is closed exactly once (one stop per content_block_start):
    // the leading text block from message_start + the two tool blocks = 3.
    const starts = fs.filter((f) => f.event === 'content_block_start');
    const stops = fs.filter((f) => f.event === 'content_block_stop');
    expect(stops.length).toBe(starts.length);
    expect(stops.length).toBe(3);
  });

  it('opens a fresh text block when text interleaves after a tool block', async () => {
    const out = await collect(
      renderAnthropicMessagesStream(events(textAfterToolPath), 'claude-3-5-sonnet'),
    );
    const fs = anthropicFrames(out);

    // The text_delta carrying "more text" must target a block that was opened
    // via a preceding content_block_start of type 'text' (BUG 2).
    const textDelta = fs.find(
      (f) =>
        f.event === 'content_block_delta' &&
        (f.data.delta as { type?: string }).type === 'text_delta' &&
        (f.data.delta as { text?: string }).text === 'more text',
    );
    expect(textDelta).toBeDefined();
    const textBlockIdx = textDelta?.data.index as number;

    // A content_block_start of type 'text' must exist at that index.
    const openedTextBlock = fs.some(
      (f) =>
        f.event === 'content_block_start' &&
        f.data.index === textBlockIdx &&
        (f.data.content_block as { type?: string }).type === 'text',
    );
    expect(openedTextBlock).toBe(true);

    // It must NOT reuse the tool block's index (which carried input_json_delta).
    const toolBlockIdx = fs.find(
      (f) =>
        f.event === 'content_block_start' &&
        (f.data.content_block as { type?: string }).type === 'tool_use',
    )?.data.index as number;
    expect(textBlockIdx).not.toBe(toolBlockIdx);

    // It must be a FRESH block opened after the tool block (BUG 2): the original
    // text block (index 0) was closed when the tool block opened, so the trailing
    // text gets its own new index strictly greater than the tool block's.
    expect(textBlockIdx).toBeGreaterThan(toolBlockIdx);

    // The fresh text block's content_block_start must come AFTER the tool block's.
    const order = (
      pred: (f: { event: string; data: Record<string, unknown> }) => boolean,
    ): number => fs.findIndex(pred);
    const toolStartPos = order(
      (f) =>
        f.event === 'content_block_start' &&
        (f.data.content_block as { type?: string }).type === 'tool_use',
    );
    const freshTextStartPos = order(
      (f) =>
        f.event === 'content_block_start' &&
        f.data.index === textBlockIdx &&
        (f.data.content_block as { type?: string }).type === 'text',
    );
    expect(freshTextStartPos).toBeGreaterThan(toolStartPos);

    // No text_delta may ever target a block that was never opened as text.
    const openedTextIndices = new Set(
      fs
        .filter(
          (f) =>
            f.event === 'content_block_start' &&
            (f.data.content_block as { type?: string }).type === 'text',
        )
        .map((f) => f.data.index as number),
    );
    for (const f of fs) {
      if (
        f.event === 'content_block_delta' &&
        (f.data.delta as { type?: string }).type === 'text_delta'
      ) {
        expect(openedTextIndices.has(f.data.index as number)).toBe(true);
      }
    }
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
