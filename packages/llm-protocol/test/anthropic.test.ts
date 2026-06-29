import { describe, expect, it } from 'vitest';

import { parseAnthropicChat, renderAnthropicChat } from '../src/anthropic/index.js';

describe('parseAnthropicChat', () => {
  it('hoists the top-level system param into a system message', () => {
    const ir = parseAnthropicChat({
      model: 'claude-3-5-sonnet',
      max_tokens: 256,
      system: 'be brief',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(ir.messages[0]).toEqual({
      role: 'system',
      content: [{ kind: 'text', text: 'be brief' }],
    });
    expect(ir.messages[1]).toEqual({ role: 'user', content: [{ kind: 'text', text: 'hi' }] });
    expect(ir.params?.maxOutputTokens).toBe(256);
  });

  it('joins a top-level system block array into a system message', () => {
    const ir = parseAnthropicChat({
      model: 'claude-3-5-sonnet',
      max_tokens: 16,
      system: [
        { type: 'text', text: 'be ' },
        { type: 'text', text: 'brief' },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(ir.messages[0]).toEqual({
      role: 'system',
      content: [{ kind: 'text', text: 'be brief' }],
    });
  });

  it('maps tool_use and tool_result content blocks', () => {
    const ir = parseAnthropicChat({
      model: 'claude-3-5-sonnet',
      max_tokens: 256,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu1', name: 'f', input: { a: 1 } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '42' }],
        },
      ],
      tools: [{ name: 'f', input_schema: { type: 'object' } }],
    });
    expect(ir.tools?.[0]).toEqual({
      name: 'f',
      description: undefined,
      parameters: { type: 'object' },
    });
    expect(ir.messages[0]?.toolCalls?.[0]).toEqual({ id: 'tu1', name: 'f', arguments: { a: 1 } });
    expect(ir.messages[1]).toEqual({
      role: 'tool',
      content: [{ kind: 'text', text: '42' }],
      toolCallId: 'tu1',
    });
  });

  it('maps a tool_result whose content is a block array', () => {
    const ir = parseAnthropicChat({
      model: 'claude-3-5-sonnet',
      max_tokens: 16,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu1',
              content: [{ type: 'text', text: '42' }],
            },
          ],
        },
      ],
    });
    expect(ir.messages[0]).toEqual({
      role: 'tool',
      content: [{ kind: 'text', text: '42' }],
      toolCallId: 'tu1',
    });
  });

  it('maps an image source.base64 block', () => {
    const ir = parseAnthropicChat({
      model: 'claude-3-5-sonnet',
      max_tokens: 16,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'aGk=' },
            },
          ],
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

  it('maps an image source.url block', () => {
    const ir = parseAnthropicChat({
      model: 'claude-3-5-sonnet',
      max_tokens: 16,
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', source: { type: 'url', url: 'http://x/y.png' } }],
        },
      ],
    });
    expect(ir.messages[0]?.content[0]).toEqual({
      kind: 'image',
      source: 'url',
      data: 'http://x/y.png',
    });
  });

  it('maps tool_choice forms and remaining params', () => {
    const any = parseAnthropicChat({
      model: 'claude-3-5-sonnet',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
      tool_choice: { type: 'any' },
      temperature: 0.3,
      top_p: 0.8,
      stop_sequences: ['x', 'y'],
    });
    expect(any.toolChoice).toBe('required');
    expect(any.params?.temperature).toBe(0.3);
    expect(any.params?.topP).toBe(0.8);
    expect(any.params?.stop).toEqual(['x', 'y']);

    const auto = parseAnthropicChat({
      model: 'claude-3-5-sonnet',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
      tool_choice: { type: 'auto' },
    });
    expect(auto.toolChoice).toBe('auto');

    const named = parseAnthropicChat({
      model: 'claude-3-5-sonnet',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
      tool_choice: { type: 'tool', name: 'f' },
    });
    expect(named.toolChoice).toEqual({ name: 'f' });
  });

  it('lifts thinking.budget_tokens + output_config.effort into reasoning params and sweeps the rest into extra', () => {
    const ir = parseAnthropicChat({
      model: 'claude-opus-4-8',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hi' }],
      top_k: 40,
      thinking: { type: 'enabled', budget_tokens: 2048 },
      service_tier: 'standard_only',
      metadata: { user_id: 'u1' },
    });
    expect(ir.params?.reasoningBudgetTokens).toBe(2048);
    // `thinking`/`output_config`/`system` are consumed, NOT re-leaked into extra.
    expect(ir.extra).toEqual({
      top_k: 40,
      service_tier: 'standard_only',
      metadata: { user_id: 'u1' },
    });
  });

  it('maps output_config.effort (and clamps `max`) to the normalized effort enum', () => {
    const high = parseAnthropicChat({
      model: 'claude-opus-4-8',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
      output_config: { effort: 'high' },
    });
    expect(high.params?.reasoningEffort).toBe('high');
    const max = parseAnthropicChat({
      model: 'claude-opus-4-8',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
      output_config: { effort: 'max' },
    });
    expect(max.params?.reasoningEffort).toBe('xhigh');
  });

  it('throws ProtocolError when messages is absent', () => {
    expect(() => parseAnthropicChat({ model: 'claude-3-5-sonnet', max_tokens: 16 })).toThrow();
  });

  it('throws ProtocolError on an unknown role', () => {
    expect(() =>
      parseAnthropicChat({
        model: 'claude-3-5-sonnet',
        max_tokens: 16,
        messages: [{ role: 'robot', content: 'hi' }],
      }),
    ).toThrow();
  });
});

describe('renderAnthropicChat', () => {
  it('renders a message with text + tool_use blocks and usage', () => {
    const wire = renderAnthropicChat(
      {
        message: {
          role: 'assistant',
          content: [{ kind: 'text', text: 'sure' }],
          toolCalls: [{ id: 'tu1', name: 'f', arguments: { a: 1 } }],
        },
        stopReason: 'tool_calls',
        usage: { inputTokens: 3, outputTokens: 2 },
      },
      'claude-3-5-sonnet',
    );
    expect(wire).toMatchObject({
      type: 'message',
      role: 'assistant',
      model: 'claude-3-5-sonnet',
      stop_reason: 'tool_use',
      usage: { input_tokens: 3, output_tokens: 2 },
    });
    const content = (wire as { content: { type: string }[] }).content;
    expect(content).toEqual([
      { type: 'text', text: 'sure' },
      { type: 'tool_use', id: 'tu1', name: 'f', input: { a: 1 } },
    ]);
  });

  it('maps stop_reason stop→end_turn and length→max_tokens', () => {
    const ended = renderAnthropicChat(
      {
        message: { role: 'assistant', content: [{ kind: 'text', text: 'ok' }] },
        stopReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      'claude-3-5-sonnet',
    );
    expect((ended as { stop_reason: string }).stop_reason).toBe('end_turn');

    const truncated = renderAnthropicChat(
      {
        message: { role: 'assistant', content: [{ kind: 'text', text: 'ok' }] },
        stopReason: 'length',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      'claude-3-5-sonnet',
    );
    expect((truncated as { stop_reason: string }).stop_reason).toBe('max_tokens');
  });
});
