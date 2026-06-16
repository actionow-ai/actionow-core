import type { ChatRequest, ChatResponse, ChatStreamEvent, Message } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import {
  parseAnthropicChat,
  renderAnthropicChat,
  renderAnthropicMessagesStream,
} from '../src/anthropic/index.js';
import {
  parseGeminiChat,
  renderGeminiChat,
  renderGeminiGenerateContentStream,
} from '../src/gemini/index.js';
import { parseOpenAIChat, renderOpenAIChat, renderOpenAIChatStream } from '../src/openai/index.js';

/**
 * Cross-dialect translation matrix for the hub-and-spoke architecture: the IR is
 * the canonical hub; the parsers are the inbound spokes (wire request → IR) and
 * the renderers the outbound spokes (IR response → wire). This file proves a
 * representative request's *meaning* — system prompt, a user text+image turn,
 * tool definitions, tool calls + tool results, and generation params — survives
 * each dialect hop, modulo dialect-specific shape differences.
 */

const MODEL = 'matrix-model';

type Dialect = 'openai' | 'anthropic' | 'gemini';
const DIALECTS: readonly Dialect[] = ['openai', 'anthropic', 'gemini'] as const;

/**
 * Tool-call ids are a transport detail, not semantic content: OpenAI/Anthropic
 * carry the upstream id verbatim, while Gemini synthesizes `call_<name>_<seq>`
 * (it has no wire id). Normalize ids to a positional placeholder so the three
 * parsers can be compared for *semantic* convergence. Also drop the Gemini-only
 * `name` echo on hoisted tool messages, which is provenance, not content.
 */
function normalizeIr(ir: ChatRequest): ChatRequest {
  const idMap = new Map<string, string>();
  const intern = (id: string): string => {
    const existing = idMap.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const placeholder = `id_${String(idMap.size)}`;
    idMap.set(id, placeholder);
    return placeholder;
  };
  const messages = ir.messages.map((m): Message => {
    const next: Message = { role: m.role, content: m.content };
    if (m.toolCalls !== undefined) {
      next.toolCalls = m.toolCalls.map((c) => ({ ...c, id: intern(c.id) }));
    }
    if (m.toolCallId !== undefined) {
      next.toolCallId = intern(m.toolCallId);
    }
    // `name` is deliberately dropped (Gemini-only provenance on tool turns).
    return next;
  });
  const out: ChatRequest = { model: ir.model, messages };
  if (ir.tools !== undefined) out.tools = ir.tools;
  if (ir.toolChoice !== undefined) out.toolChoice = ir.toolChoice;
  if (ir.params !== undefined) out.params = ir.params;
  return out;
}

/**
 * The SAME logical conversation expressed in each dialect's wire shape:
 *   system prompt → user(text + base64 image) → assistant(tool_call) → tool(result)
 * plus a tools array and generation params. Parsing all three MUST converge on
 * one IR (after id normalization), proving the IR is a true canonical hub.
 */
const openaiWire = {
  model: MODEL,
  messages: [
    { role: 'system', content: 'be brief' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'what is in this image and the weather?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,aGk=' } },
      ],
    },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'tc_1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"SF"}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'tc_1', content: '{"v":42}' },
  ],
  tools: [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    },
  ],
  temperature: 0.2,
  max_tokens: 256,
};

const anthropicWire = {
  model: MODEL,
  max_tokens: 256,
  temperature: 0.2,
  system: 'be brief',
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'what is in this image and the weather?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } },
      ],
    },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tc_1', name: 'get_weather', input: { city: 'SF' } }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tc_1', content: '{"v":42}' }],
    },
  ],
  tools: [
    {
      name: 'get_weather',
      input_schema: { type: 'object', properties: { city: { type: 'string' } } },
    },
  ],
};

