import type { AdapterContext, HttpClient, HttpRequest } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import { anthropicAdapter } from '../src/anthropic.js';
import { geminiAdapter } from '../src/gemini.js';
import { openaiAdapter } from '../src/openai.js';

/** A buffered fake HttpClient that returns a canned body and captures the request. */
const fakeHttp = (body: unknown, cap?: (r: HttpRequest) => void, status = 200): HttpClient => ({
  request: (r: HttpRequest) => {
    cap?.(r);
    return Promise.resolve({ status, ok: status < 400, body, text: '' });
  },
});

const ctx = (http: HttpClient, providerType: string): AdapterContext => ({
  providerType,
  http,
  apiKey: 'sk-test',
});

describe('openaiAdapter.listModels', () => {
  it('GETs /models, maps ids, and drops non-chat (embedding/whisper/tts/dall-e)', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp(
      {
        object: 'list',
        data: [
          { id: 'gpt-4o-mini' },
          { id: 'text-embedding-3-small' },
          { id: 'whisper-1' },
          { id: 'tts-1' },
          { id: 'dall-e-3' },
          { id: 'deepseek-chat' }, // an openai-compatible relay id → kept
        ],
      },
      (r) => (seen = r),
    );
    const models = (await openaiAdapter.listModels?.(ctx(http, 'openai'))) ?? [];
    expect(seen?.method).toBe('GET');
    expect(seen?.url).toContain('/models');
    expect(seen?.headers?.Authorization).toBe('Bearer sk-test');
    expect(models.map((m) => m.id)).toEqual(['gpt-4o-mini', 'deepseek-chat']);
  });

  it('throws AdapterError on a non-ok reply', async () => {
    const http = fakeHttp({ error: { message: 'nope' } }, undefined, 401);
    await expect(openaiAdapter.listModels?.(ctx(http, 'openai'))).rejects.toThrow();
  });
});

describe('anthropicAdapter.listModels', () => {
  it('GETs /v1/models with x-api-key + anthropic-version and maps id/display_name', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp(
      {
        data: [
          { type: 'model', id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5' },
          { type: 'model', id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' },
        ],
      },
      (r) => (seen = r),
    );
    const models = (await anthropicAdapter.listModels?.(ctx(http, 'anthropic'))) ?? [];
    expect(seen?.url).toContain('/v1/models');
    expect(seen?.headers?.['x-api-key']).toBe('sk-test');
    expect(seen?.headers?.['anthropic-version']).toBeDefined();
    expect(models[0]).toEqual({ id: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5' });
    expect(models).toHaveLength(2);
  });
});

describe('geminiAdapter.listModels', () => {
  it('GETs /v1beta/models, keeps only generateContent-capable, strips models/ prefix', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp(
      {
        models: [
          {
            name: 'models/gemini-2.5-flash',
            displayName: 'Gemini 2.5 Flash',
            inputTokenLimit: 1048576,
            supportedGenerationMethods: ['generateContent', 'countTokens'],
          },
          {
            name: 'models/text-embedding-004',
            supportedGenerationMethods: ['embedContent'], // no generateContent → dropped
          },
        ],
      },
      (r) => (seen = r),
    );
    const models = (await geminiAdapter.listModels?.(ctx(http, 'gemini'))) ?? [];
    expect(seen?.url).toContain('/v1beta/models');
    expect(seen?.url).toContain('key=sk-test');
    expect(models).toHaveLength(1);
    expect(models[0]).toEqual({
      id: 'gemini-2.5-flash',
      displayName: 'Gemini 2.5 Flash',
      contextWindow: 1048576,
    });
  });
});
