import type { HttpClient, PluginManifest } from '@actionow/contracts';
import { pluginManifestSchema } from '@actionow/contracts';
import {
  type PluginSnapshot,
  runPluginPoll,
  runPluginSubmit,
  runPluginSync,
} from '@actionow/engine';
import { describe, expect, it } from 'vitest';

import { BUILTIN_PLUGINS } from '../src/seed/seed-plugins.js';

function snapshot(slug: string): PluginSnapshot {
  const p = BUILTIN_PLUGINS.find((b) => b.slug === slug);
  if (p === undefined) throw new Error(`no builtin ${slug}`);
  const manifest: PluginManifest = pluginManifestSchema.parse({
    id: p.slug,
    label: p.label,
    modalities: p.modalities,
    protocol: p.protocol,
    authStrategy: p.authStrategy,
    credentialFields: p.credentialFields,
  });
  return { manifest, handler: p.handler };
}

const NOW = Date.UTC(2026, 5, 23, 12, 0, 0);

describe('built-in plugin manifests', () => {
  it('all parse against the manifest contract', () => {
    for (const p of BUILTIN_PLUGINS) {
      expect(() =>
        pluginManifestSchema.parse({
          id: p.slug,
          label: p.label,
          modalities: p.modalities,
          protocol: p.protocol,
          authStrategy: p.authStrategy,
          credentialFields: p.credentialFields,
        }),
      ).not.toThrow();
    }
  });
});

describe('openai-images builtin handler', () => {
  it('maps an OpenAI images response to a MediaResult', async () => {
    const http: HttpClient = {
      request: () =>
        Promise.resolve({
          status: 200,
          ok: true,
          body: { data: [{ url: 'https://img/a.png' }, { url: 'https://img/b.png' }] },
          text: '',
        }),
    };
    const mr = await runPluginSync(
      snapshot('openai-images'),
      { inputs: { prompt: 'a cat', n: 2 }, model: 'gpt-image-1' },
      { http, endpoint: 'https://api.openai.com', credentials: { api_key: 'sk' }, nowMs: NOW },
    );
    expect(mr.assets.map((a) => a.url)).toEqual(['https://img/a.png', 'https://img/b.png']);
    expect(mr.usage).toEqual({ images: 2 });
  });
});

describe('async-media-relay builtin handler', () => {
  const snap = () => snapshot('async-media-relay');
  const deps = (http: HttpClient) => ({
    http,
    endpoint: 'https://relay.example',
    credentials: { api_key: 'sk' },
    nowMs: NOW,
  });

  it('submits and extracts the task id', async () => {
    const http: HttpClient = {
      request: () =>
        Promise.resolve({ status: 200, ok: true, body: { task_id: 'task-9' }, text: '' }),
    };
    const out = await runPluginSubmit(
      snap(),
      { inputs: { prompt: 'a dog' }, model: 'seedream', config: { submitPath: '/submit' } },
      deps(http),
    );
    expect(out.upstreamJobId).toBe('task-9');
  });

  it('polls to succeeded and maps the result to a MediaResult', async () => {
    const http: HttpClient = {
      request: () =>
        Promise.resolve({
          status: 200,
          ok: true,
          body: {
            status: 'completed',
            result: { image_url: 'https://relay/x.png', image_count: 1 },
          },
          text: '',
        }),
    };
    const out = await runPluginPoll(
      snap(),
      'task-9',
      { inputs: {}, config: { pollPath: '/tasks/{id}' } },
      deps(http),
    );
    expect(out.state).toBe('succeeded');
    expect(out.mediaResult?.assets[0]?.url).toBe('https://relay/x.png');
    expect(out.mediaResult?.usage).toEqual({ images: 1 });
  });
});
