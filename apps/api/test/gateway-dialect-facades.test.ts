// 批次5 slice6 — §4.1 layer-1 facade tests for the remaining five legacy
// surfaces: anthropic /v1/messages + gemini :generateContent (wire → IR →
// canonical OpenAI body → GatewayRequest), rerank / moderations (profile
// machinery), transcriptions (multipart → asr with the audio riding the §9.4
// media input path: base64 mediaRefs + the canonical `file` param).
import { Buffer } from 'node:buffer';

import type { ModelOperation } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import {
  anthropicToGatewayRequest,
  geminiToGatewayRequest,
} from '../src/gateway/chat-dialect-facade.js';
import type { OpenAIFacadeInput, UploadedAudioFile } from '../src/gateway/chat-facade.js';
import {
  moderationsToGatewayRequest,
  rerankToGatewayRequest,
  transcriptionsToGatewayRequest,
} from '../src/gateway/chat-facade.js';

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

function input(
  body: Record<string, unknown>,
  contract: ModelOperation = CHAT_CONTRACT,
  overrides: Partial<OpenAIFacadeInput> = {},
): OpenAIFacadeInput {
  return { modelName: 'model-x', contract, body, auth: AUTH, ...overrides };
}

// --- anthropic /v1/messages ---------------------------------------------------------------

