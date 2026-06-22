import type { AdapterContext, HttpClient, PluginManifest } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import { createPluginAdapter } from '../src/plugin-adapter.js';

const asyncPlugin = {
  manifest: {
    id: 'async-image',
    label: 'Async Image',
    modalities: ['image'],
    protocol: 'async-poll' as const,
    authStrategy: 'bearer' as const,
    credentialFields: [],
  },
  handler: `
    function mapRequest(ctx){ return { method:'POST', pathSuffix:'/submit', body:{ prompt: ctx.inputs.prompt } }; }
    function mapSubmit(a){ return { upstreamJobId: a.response.task_id }; }
    function mapPollRequest(a){ return { method:'GET', pathSuffix:'/tasks/' + a.upstreamJobId }; }
    function mapPoll(a){
      if (a.response.status === 'done') {
        return { state:'succeeded', result:{ kind:'media', assets:[{ role:'primary', modality:'image', url:a.response.url, mime:'image/png' }], usage:{ images:1 } } };
      }
      return { state:'running' };
    }
  `,
};

const syncPlugin = {
  manifest: { ...asyncPlugin.manifest, id: 'sync-image', protocol: 'sync' as const },
  handler: `
    function mapRequest(ctx){ return { method:'POST', pathSuffix:'/v1/images', body:{ prompt: ctx.inputs.prompt } }; }
    function mapResponse(a){ return { kind:'media', assets:[{ role:'primary', modality:'image', url:a.response.url, mime:'image/png' }], usage:{ images:1 } }; }
  `,
};

function ctxWith(plugin: { manifest: PluginManifest; handler: string }): AdapterContext {
  const http: HttpClient = {
    request: (req) => {
      if (req.url.includes('/submit')) {
        return Promise.resolve({ status: 200, ok: true, body: { task_id: 'job-1' }, text: '' });
      }
      return Promise.resolve({
        status: 200,
        ok: true,
        body: { status: 'done', url: 'https://up/x.png' },
        text: '',
      });
    },
  };
  return {
    providerType: 'plugin',
    endpoint: 'https://api.example.com',
    http,
    plugin,
    credentials: { api_key: 'sk-1' },
  };
}

describe('createPluginAdapter', () => {
  it('async-poll: submit returns a handle, poll returns succeeded + MediaResult', async () => {
    const adapter = createPluginAdapter();
    const ctx = ctxWith(asyncPlugin);
    const sub = await adapter.submit({
      resourceId: 'r',
      modality: 'image',
      inputs: { prompt: 'a cat' },
      execMode: 'async-poll',
      ctx,
    });
    expect(sub.kind).toBe('async');
    if (sub.kind !== 'async') throw new Error('expected async');
    expect(sub.upstreamJobId).toBe('job-1');

    if (adapter.poll === undefined) throw new Error('plugin adapter must support poll');
    const polled = await adapter.poll(sub.upstreamJobId, ctx);
    expect(polled.status).toBe('succeeded');
    expect(polled.mediaResult?.assets[0]?.url).toBe('https://up/x.png');
    expect(polled.usage).toEqual({ images: 1 });
  });

  it('sync: submit returns a SyncResult carrying the MediaResult', async () => {
    const adapter = createPluginAdapter();
    const res = await adapter.submit({
      resourceId: 'r',
      modality: 'image',
      inputs: { prompt: 'x' },
      execMode: 'blocking',
      ctx: ctxWith(syncPlugin),
    });
    expect(res.kind).toBe('sync');
    if (res.kind !== 'sync') throw new Error('expected sync');
    expect(res.mediaResult?.assets[0]?.url).toBe('https://up/x.png');
    expect(res.usage).toEqual({ images: 1 });
  });

  it('throws when the plugin snapshot is missing from the context', async () => {
    const adapter = createPluginAdapter();
    const ctx: AdapterContext = {
      providerType: 'plugin',
      http: { request: () => Promise.reject(new Error('x')) },
    };
    await expect(
      adapter.submit({ resourceId: 'r', modality: 'image', inputs: {}, execMode: 'blocking', ctx }),
    ).rejects.toThrow(/plugin snapshot/);
  });
});
