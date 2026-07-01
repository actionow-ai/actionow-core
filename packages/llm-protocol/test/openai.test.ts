import { describe, expect, it } from 'vitest';

import { parseOpenAIChat, renderOpenAIChat } from '../src/openai/index.js';

describe('parseOpenAIChat', () => {
  it('maps system/user roles, string content, and params', () => {
    const ir = parseOpenAIChat({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ],
      temperature: 0.5,
      max_tokens: 100,
      response_format: { type: 'json_object' },
    });
    expect(ir.model).toBe('gpt-4o');
    expect(ir.messages[0]).toEqual({
      role: 'system',
      content: [{ kind: 'text', text: 'be brief' }],
    });
    expect(ir.params?.temperature).toBe(0.5);
    expect(ir.params?.maxOutputTokens).toBe(100);
    expect(ir.params?.responseFormat).toBe('json_object');
  });

  it('maps tools[].function and assistant tool_calls', () => {
    const ir = parseOpenAIChat({
      model: 'gpt-4o',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'c1', content: '42' },
      ],
      tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }],
    });
    expect(ir.tools?.[0]).toEqual({
      name: 'f',
      description: undefined,
      parameters: { type: 'object' },
    });
    expect(ir.messages[0]?.toolCalls?.[0]).toEqual({ id: 'c1', name: 'f', arguments: { a: 1 } });
    expect(ir.messages[1]).toMatchObject({ role: 'tool', toolCallId: 'c1' });
  });

  it('maps an image_url content part', () => {
    const ir = parseOpenAIChat({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image_url', image_url: { url: 'http://x/y.png' } },
          ],
        },
      ],
    });
    expect(ir.messages[0]?.content).toEqual([
      { kind: 'text', text: 'what is this' },
      { kind: 'image', source: 'url', data: 'http://x/y.png' },
    ]);
  });

  it('extracts mime + base64 from a data: image_url', () => {
    const ir = parseOpenAIChat({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGk=' } }],
        },
      ],
    });
    expect(ir.messages[0]?.content[0]).toEqual({
      kind: 'image',
      source: 'base64',
      data: 'aGk=',
      mime: 'image/png',
    });
  });

  it('maps tool_choice forms and remaining params', () => {
    const auto = parseOpenAIChat({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      tool_choice: 'required',
      top_p: 0.9,
      stop: ['x'],
      seed: 7,
    });
    expect(auto.toolChoice).toBe('required');
    expect(auto.params?.topP).toBe(0.9);
    expect(auto.params?.stop).toEqual(['x']);
    expect(auto.params?.seed).toBe(7);

    const named = parseOpenAIChat({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      tool_choice: { type: 'function', function: { name: 'f' } },
    });
    expect(named.toolChoice).toEqual({ name: 'f' });
  });

  it('sweeps unknown body keys into extra and lifts reasoning_effort + json_schema body', () => {
    const ir = parseOpenAIChat({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.5,
      presence_penalty: 0.3,
      frequency_penalty: 0.1,
      top_k: 40,
      n: 2,
      logprobs: true,
      top_logprobs: 5,
      logit_bias: { '50256': -100 },
      parallel_tool_calls: false,
      prompt_cache_key: 'pck',
      reasoning_effort: 'high',
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'r', schema: { type: 'object' }, strict: true },
      },
    });
    expect(ir.params?.reasoningEffort).toBe('high');
    expect(ir.params?.responseFormat).toBe('json_schema');
    expect(ir.params?.jsonSchema).toEqual({ type: 'object' });
    // First-class fields are NOT duplicated into extra; the rest passes through.
    expect(ir.extra).toEqual({
      presence_penalty: 0.3,
      frequency_penalty: 0.1,
      top_k: 40,
      n: 2,
      logprobs: true,
      top_logprobs: 5,
      logit_bias: { '50256': -100 },
      parallel_tool_calls: false,
      prompt_cache_key: 'pck',
    });
  });

  it('leaves extra unset when there is nothing unknown', () => {
    const ir = parseOpenAIChat({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.5,
    });
    expect(ir.extra).toBeUndefined();
  });

  it('throws ProtocolError when messages is absent', () => {
    expect(() => parseOpenAIChat({ model: 'gpt-4o' })).toThrow();
  });

  it('throws ProtocolError on an unknown role', () => {
    expect(() =>
      parseOpenAIChat({ model: 'gpt-4o', messages: [{ role: 'robot', content: 'hi' }] }),
    ).toThrow();
  });
});

describe('renderOpenAIChat', () => {
  it('renders a chat.completion with content + usage', () => {
    const wire = renderOpenAIChat(
      {
        message: { role: 'assistant', content: [{ kind: 'text', text: 'hello' }] },
        stopReason: 'stop',
        usage: { inputTokens: 3, outputTokens: 2 },
      },
      'gpt-4o',
    );
    expect(wire).toMatchObject({
      object: 'chat.completion',
      model: 'gpt-4o',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
  });

  it('renders assistant tool_calls with finish_reason tool_calls', () => {
    const wire = renderOpenAIChat(
      {
        message: {
          role: 'assistant',
          content: [],
          toolCalls: [{ id: 'c1', name: 'f', arguments: { a: 1 } }],
        },
        stopReason: 'tool_calls',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      'gpt-4o',
    );
    const choice = (
      wire as {
        choices: { message: { tool_calls: unknown; content: unknown }; finish_reason: string }[];
      }
    ).choices[0];
    expect(choice?.finish_reason).toBe('tool_calls');
    expect(choice?.message.content).toBeNull();
    expect(choice?.message.tool_calls).toEqual([
      { id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } },
    ]);
  });

  // P2-5 — the wire response surfaces `native_finish_reason` snake_case in the View
  // alongside the normalized `finish_reason`, ONLY when the IR carries it.
  it('surfaces native_finish_reason on the choice when the IR carries it', () => {
    const wire = renderOpenAIChat(
      {
        message: { role: 'assistant', content: [{ kind: 'text', text: 'x' }] },
        stopReason: 'content_filter',
        nativeFinishReason: 'content_filter',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      'gpt-4o',
    );
    const choice = (wire as { choices: Record<string, unknown>[] }).choices[0];
    expect(choice?.finish_reason).toBe('content_filter');
    expect(choice?.native_finish_reason).toBe('content_filter');
  });

  it('omits native_finish_reason when the IR did not carry one (non-breaking)', () => {
    const wire = renderOpenAIChat(
      {
        message: { role: 'assistant', content: [{ kind: 'text', text: 'x' }] },
        stopReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      'gpt-4o',
    );
    const choice = (wire as { choices: Record<string, unknown>[] }).choices[0];
    expect(choice).not.toHaveProperty('native_finish_reason');
  });
});