const geminiWire = {
  systemInstruction: { parts: [{ text: 'be brief' }] },
  contents: [
    {
      role: 'user',
      parts: [
        { text: 'what is in this image and the weather?' },
        { inlineData: { mimeType: 'image/png', data: 'aGk=' } },
      ],
    },
    {
      role: 'model',
      parts: [{ functionCall: { name: 'get_weather', args: { city: 'SF' } } }],
    },
    {
      role: 'user',
      parts: [{ functionResponse: { name: 'get_weather', response: { v: 42 } } }],
    },
  ],
  tools: [
    {
      functionDeclarations: [
        {
          name: 'get_weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      ],
    },
  ],
  generationConfig: { temperature: 0.2, maxOutputTokens: 256 },
};

function parseBy(dialect: Dialect): ChatRequest {
  switch (dialect) {
    case 'openai':
      return parseOpenAIChat(openaiWire);
    case 'anthropic':
      return parseAnthropicChat(anthropicWire);
    case 'gemini':
      return parseGeminiChat(geminiWire, MODEL);
  }
}

function renderBy(dialect: Dialect, res: ChatResponse): Record<string, unknown> {
  switch (dialect) {
    case 'openai':
      return renderOpenAIChat(res, MODEL);
    case 'anthropic':
      return renderAnthropicChat(res, MODEL);
    case 'gemini':
      return renderGeminiChat(res);
  }
}

describe('request → IR convergence (the canonical hub)', () => {
  it('all three parsers converge on one IR for the same logical request', () => {
    const ir = normalizeIr(parseBy('openai'));
    const anthropic = normalizeIr(parseBy('anthropic'));
    const gemini = normalizeIr(parseBy('gemini'));

    // Deep-equal across all three: the IR is genuinely dialect-independent.
    expect(anthropic).toEqual(ir);
    expect(gemini).toEqual(ir);

    // Spot-check the converged semantic content so a future shape change is loud.
    expect(ir.model).toBe(MODEL);
    expect(ir.messages[0]).toEqual({
      role: 'system',
      content: [{ kind: 'text', text: 'be brief' }],
    });
    expect(ir.messages[1]?.content).toEqual([
      { kind: 'text', text: 'what is in this image and the weather?' },
      { kind: 'image', source: 'base64', data: 'aGk=', mime: 'image/png' },
    ]);
    expect(ir.messages[2]?.toolCalls).toEqual([
      { id: 'id_0', name: 'get_weather', arguments: { city: 'SF' } },
    ]);
    expect(ir.messages[3]).toEqual({
      role: 'tool',
      content: [{ kind: 'text', text: '{"v":42}' }],
      toolCallId: 'id_0',
    });
    expect(ir.tools).toEqual([
      {
        name: 'get_weather',
        description: undefined,
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ]);
    expect(ir.params).toEqual({ temperature: 0.2, maxOutputTokens: 256 });
  });

  it('each parser independently preserves the image + tool definition', () => {
    for (const d of DIALECTS) {
      const ir = parseBy(d);
      const userTurn = ir.messages.find((m) => m.role === 'user');
      expect(userTurn?.content).toContainEqual({
        kind: 'image',
        source: 'base64',
        data: 'aGk=',
        mime: 'image/png',
      });
      expect(ir.tools?.[0]?.name).toBe('get_weather');
    }
  });
});

/**
 * A canonical IR assistant response: one text part, one tool call, and usage in
 * the IR's camelCase shape. Feeding this through every renderer is the outbound
 * half of the matrix.
 */
const canonicalResponse: ChatResponse = {
  message: {
    role: 'assistant',
    content: [{ kind: 'text', text: 'a cat; sunny' }],
    toolCalls: [{ id: 'tc_1', name: 'get_weather', arguments: { city: 'SF' } }],
  },
  stopReason: 'tool_calls',
  usage: { inputTokens: 10, outputTokens: 4 },
};

describe('parse→IR→render matrix (full 3×3, incl. same-dialect identity)', () => {
  for (const source of DIALECTS) {
    for (const target of DIALECTS) {
      it(`${source} request → IR → ${target} response preserves text + tool call`, () => {
        // Inbound: parse the source dialect's request into the IR (asserting the
        // parse path is wired for every source), then render the canonical IR
        // response out to the target dialect's wire shape.
        const ir = parseBy(source);
        expect(ir.messages.length).toBeGreaterThan(0);

        const wire = renderBy(target, canonicalResponse);

        if (target === 'openai') {
          const w = wire as {
            object: string;
            choices: {
              message: { content: string | null; tool_calls?: { function: { name: string } }[] };
              finish_reason: string;
            }[];
          };
          expect(w.object).toBe('chat.completion');
          expect(w.choices[0]?.message.content).toBe('a cat; sunny');
          expect(w.choices[0]?.message.tool_calls?.[0]?.function.name).toBe('get_weather');
          expect(w.choices[0]?.finish_reason).toBe('tool_calls');
        } else if (target === 'anthropic') {
          const w = wire as {
            type: string;
            stop_reason: string;
            content: { type: string; text?: string; name?: string }[];
          };
          expect(w.type).toBe('message');
          expect(w.stop_reason).toBe('tool_use');
          expect(w.content).toContainEqual({ type: 'text', text: 'a cat; sunny' });
          expect(w.content).toContainEqual({
            type: 'tool_use',
            id: 'tc_1',
            name: 'get_weather',
            input: { city: 'SF' },
          });
        } else {
          const w = wire as {
            candidates: {
              content: { parts: { text?: string; functionCall?: { name: string } }[] };
              finishReason: string;
            }[];
          };
          const parts = w.candidates[0]?.content.parts ?? [];
          expect(parts).toContainEqual({ text: 'a cat; sunny' });
          expect(parts).toContainEqual({
            functionCall: { name: 'get_weather', args: { city: 'SF' } },
          });
          // Gemini has no tool-specific finish; the functionCall part signals it.
          expect(w.candidates[0]?.finishReason).toBe('STOP');
        }
      });
    }
  }
});

describe('usage-casing invariant (one camelCase IR usage → each wire dialect)', () => {
  const res: ChatResponse = {
    message: { role: 'assistant', content: [{ kind: 'text', text: 'ok' }] },
    stopReason: 'stop',
    usage: { inputTokens: 11, outputTokens: 7 },
  };

  it('OpenAI emits prompt_tokens/completion_tokens (never inputTokens)', () => {
    const wire = renderOpenAIChat(res, MODEL);
    expect(wire.usage).toEqual({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
    expect(JSON.stringify(wire)).not.toMatch(/inputTokens|outputTokens|input_tokens/);
  });

  it('Anthropic emits input_tokens/output_tokens (never camelCase)', () => {
    const wire = renderAnthropicChat(res, MODEL);
    expect(wire.usage).toEqual({ input_tokens: 11, output_tokens: 7 });
    expect(JSON.stringify(wire)).not.toMatch(/inputTokens|outputTokens|prompt_tokens/);
  });

  it('Gemini emits promptTokenCount/candidatesTokenCount (never IR shape)', () => {
    const wire = renderGeminiChat(res);
    expect(wire.usageMetadata).toEqual({
      promptTokenCount: 11,
      candidatesTokenCount: 7,
      totalTokenCount: 18,
    });
    expect(JSON.stringify(wire)).not.toMatch(/inputTokens|outputTokens|input_tokens/);
  });
});

describe('streaming matrix slice (one IR event sequence → every dialect)', () => {
  // eslint-disable-next-line @typescript-eslint/require-await
  async function* events(evs: ChatStreamEvent[]): AsyncIterable<ChatStreamEvent> {
    for (const e of evs) yield e;
  }
  async function collect(it: AsyncIterable<string>): Promise<string> {
    let out = '';
    for await (const s of it) out += s;
    return out;
  }

  const sequence: ChatStreamEvent[] = [
    { type: 'message_start' },
    { type: 'content_delta', text: 'a cat' },
    {
      type: 'tool_call_delta',
      index: 0,
      id: 'tc_1',
      name: 'get_weather',
      argumentsDelta: '{"city":"SF"}',
    },
    { type: 'usage', usage: { inputTokens: 9, outputTokens: 5 } },
    { type: 'stop', stopReason: 'tool_calls' },
    { type: 'done' },
  ];

  it('OpenAI stream: well-formed chunk frames, tool_calls delta, [DONE]', async () => {
    const out = await collect(renderOpenAIChatStream(events(sequence), MODEL));
    const frames = out.split('\n\n').filter((f) => f.startsWith('data: '));
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.at(-1)).toBe('data: [DONE]');
    for (const f of frames) {
      if (f === 'data: [DONE]') continue;
      // Every non-sentinel frame must be valid JSON of the chunk object kind.
      const obj = JSON.parse(f.slice('data: '.length)) as { object: string };
      expect(obj.object).toBe('chat.completion.chunk');
    }
    expect(out).toContain('"content":"a cat"');
    expect(out).toContain('"get_weather"');
    expect(out).toContain('"finish_reason":"tool_calls"');
    // Usage in OpenAI wire casing, never the IR shape.
    expect(out).toContain('"prompt_tokens":9');
    expect(out).not.toMatch(/inputTokens|outputTokens/);
  });

  it('Anthropic stream: typed events, tool_use block, message_stop', async () => {
    const out = await collect(renderAnthropicMessagesStream(events(sequence), MODEL));
    expect(out).toContain('event: message_start');
    expect(out).toContain('event: content_block_start');
    expect(out).toContain('"text_delta"');
    expect(out).toContain('"type":"tool_use"');
    expect(out).toContain('"input_json_delta"');
    expect(out).toContain('event: message_delta');
    expect(out).toContain('event: message_stop');
    expect(out).toContain('"stop_reason":"tool_use"');
    // Each frame is event-typed and carries a JSON-parseable data line.
    const frames = out.split('\n\n').filter((f) => f.length > 0);
    for (const f of frames) {
      const match = /^event: .+\ndata: (.+)$/s.exec(f);
      expect(match).not.toBeNull();
      const json: unknown = JSON.parse(match?.[1] ?? '');
      expect(json).toBeTypeOf('object');
    }
    // Anthropic emits its own usage casing; the IR camelCase never leaks.
    expect(out).not.toMatch(/inputTokens|outputTokens/);
  });

  it('Gemini stream: candidate chunks, functionCall part, finishReason + usage', async () => {
    const out = await collect(renderGeminiGenerateContentStream(events(sequence)));
    const frames = out.split('\n\n').filter((f) => f.startsWith('data: '));
    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(out).not.toContain('[DONE]'); // Gemini has no sentinel.
    for (const f of frames) {
      const obj = JSON.parse(f.slice('data: '.length)) as { candidates: unknown[] };
      expect(Array.isArray(obj.candidates)).toBe(true);
    }
    expect(out).toContain('"text":"a cat"');
    expect(out).toContain('"functionCall"');
    expect(out).toContain('"get_weather"');
    expect(out).toContain('"finishReason":"STOP"');
    expect(out).toContain('"promptTokenCount":9');
    expect(out).not.toMatch(/inputTokens|outputTokens/);
  });
});

describe('cross-dialect translation round-trips (tools + image)', () => {
  it('OpenAI request → IR → Anthropic response → IR → OpenAI response', () => {
    // 1. Inbound OpenAI request with a base64 image + a tool definition.
    const ir = parseOpenAIChat({
      model: MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is in this image and the weather?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,aGk=' } },
          ],
        },
      ],
      tools: [
        { type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } },
      ],
    });
    expect(ir.messages[0]?.content[1]).toEqual({
      kind: 'image',
      source: 'base64',
      data: 'aGk=',
      mime: 'image/png',
    });

    // 2. Render an assistant response to the Anthropic dialect.
    const anthropicResp = renderAnthropicChat(
      {
        message: {
          role: 'assistant',
          content: [{ kind: 'text', text: 'a cat; sunny' }],
          toolCalls: [{ id: 'tu1', name: 'get_weather', arguments: { city: 'SF' } }],
        },
        stopReason: 'tool_calls',
        usage: { inputTokens: 10, outputTokens: 4 },
      },
      'claude-3-5-sonnet',
    );

    // 3. Re-parse the Anthropic assistant message back to IR, then render OpenAI.
    const backToIr = parseAnthropicChat({
      model: 'claude-3-5-sonnet',
      max_tokens: 16,
      messages: [{ role: 'assistant', content: (anthropicResp as { content: unknown }).content }],
    });
    const assistant = backToIr.messages[0];
    expect(assistant).toBeDefined();
    const openaiOut = renderOpenAIChat(
      {
        message: assistant ?? { role: 'assistant', content: [] },
        stopReason: 'tool_calls',
        usage: { inputTokens: 10, outputTokens: 4 },
      },
      MODEL,
    );
    const choice = (
      openaiOut as { choices: { message: { tool_calls: { function: { name: string } }[] } }[] }
    ).choices[0];
    expect(choice?.message.tool_calls[0]?.function.name).toBe('get_weather');
  });

  it('round-trips a gemini request through IR (image + function)', () => {
    const ir = parseGeminiChat(
      {
        contents: [
          {
            role: 'user',
            parts: [
              { text: 'caption this' },
              { inlineData: { mimeType: 'image/png', data: 'aGk=' } },
            ],
          },
        ],
        tools: [{ functionDeclarations: [{ name: 'cap', parameters: { type: 'object' } }] }],
      },
      'gemini-1.5-pro',
    );
    const out = renderGeminiChat({
      message: {
        role: 'assistant',
        content: [{ kind: 'text', text: 'a cat' }],
        toolCalls: [{ id: 'cap', name: 'cap', arguments: {} }],
      },
      stopReason: 'tool_calls',
      usage: { inputTokens: 5, outputTokens: 1 },
    });
    expect(ir.tools?.[0]?.name).toBe('cap');
    expect(ir.messages[0]?.content[1]).toEqual({
      kind: 'image',
      source: 'base64',
      data: 'aGk=',
      mime: 'image/png',
    });
    expect((out as { candidates: unknown[] }).candidates).toHaveLength(1);
  });
});
