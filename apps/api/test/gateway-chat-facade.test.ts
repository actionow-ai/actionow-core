// 批次5 slice3 — chat/embeddings OpenAI facade unit tests (§4.1 layer 1):
// alias 归一 (max_completion_tokens→max_tokens), messages/input anchors,
// isDefault marking (explicit=false / contract default=true), contract
// type/domain validation, undeclared-key verbatim carriage, envelope keys
// (model/stream/stream_options) excluded, idempotency fingerprinting.
import type { ModelOperation } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import {
  chatToGatewayRequest,
  embeddingsToGatewayRequest,
  type OpenAIFacadeInput,
} from '../src/gateway/chat-facade.js';
import { fingerprintBody } from '../src/gateway/facade.js';

const AUTH = { tenantId: 'tenant-1', apiKeyId: 'key-1' };

const CHAT_CONTRACT: ModelOperation = {
  operation: 'chat.completions',
  paradigms: ['sync', 'stream'],
  slow: false,
  params: [
    { name: 'messages', type: 'json', billingRelevant: false, required: true },
    {
      name: 'temperature',
      type: 'float',
      billingRelevant: false,
      required: false,
      default: 1,
      min: 0,
      max: 2,
    },
    { name: 'max_tokens', type: 'int', billingRelevant: false, required: false, min: 1 },
  ],
};

const MESSAGES = [{ role: 'user', content: 'hi' }];

function chatInput(
  body: Record<string, unknown>,
  overrides: Partial<OpenAIFacadeInput> = {},
): OpenAIFacadeInput {
  return {
    modelName: 'gpt-test',
    contract: CHAT_CONTRACT,
    body,
    auth: AUTH,
    ...overrides,
  };
}

