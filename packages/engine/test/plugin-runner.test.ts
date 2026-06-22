import type { HttpClient, HttpRequest } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import { type PluginSnapshot, runPluginSync } from '../src/plugin-runner.js';

const NOW = Date.UTC(2026, 5, 23, 12, 0, 0);

const imagePlugin: PluginSnapshot = {
  manifest: {
    id: 'test-image',
    label: 'Test Image',
    modalities: ['image'],
    protocol: 'sync',
    authStrategy: 'bearer',
    credentialFields: [],
  },
  handler: `
    function mapRequest(ctx){
      return {
        method: 'POST',
        pathSuffix: '/v1/images',
        body: { prompt: ctx.inputs.prompt, sawCredentials: ctx.credentials !== undefined || ctx.api_key !== undefined },
      };
    }
    function mapResponse(a){
      return { kind: 'media', assets: [{ role:'primary', modality:'image', url: a.response.url, mime:'image/png' }], usage: { images: 1 } };
    }
  `,
};

function fakeHttp(): { http: HttpClient; calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  const http: HttpClient = {
    request: (req) => {
      calls.push(req);
      return Promise.resolve({
        status: 200,
        ok: true,
        body: { url: 'https://up/x.png' },
        text: '',
      });
    },
  };
  return { http, calls };
}

describe('runPluginSync', () => {
  it('runs mapRequest → sign → http → mapResponse → MediaResult', async () => {
    const { http, calls } = fakeHttp();
    const mr = await runPluginSync(
      imagePlugin,
      { inputs: { prompt: 'a cat' } },
      { http, endpoint: 'https://api.x', credentials: { api_key: 'sk-1' }, nowMs: NOW },
    );
    expect(mr.kind).toBe('media');
    expect(mr.assets[0]?.url).toBe('https://up/x.png');
    expect(mr.usage).toEqual({ images: 1 });

    const call = calls[0];
    expect(call?.url).toBe('https://api.x/v1/images');
    expect(call?.method).toBe('POST');
    expect(call?.headers?.Authorization).toBe('Bearer sk-1'); // signer applied OUTSIDE sandbox
  });

  it('never exposes credentials to the sandbox handler', async () => {
    const { http, calls } = fakeHttp();
    await runPluginSync(
      imagePlugin,
      { inputs: { prompt: 'x' } },
      { http, endpoint: 'https://api.x', credentials: { api_key: 'sk-secret' }, nowMs: NOW },
    );
    // The handler recorded whether it could see any credentials — it must not.
    expect((calls[0]?.body as { sawCredentials: boolean }).sawCredentials).toBe(false);
  });

  it('throws on an upstream non-2xx', async () => {
    const http: HttpClient = {
      request: () => Promise.resolve({ status: 500, ok: false, body: undefined, text: 'err' }),
    };
    await expect(
      runPluginSync(
        imagePlugin,
        { inputs: { prompt: 'x' } },
        { http, endpoint: 'https://api.x', credentials: { api_key: 'k' }, nowMs: NOW },
      ),
    ).rejects.toThrow(/upstream returned 500/);
  });

  it('rejects a handler whose mapResponse violates the MediaResult contract', async () => {
    const { http } = fakeHttp();
    const bad: PluginSnapshot = {
      ...imagePlugin,
      handler: `
        function mapRequest(ctx){ return { method:'POST', pathSuffix:'/x', body:{} }; }
        function mapResponse(a){ return { kind:'media', assets:[{ modality:'image', mime:'image/png' }], usage:{} }; }
      `,
    };
    await expect(
      runPluginSync(
        bad,
        { inputs: {} },
        { http, endpoint: 'https://api.x', credentials: {}, nowMs: NOW },
      ),
    ).rejects.toThrow(/valid MediaResult/);
  });
});
