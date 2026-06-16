import { describe, expect, it } from 'vitest';

import { parseGeminiChat, renderGeminiChat } from '../src/gemini/index.js';

describe('parseGeminiChat', () => {
  it('maps systemInstruction + contents roles (model→assistant)', () => {
    const ir = parseGeminiChat(
      {
        systemInstruction: { parts: [{ text: 'be brief' }] },
        contents: [
          { role: 'user', parts: [{ text: 'hi' }] },
          { role: 'model', parts: [{ text: 'hello' }] },
        ],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 64,
          responseMimeType: 'application/json',
        },
      },
      'gemini-1.5-pro',
    );
    expect(ir.model).toBe('gemini-1.5-pro');
    expect(ir.messages[0]).toEqual({
      role: 'system',
      content: [{ kind: 'text', text: 'be brief' }],
    });
    expect(ir.messages[1]).toEqual({
      role: 'user',
      content: [{ kind: 'text', text: 'hi' }],
    });
    expect(ir.messages[2]).toEqual({
      role: 'assistant',
      content: [{ kind: 'text', text: 'hello' }],
    });
    expect(ir.params?.temperature).toBe(0.3);
    expect(ir.params?.maxOutputTokens).toBe(64);
    expect(ir.params?.responseFormat).toBe('json_object');
  });

  it('maps functionCall / functionResponse / functionDeclarations', () => {
    const ir = parseGeminiChat(
      {
        contents: [
          { role: 'model', parts: [{ functionCall: { name: 'f', args: { a: 1 } } }] },
          { role: 'user', parts: [{ functionResponse: { name: 'f', response: { v: 42 } } }] },
        ],
        tools: [{ functionDeclarations: [{ name: 'f', parameters: { type: 'object' } }] }],
      },
      'gemini-1.5-pro',
    );
    expect(ir.tools?.[0]).toEqual({
      name: 'f',
      description: undefined,
      parameters: { type: 'object' },
    });
    expect(ir.messages[0]?.toolCalls?.[0]?.name).toBe('f');
    expect(ir.messages[0]?.toolCalls?.[0]?.arguments).toEqual({ a: 1 });
    expect(ir.messages[1]).toMatchObject({ role: 'tool', name: 'f' });
    // functionResponse's tool message references the synthesized call id by name.
    expect(ir.messages[1]?.toolCallId).toBe(ir.messages[0]?.toolCalls?.[0]?.id);
  });

  it('synthesizes a stable call id of the form call_<name>_<index>', () => {
    const ir = parseGeminiChat(
      {
        contents: [
          {
            role: 'model',
            parts: [
              { functionCall: { name: 'f', args: {} } },
              { functionCall: { name: 'g', args: {} } },
            ],
          },
        ],
      },
      'gemini-1.5-pro',
    );
    expect(ir.messages[0]?.toolCalls?.[0]?.id).toBe('call_f_0');
    expect(ir.messages[0]?.toolCalls?.[1]?.id).toBe('call_g_1');
  });

  it('maps inlineData (base64 image)', () => {
    const ir = parseGeminiChat(
      {
        contents: [
          { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'aGk=' } }] },
        ],
      },
      'gemini-1.5-pro',
    );
    expect(ir.messages[0]?.content[0]).toEqual({
      kind: 'image',
      source: 'base64',
      data: 'aGk=',
      mime: 'image/png',
    });
  });

  it('maps fileData to a file part', () => {
    const ir = parseGeminiChat(
      {
        contents: [
          {
            role: 'user',
            parts: [{ fileData: { fileUri: 'gs://bucket/x.pdf', mimeType: 'application/pdf' } }],
          },
        ],
      },
      'gemini-1.5-pro',
    );
    expect(ir.messages[0]?.content[0]).toEqual({
      kind: 'file',
      source: 'url',
      data: 'gs://bucket/x.pdf',
      mime: 'application/pdf',
    });
  });

  it('maps toolConfig.functionCallingConfig.mode and stopSequences', () => {
    const auto = parseGeminiChat(
      {
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
        generationConfig: { topP: 0.8, stopSequences: ['x', 'y'] },
      },
      'gemini-1.5-pro',
    );
    expect(auto.toolChoice).toBe('auto');
    expect(auto.params?.topP).toBe(0.8);
    expect(auto.params?.stop).toEqual(['x', 'y']);

    const any = parseGeminiChat(
      {
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        toolConfig: { functionCallingConfig: { mode: 'ANY' } },
      },
      'gemini-1.5-pro',
    );
    expect(any.toolChoice).toBe('required');

    const none = parseGeminiChat(
      {
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        toolConfig: { functionCallingConfig: { mode: 'NONE' } },
      },
      'gemini-1.5-pro',
    );
    expect(none.toolChoice).toBe('none');
  });

  it('throws ProtocolError when contents is absent', () => {
    expect(() => parseGeminiChat({}, 'gemini-1.5-pro')).toThrow();
  });

  it('throws ProtocolError on an unknown role', () => {
    expect(() =>
      parseGeminiChat({ contents: [{ role: 'robot', parts: [{ text: 'hi' }] }] }, 'gemini-1.5-pro'),
    ).toThrow();
  });
});

describe('renderGeminiChat', () => {
  it('renders a candidate with text + functionCall and usageMetadata', () => {
    const wire = renderGeminiChat({
      message: {
        role: 'assistant',
        content: [{ kind: 'text', text: 'sure' }],
        toolCalls: [{ id: 'x', name: 'f', arguments: { a: 1 } }],
      },
      stopReason: 'tool_calls',
      usage: { inputTokens: 3, outputTokens: 2 },
    });
    expect(wire).toMatchObject({
      candidates: [{ content: { role: 'model' }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
    });
    const parts = (wire as { candidates: { content: { parts: unknown[] } }[] }).candidates[0]
      ?.content.parts;
    expect(parts).toEqual([{ text: 'sure' }, { functionCall: { name: 'f', args: { a: 1 } } }]);
  });

  it('maps finishReason stop→STOP, length→MAX_TOKENS, content_filter→SAFETY', () => {
    const stop = renderGeminiChat({
      message: { role: 'assistant', content: [{ kind: 'text', text: 'ok' }] },
      stopReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    expect((stop as { candidates: { finishReason: string }[] }).candidates[0]?.finishReason).toBe(
      'STOP',
    );

    const length = renderGeminiChat({
      message: { role: 'assistant', content: [{ kind: 'text', text: 'ok' }] },
      stopReason: 'length',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    expect((length as { candidates: { finishReason: string }[] }).candidates[0]?.finishReason).toBe(
      'MAX_TOKENS',
    );

    const filtered = renderGeminiChat({
      message: { role: 'assistant', content: [{ kind: 'text', text: 'ok' }] },
      stopReason: 'content_filter',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    expect(
      (filtered as { candidates: { finishReason: string }[] }).candidates[0]?.finishReason,
    ).toBe('SAFETY');
  });
});