describe('chatToGatewayRequest — §4.1 layer-1 canonical 归一', () => {
  it('maps the OpenAI wire onto GatewayRequest: explicit params isDefault:false, contract default rides isDefault:true', () => {
    const result = chatToGatewayRequest(
      chatInput({ model: 'gpt-test', messages: MESSAGES, max_tokens: 128 }),
    );
    if (!result.ok) throw new Error(result.error.message);
    const { request } = result;
    expect(request.operation).toBe('chat.completions');
    expect(request.model).toBe('gpt-test');
    expect(request.params.messages).toEqual({ value: MESSAGES, isDefault: false });
    expect(request.params.max_tokens).toEqual({ value: 128, isDefault: false });
    // contract default 补齐 — tagged isDefault, value NOT resolved further.
    expect(request.params.temperature).toEqual({ value: 1, isDefault: true });
  });

  it('normalizes the max_completion_tokens alias to canonical max_tokens', () => {
    const result = chatToGatewayRequest(
      chatInput({ model: 'gpt-test', messages: MESSAGES, max_completion_tokens: 64 }),
    );
    if (!result.ok) throw new Error(result.error.message);
    expect(result.request.params.max_tokens).toEqual({ value: 64, isDefault: false });
    expect(result.request.params.max_completion_tokens).toBeUndefined();
  });

  it('rejects BOTH alias spellings present (never guesses)', () => {
    const result = chatToGatewayRequest(
      chatInput({ model: 'gpt-test', messages: MESSAGES, max_tokens: 1, max_completion_tokens: 2 }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_input');
    expect(result.error.message).toContain('alias');
  });

  it('requires a messages array even when the catalog contract is the empty placeholder', () => {
    const empty: ModelOperation = { ...CHAT_CONTRACT, params: [] };
    const missing = chatToGatewayRequest(chatInput({ model: 'gpt-test' }, { contract: empty }));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('invalid_input');

    const notArray = chatToGatewayRequest(
      chatInput({ model: 'gpt-test', messages: 'hi' }, { contract: empty }),
    );
    expect(notArray.ok).toBe(false);
  });

  it('validates explicit values against the contract domain (§4 名/类型/值域)', () => {
    const result = chatToGatewayRequest(
      chatInput({ model: 'gpt-test', messages: MESSAGES, temperature: 9 }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_input');
    expect(result.error.message).toContain("'temperature'");
  });

  it('carries undeclared wire keys verbatim (drop-in surface; layer 2 owns their fate)', () => {
    const result = chatToGatewayRequest(
      chatInput({
        model: 'gpt-test',
        messages: MESSAGES,
        presence_penalty: 0.5,
        user: 'end-user-7',
        tools: [{ type: 'function', function: { name: 'f' } }],
      }),
    );
    if (!result.ok) throw new Error(result.error.message);
    expect(result.request.params.presence_penalty).toEqual({ value: 0.5, isDefault: false });
    expect(result.request.params.user).toEqual({ value: 'end-user-7', isDefault: false });
    expect(result.request.params.tools).toMatchObject({ isDefault: false });
  });

  it('treats model/stream/stream_options as envelope, never params; stream:true → options.stream', () => {
    const result = chatToGatewayRequest(
      chatInput({
        model: 'gpt-test',
        messages: MESSAGES,
        stream: true,
        stream_options: { include_usage: true },
      }),
    );
    if (!result.ok) throw new Error(result.error.message);
    expect(result.request.options.stream).toBe(true);
    expect(result.request.params.model).toBeUndefined();
    expect(result.request.params.stream).toBeUndefined();
    expect(result.request.params.stream_options).toBeUndefined();
  });

  it('threads the Idempotency-Key with the body fingerprint (§5)', () => {
    const body = { model: 'gpt-test', messages: MESSAGES };
    const result = chatToGatewayRequest(chatInput(body, { idempotencyKey: 'idem-1' }));
    if (!result.ok) throw new Error(result.error.message);
    expect(result.request.idempotency).toEqual({
      key: 'idem-1',
      bodyFingerprint: fingerprintBody(body),
    });
  });

  it('threads the route tag into options (§8 narrow-only pin)', () => {
    const result = chatToGatewayRequest(
      chatInput({ model: 'gpt-test', messages: MESSAGES }, { routeTag: 'canary' }),
    );
    if (!result.ok) throw new Error(result.error.message);
    expect(result.request.options.routeTag).toBe('canary');
  });

  it('rejects a missing contract-required param', () => {
    const contract: ModelOperation = {
      ...CHAT_CONTRACT,
      params: [
        ...CHAT_CONTRACT.params,
        { name: 'top_k', type: 'int', billingRelevant: false, required: true },
      ],
    };
    const result = chatToGatewayRequest(
      chatInput({ model: 'gpt-test', messages: MESSAGES }, { contract }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("'top_k'");
  });
});

const EMBED_CONTRACT: ModelOperation = {
  operation: 'embeddings',
  paradigms: ['sync'],
  slow: false,
  params: [
    { name: 'input', type: 'json', billingRelevant: false, required: true },
    {
      name: 'dimensions',
      type: 'int',
      billingRelevant: false,
      required: false,
      default: 1536,
    },
  ],
};

describe('embeddingsToGatewayRequest — §4.1 layer-1 canonical 归一', () => {
  it('maps input + defaults, operation embeddings, and never streams', () => {
    const result = embeddingsToGatewayRequest({
      modelName: 'embed-test',
      contract: EMBED_CONTRACT,
      body: { model: 'embed-test', input: ['a', 'b'], encoding_format: 'float', stream: true },
      auth: AUTH,
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.request.operation).toBe('embeddings');
    expect(result.request.params.input).toEqual({ value: ['a', 'b'], isDefault: false });
    expect(result.request.params.dimensions).toEqual({ value: 1536, isDefault: true });
    expect(result.request.params.encoding_format).toEqual({ value: 'float', isDefault: false });
    // embeddings never streams — the envelope `stream` key is ignored.
    expect(result.request.options.stream).toBeUndefined();
  });

  it("rejects a missing 'input'", () => {
    const result = embeddingsToGatewayRequest({
      modelName: 'embed-test',
      contract: EMBED_CONTRACT,
      body: { model: 'embed-test' },
      auth: AUTH,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("'input'");
  });
});