describe('anthropicToGatewayRequest — Anthropic wire → canonical GatewayRequest', () => {
  it('maps system/messages/sampling to the canonical OpenAI vocabulary, stream to options', () => {
    const result = anthropicToGatewayRequest(
      input({
        model: 'model-x',
        system: 'be nice',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 100,
        temperature: 0.5,
        stop_sequences: ['END'],
        stream: true,
      }),
    );
    if (!result.ok) throw new Error(result.error.message);
    const { request } = result;
    expect(request.operation).toBe('chat.completions');
    expect(request.model).toBe('model-x');
    // system hoisted into a leading system-role OpenAI message.
    expect(request.params.messages).toEqual({
      value: [
        { role: 'system', content: 'be nice' },
        { role: 'user', content: 'hi' },
      ],
      isDefault: false,
    });
    expect(request.params.max_tokens).toEqual({ value: 100, isDefault: false });
    expect(request.params.temperature).toEqual({ value: 0.5, isDefault: false });
    // stop_sequences → the canonical `stop`.
    expect(request.params.stop).toEqual({ value: ['END'], isDefault: false });
    expect(request.options.stream).toBe(true);
  });

  it('contract defaults ride tagged isDefault when the wire omits them', () => {
    const result = anthropicToGatewayRequest(
      input({ model: 'model-x', messages: [{ role: 'user', content: 'hi' }] }),
    );
    if (!result.ok) throw new Error(result.error.message);
    expect(result.request.params.temperature).toEqual({ value: 1, isDefault: true });
    expect(result.request.options.stream).toBeUndefined();
  });

  it('maps tools/tool_choice to the OpenAI function shapes (undeclared → verbatim ride)', () => {
    const result = anthropicToGatewayRequest(
      input({
        model: 'model-x',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'get_weather', description: 'd', input_schema: { type: 'object' } }],
        tool_choice: { type: 'tool', name: 'get_weather' },
      }),
    );
    if (!result.ok) throw new Error(result.error.message);
    expect(result.request.params.tools).toEqual({
      value: [
        {
          type: 'function',
          function: { name: 'get_weather', description: 'd', parameters: { type: 'object' } },
        },
      ],
      isDefault: false,
    });
    expect(result.request.params.tool_choice).toEqual({
      value: { type: 'function', function: { name: 'get_weather' } },
      isDefault: false,
    });
  });

  it('re-attaches reasoning knobs canonically and rides extra keys verbatim (no silent drop)', () => {
    const result = anthropicToGatewayRequest(
      input({
        model: 'model-x',
        messages: [{ role: 'user', content: 'hi' }],
        top_k: 5,
        output_config: { effort: 'high' },
        thinking: { type: 'enabled', budget_tokens: 1024 },
      }),
    );
    if (!result.ok) throw new Error(result.error.message);
    expect(result.request.params.reasoning_effort).toEqual({ value: 'high', isDefault: false });
    expect(result.request.params.reasoning_budget_tokens).toEqual({
      value: 1024,
      isDefault: false,
    });
    // unrecognized wire key rides verbatim — layer 2/contract authorship business.
    expect(result.request.params.top_k).toEqual({ value: 5, isDefault: false });
  });

  it('tool_use/tool_result blocks become OpenAI tool_calls / tool-role messages', () => {
    const result = anthropicToGatewayRequest(
      input({
        model: 'model-x',
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'get', input: { q: 1 } }],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }],
          },
        ],
      }),
    );
    if (!result.ok) throw new Error(result.error.message);
    const messages = result.request.params.messages?.value as Record<string, unknown>[];
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      tool_calls: [
        { id: 'toolu_1', type: 'function', function: { name: 'get', arguments: '{"q":1}' } },
      ],
    });
    expect(messages[2]).toMatchObject({ role: 'tool', content: 'ok', tool_call_id: 'toolu_1' });
  });

  it('rejects a body without a messages array as invalid_input', () => {
    const result = anthropicToGatewayRequest(input({ model: 'model-x' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_input');
  });

  it('fingerprints the idempotency key over the canonical body', () => {
    const result = anthropicToGatewayRequest(
      input({ model: 'model-x', messages: [{ role: 'user', content: 'hi' }] }, CHAT_CONTRACT, {
        idempotencyKey: 'idem-1',
      }),
    );
    if (!result.ok) throw new Error(result.error.message);
    expect(result.request.idempotency?.key).toBe('idem-1');
    expect(result.request.idempotency?.bodyFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});

// --- gemini :generateContent ----------------------------------------------------------------

describe('geminiToGatewayRequest — Gemini wire → canonical GatewayRequest', () => {
  it('maps contents/systemInstruction/generationConfig; the URL model + endpoint stream flag', () => {
    const result = geminiToGatewayRequest(
      input({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        systemInstruction: { parts: [{ text: 'be nice' }] },
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 64,
          topK: 3,
          thinkingConfig: { thinkingBudget: 512 },
        },
        safetySettings: [{ category: 'X' }],
      }),
      true,
    );
    if (!result.ok) throw new Error(result.error.message);
    const { request } = result;
    expect(request.operation).toBe('chat.completions');
    expect(request.model).toBe('model-x');
    expect(request.params.messages).toEqual({
      value: [
        { role: 'system', content: 'be nice' },
        { role: 'user', content: 'hi' },
      ],
      isDefault: false,
    });
    expect(request.params.temperature).toEqual({ value: 0.2, isDefault: false });
    // generationConfig.maxOutputTokens → the canonical max_tokens.
    expect(request.params.max_tokens).toEqual({ value: 64, isDefault: false });
    expect(request.params.reasoning_budget_tokens).toEqual({ value: 512, isDefault: false });
    // leftover generationConfig sub-keys + unknown top-level keys ride verbatim.
    expect(request.params.generationConfig).toEqual({ value: { topK: 3 }, isDefault: false });
    expect(request.params.safetySettings).toEqual({
      value: [{ category: 'X' }],
      isDefault: false,
    });
    // :streamGenerateContent forces the stream option.
    expect(request.options.stream).toBe(true);
  });

  it('non-stream endpoint leaves options.stream unset', () => {
    const result = geminiToGatewayRequest(
      input({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
      false,
    );
    if (!result.ok) throw new Error(result.error.message);
    expect(result.request.options.stream).toBeUndefined();
    expect(result.request.params.temperature).toEqual({ value: 1, isDefault: true });
  });

  it('rejects a body without a contents array as invalid_input', () => {
    const result = geminiToGatewayRequest(input({}), false);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_input');
  });
});

// --- rerank -------------------------------------------------------------------------------------

const RERANK_CONTRACT: ModelOperation = {
  operation: 'rerank',
  paradigms: ['sync'],
  slow: false,
  params: [
    { name: 'query', type: 'string', billingRelevant: false, required: true },
    { name: 'documents', type: 'string', billingRelevant: false, required: true, multiple: true },
    { name: 'top_n', type: 'int', billingRelevant: false, required: false, min: 1 },
  ],
};

describe('rerankToGatewayRequest — Cohere/Jina wire → GatewayRequest', () => {
  it('carries query/documents/top_n as canonical params', () => {
    const result = rerankToGatewayRequest(
      input({ model: 'rr', query: 'q', documents: ['a', 'b'], top_n: 2 }, RERANK_CONTRACT),
    );
    if (!result.ok) throw new Error(result.error.message);
    expect(result.request.operation).toBe('rerank');
    expect(result.request.params.query).toEqual({ value: 'q', isDefault: false });
    expect(result.request.params.documents).toEqual({ value: ['a', 'b'], isDefault: false });
    expect(result.request.params.top_n).toEqual({ value: 2, isDefault: false });
  });

  it('normalizes the camelCase topN alias to canonical top_n', () => {
    const result = rerankToGatewayRequest(
      input({ model: 'rr', query: 'q', documents: ['a'], topN: 1 }, RERANK_CONTRACT),
    );
    if (!result.ok) throw new Error(result.error.message);
    expect(result.request.params.top_n).toEqual({ value: 1, isDefault: false });
    expect(result.request.params.topN).toBeUndefined();
  });

  it('rejects a missing query / missing documents array', () => {
    const noQuery = rerankToGatewayRequest(
      input({ model: 'rr', documents: ['a'] }, RERANK_CONTRACT),
    );
    expect(noQuery.ok).toBe(false);
    const noDocs = rerankToGatewayRequest(input({ model: 'rr', query: 'q' }, RERANK_CONTRACT));
    expect(noDocs.ok).toBe(false);
  });
});

// --- moderations ----------------------------------------------------------------------------------

const MODERATIONS_CONTRACT: ModelOperation = {
  operation: 'moderations',
  paradigms: ['sync'],
  slow: false,
  params: [{ name: 'input', type: 'json', billingRelevant: false, required: true }],
};

describe('moderationsToGatewayRequest — OpenAI wire → GatewayRequest', () => {
  it('carries input as a canonical param (string or array)', () => {
    const result = moderationsToGatewayRequest(
      input({ model: 'mod', input: ['a', 'b'] }, MODERATIONS_CONTRACT),
    );
    if (!result.ok) throw new Error(result.error.message);
    expect(result.request.operation).toBe('moderations');
    expect(result.request.params.input).toEqual({ value: ['a', 'b'], isDefault: false });
  });

  it('rejects a missing input', () => {
    const result = moderationsToGatewayRequest(input({ model: 'mod' }, MODERATIONS_CONTRACT));
    expect(result.ok).toBe(false);
  });
});

// --- transcriptions (multipart → asr) ---------------------------------------------------------------

const ASR_CONTRACT: ModelOperation = {
  operation: 'asr',
  paradigms: ['sync'],
  slow: false,
  params: [
    { name: 'file', type: 'file', billingRelevant: false, required: true },
    { name: 'language', type: 'string', billingRelevant: false, required: false },
    { name: 'temperature', type: 'float', billingRelevant: false, required: false },
  ],
};

function audioFile(overrides: Partial<UploadedAudioFile> = {}): UploadedAudioFile {
  const buffer = Buffer.from('abc');
  return {
    buffer,
    originalname: 'a.mp3',
    mimetype: 'audio/mpeg',
    size: buffer.byteLength,
    ...overrides,
  };
}

describe('transcriptionsToGatewayRequest — multipart → asr GatewayRequest (§9.4 media input)', () => {
  it('rides the audio as a base64 mediaRefs entry MIRRORED as the canonical file param', () => {
    const result = transcriptionsToGatewayRequest(
      input(
        { model: 'stt', language: 'en', temperature: '0.3', response_format: 'verbose_json' },
        ASR_CONTRACT,
      ),
      audioFile(),
    );
    if (!result.ok) throw new Error(result.error.message);
    const { request } = result;
    expect(request.operation).toBe('asr');
    const base64 = Buffer.from('abc').toString('base64');
    expect(request.params.file).toEqual({ value: base64, isDefault: false });
    expect(request.mediaRefs).toEqual([
      { param: 'file', source: 'base64', data: base64, mime: 'audio/mpeg' },
    ]);
    // multer strings: temperature coerced to a number; language verbatim.
    expect(request.params.temperature).toEqual({ value: 0.3, isDefault: false });
    expect(request.params.language).toEqual({ value: 'en', isDefault: false });
    // undeclared wire keys still ride (drop-in surface).
    expect(request.params.response_format).toEqual({
      value: 'verbose_json',
      isDefault: false,
    });
    expect(request.params.filename).toEqual({ value: 'a.mp3', isDefault: false });
  });

  it('normalizes the camelCase responseFormat alias to canonical response_format', () => {
    const result = transcriptionsToGatewayRequest(
      input({ model: 'stt', responseFormat: 'text' }, ASR_CONTRACT),
      audioFile(),
    );
    if (!result.ok) throw new Error(result.error.message);
    expect(result.request.params.response_format).toEqual({ value: 'text', isDefault: false });
  });

  it('rejects an unknown response_format (parity with the old zod surface)', () => {
    const result = transcriptionsToGatewayRequest(
      input({ model: 'stt', response_format: 'xml' }, ASR_CONTRACT),
      audioFile(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_input');
    expect(result.error.details).toMatchObject({ param: 'response_format' });
  });

  it('rejects an empty audio part', () => {
    const result = transcriptionsToGatewayRequest(
      input({ model: 'stt' }, ASR_CONTRACT),
      audioFile({ buffer: Buffer.alloc(0), size: 0 }),
    );
    expect(result.ok).toBe(false);
  });
});
