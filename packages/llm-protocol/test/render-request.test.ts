import type { ChatRequest } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import { renderAnthropicRequest } from '../src/anthropic/index.js';
import { renderGeminiRequest } from '../src/gemini/index.js';
import { renderOpenAIRequest } from '../src/openai/index.js';

const ir: ChatRequest = {
  model: 'm',
  messages: [
    { role: 'system', content: [{ kind: 'text', text: 'be brief' }] },
    { role: 'user', content: [{ kind: 'text', text: 'hi' }] },
  ],
  tools: [{ name: 'f', parameters: { type: 'object' } }],
  params: { temperature: 0.2, maxOutputTokens: 64 },
};

describe('renderOpenAIRequest', () => {
  it('keeps system as a message and maps tools[].function', () => {
    const body = renderOpenAIRequest(ir, 'gpt-4o');
    expect(body).toMatchObject({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ],
      temperature: 0.2,
      max_tokens: 64,
      tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }],
    });
  });
});

describe('renderAnthropicRequest', () => {
  it('hoists system to a top-level param and uses input_schema', () => {
    const body = renderAnthropicRequest(ir, 'claude-3-5-sonnet');
    expect(body).toMatchObject({
      model: 'claude-3-5-sonnet',
      system: 'be brief',
      max_tokens: 64,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [{ name: 'f', input_schema: { type: 'object' } }],
    });
    expect((body as { messages: unknown[] }).messages).toHaveLength(1);
  });
});

describe('renderGeminiRequest', () => {
  it('hoists system to systemInstruction and uses functionDeclarations', () => {
    const body = renderGeminiRequest(ir);
    expect(body).toMatchObject({
      systemInstruction: { parts: [{ text: 'be brief' }] },
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      tools: [{ functionDeclarations: [{ name: 'f', parameters: { type: 'object' } }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 64 },
    });
  });
});
