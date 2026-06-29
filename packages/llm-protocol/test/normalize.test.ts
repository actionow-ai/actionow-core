import type { ChatRequest } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import { readCapabilities } from '../src/capabilities.js';
import { ProtocolError } from '../src/errors.js';
import { normalizeRequest } from '../src/normalize.js';

const base: ChatRequest = {
  model: 'm',
  messages: [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }],
};

describe('normalizeRequest', () => {
  it('passes a text request through when the model supports text', () => {
    const out = normalizeRequest(base, {
      tools: false,
      vision: false,
      audio: false,
      json: false,
    });
    expect(out.messages).toHaveLength(1);
  });

  it('400s when tools are sent to a model without tool capability', () => {
    const withTools: ChatRequest = {
      ...base,
      tools: [{ name: 'f', parameters: { type: 'object' } }],
    };
    expect(() =>
      normalizeRequest(withTools, { tools: false, vision: false, audio: false, json: false }),
    ).toThrow(ProtocolError);
  });

  it('400s when an image part is sent to a non-vision model', () => {
    const withImg: ChatRequest = {
      ...base,
      messages: [
        { role: 'user', content: [{ kind: 'image', source: 'url', data: 'http://x/y.png' }] },
      ],
    };
    expect(() =>
      normalizeRequest(withImg, { tools: false, vision: false, audio: false, json: false }),
    ).toThrow(ProtocolError);
  });

  it('400s on json_object responseFormat for a non-json model', () => {
    const withJson: ChatRequest = { ...base, params: { responseFormat: 'json_object' } };
    expect(() =>
      normalizeRequest(withJson, { tools: false, vision: false, audio: false, json: false }),
    ).toThrow(ProtocolError);
  });

  it('400s when a file part is sent to a model without file capability', () => {
    const withFile: ChatRequest = {
      ...base,
      messages: [
        { role: 'user', content: [{ kind: 'file', source: 'url', data: 'http://x/doc.pdf' }] },
      ],
    };
    expect(() =>
      normalizeRequest(withFile, { tools: false, vision: false, audio: false, json: false }),
    ).toThrow(ProtocolError);
  });

  it('allows a file part when the model declares file capability', () => {
    const withFile: ChatRequest = {
      ...base,
      messages: [
        { role: 'user', content: [{ kind: 'file', source: 'url', data: 'http://x/doc.pdf' }] },
      ],
    };
    const out = normalizeRequest(withFile, {
      tools: false,
      vision: false,
      audio: false,
      json: false,
      file: true,
    });
    expect(out.messages).toHaveLength(1);
  });

  it('allows everything when the model declares full capability', () => {
    const full: ChatRequest = {
      ...base,
      tools: [{ name: 'f', parameters: { type: 'object' } }],
      params: { responseFormat: 'json_object' },
      messages: [
        { role: 'user', content: [{ kind: 'image', source: 'url', data: 'http://x/y.png' }] },
      ],
    };
    const out = normalizeRequest(full, { tools: true, vision: true, audio: true, json: true });
    expect(out.tools).toHaveLength(1);
  });

  it('DOWNGRADES (drops) temperature/top_p/stop + penalties/logprobs for a reasoning model', () => {
    const req: ChatRequest = {
      ...base,
      params: { temperature: 0.7, topP: 0.9, stop: ['END'], maxOutputTokens: 256 },
      extra: {
        presence_penalty: 0.5,
        frequency_penalty: 0.2,
        logprobs: true,
        top_logprobs: 5,
        prompt_cache_key: 'keep-me',
      },
    };
    const out = normalizeRequest(req, {
      tools: false,
      vision: false,
      audio: false,
      json: false,
      reasoning: true,
    });
    // The rejected sampling params are gone…
    expect(out.params?.temperature).toBeUndefined();
    expect(out.params?.topP).toBeUndefined();
    expect(out.params?.stop).toBeUndefined();
    // …but harmless params survive.
    expect(out.params?.maxOutputTokens).toBe(256);
    // Penalties/logprobs stripped from extra; the cache key is untouched.
    expect(out.extra).toEqual({ prompt_cache_key: 'keep-me' });
  });

  it('does NOT downgrade params for a non-reasoning model', () => {
    const req: ChatRequest = {
      ...base,
      params: { temperature: 0.7, topP: 0.9, stop: ['END'] },
      extra: { presence_penalty: 0.5 },
    };
    const out = normalizeRequest(req, {
      tools: false,
      vision: false,
      audio: false,
      json: false,
      reasoning: false,
    });
    expect(out.params).toEqual({ temperature: 0.7, topP: 0.9, stop: ['END'] });
    expect(out.extra).toEqual({ presence_penalty: 0.5 });
  });

  it('still 400s a reasoning model on genuine capability misuse (tools)', () => {
    const withTools: ChatRequest = {
      ...base,
      tools: [{ name: 'f', parameters: { type: 'object' } }],
      params: { temperature: 0.7 },
    };
    expect(() =>
      normalizeRequest(withTools, {
        tools: false,
        vision: false,
        audio: false,
        json: false,
        reasoning: true,
      }),
    ).toThrow(ProtocolError);
  });
});

describe('readCapabilities', () => {
  it('reads only strict boolean-true flags', () => {
    expect(
      readCapabilities({
        tools: true,
        vision: true,
        audio: true,
        json: true,
        file: true,
        reasoning: true,
      }),
    ).toEqual({
      tools: true,
      vision: true,
      audio: true,
      json: true,
      file: true,
      reasoning: true,
    });
  });

  it('tolerates missing and garbage values (only === true counts)', () => {
    expect(readCapabilities({})).toEqual({
      tools: false,
      vision: false,
      audio: false,
      json: false,
      file: false,
      reasoning: false,
    });
    expect(readCapabilities({ tools: 'true', vision: 1, audio: null, json: undefined })).toEqual({
      tools: false,
      vision: false,
      audio: false,
      json: false,
      file: false,
      reasoning: false,
    });
  });
});
