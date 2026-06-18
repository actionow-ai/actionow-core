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
});

describe('readCapabilities', () => {
  it('reads only strict boolean-true flags', () => {
    expect(
      readCapabilities({ tools: true, vision: true, audio: true, json: true, file: true }),
    ).toEqual({
      tools: true,
      vision: true,
      audio: true,
      json: true,
      file: true,
    });
  });

  it('tolerates missing and garbage values (only === true counts)', () => {
    expect(readCapabilities({})).toEqual({
      tools: false,
      vision: false,
      audio: false,
      json: false,
      file: false,
    });
    expect(readCapabilities({ tools: 'true', vision: 1, audio: null, json: undefined })).toEqual({
      tools: false,
      vision: false,
      audio: false,
      json: false,
      file: false,
    });
  });
});
