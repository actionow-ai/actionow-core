// End-to-end: the mock-vendor YAML pack COMPILED and driven through the slice-1
// pipeline (判据 2.4: "以 mock 厂商演示 DSL 零代码接入"). chat.completions runs
// direct + stream via runSync/runStream; images.generation runs submit_poll via
// runTaskSubmit/runTaskQuery with a media placement; an hmac callback verifies
// through handleCallback; the pack registers + resolves; discovery parses.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { CredentialSecret, HttpRequest } from '@actionow/contracts';
import { beforeAll, describe, expect, it } from 'vitest';

import type { Dialect, DialectContext, DialectPack, SyncRunInput } from '../../src/index.js';
import {
  buildDiscoveryRequest,
  compileDialect,
  DialectRegistry,
  handleCallback,
  loadDialectPack,
  parseDiscoveredModels,
  registerPack,
  runStream,
  runSync,
  runTaskQuery,
  runTaskSubmit,
} from '../../src/index.js';
import { collect, fakeHttp, fakeStreamHttp, jsonResponse } from '../stub.js';

const YAML = readFileSync(new URL('../fixtures/mock-vendor.dialect.yaml', import.meta.url), 'utf8');
const CTX: DialectContext = { baseUrl: 'https://mock.test', nowMs: 1_752_000_000_000 };
const SECRET: CredentialSecret = { scheme: 'bearer', api_key: 'sk-mv' };

let pack: DialectPack;
let dialect: Dialect;

beforeAll(() => {
  pack = loadDialectPack(YAML);
  dialect = compileDialect(pack);
});

describe('chat.completions (direct)', () => {
  it('maps the body, injects bearer, and normalizes output + usage', async () => {
    let seen: HttpRequest | undefined;
    const input: SyncRunInput = {
      operation: 'chat.completions',
      upstreamModelName: 'mv-chat-1',
      params: {
        canonical: {},
        upstream: { messages: [{ role: 'user', content: 'hi' }], temperature: 0.7 },
      },
      secret: SECRET,
      ctx: CTX,
    };
    const result = await runSync(dialect, input, {
      http: fakeHttp((req) => {
        seen = req;
        return jsonResponse(200, {
          choices: [{ message: { content: 'hello' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        });
      }),
    });

    expect(seen?.url).toBe('https://mock.test/v1/chat/completions');
    expect(seen?.headers?.Authorization).toBe('Bearer sk-mv');
    expect(seen?.body).toEqual({
      model: 'mv-chat-1',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.7,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toEqual([{ message: { content: 'hello' } }]);
      expect(result.usage.metrics).toEqual({ input_tokens: 10, output_tokens: 5 });
      expect(result.servedRaw).toMatchObject({ choices: [{ message: { content: 'hello' } }] });
    }
  });
});

describe('chat.completions (stream)', () => {
  it('passes SSE data frames through as deltas and closes on [DONE]', async () => {
    const input: SyncRunInput = {
      operation: 'chat.completions',
      upstreamModelName: 'mv-chat-1',
      params: { canonical: {}, upstream: { messages: [] } },
      secret: SECRET,
      ctx: CTX,
    };
    const handle = runStream(dialect, input, {
      http: fakeStreamHttp(200, [
        'data: {"choices":[{"delta":{"content":"He"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    });
    const frames = await collect(handle.frames);
    expect(frames).toEqual([
      { kind: 'delta', payload: '{"choices":[{"delta":{"content":"He"}}]}' },
      { kind: 'delta', payload: '{"choices":[{"delta":{"content":"llo"}}]}' },
      { kind: 'done' },
    ]);
  });
});

describe('images.generation (submit_poll)', () => {
  const submitInput = (media?: SyncRunInput['media']): SyncRunInput => ({
    operation: 'images.generation',
    upstreamModelName: 'mv-img-1',
    params: { canonical: {}, upstream: { prompt: 'a cat', size: '1024x1024' } },
    secret: SECRET,
    ctx: CTX,
    ...(media !== undefined ? { media } : {}),
  });

  it('submits, returns the upstream task handle, then polls to succeeded', async () => {
    let submitReq: HttpRequest | undefined;
    const submit = await runTaskSubmit(dialect, submitInput(), {
      http: fakeHttp((req) => {
        submitReq = req;
        return jsonResponse(200, { task_id: 'img-1' });
      }),
    });
    expect(submitReq?.url).toBe('https://mock.test/v1/images/generations');
    expect(submitReq?.body).toEqual({ model: 'mv-img-1', prompt: 'a cat', size: '1024x1024' });
    expect(submit).toEqual({
      ok: true,
      kind: 'task',
      upstreamTaskId: 'img-1',
      servedRaw: { task_id: 'img-1' },
    });

    let queryReq: HttpRequest | undefined;
    const query = await runTaskQuery(
      dialect,
      { upstreamTaskId: 'img-1', secret: SECRET, ctx: CTX },
      {
        http: fakeHttp((req) => {
          queryReq = req;
          return jsonResponse(200, {
            task_id: 'img-1',
            status: 'done',
            image_url: 'https://cdn/img.png',
            usage: { images: 1 },
          });
        }),
      },
    );
    expect(queryReq?.url).toBe('https://mock.test/v1/images/tasks/img-1');
    expect(query.ok).toBe(true);
    if (query.ok) {
      expect(query.update).toMatchObject({
        upstreamTaskId: 'img-1',
        status: 'succeeded',
        rawStatus: 'done',
        output: 'https://cdn/img.png',
      });
      expect(query.update.usage?.metrics).toEqual({ images: 1 });
    }
  });

  it('injects a resolved media reference into the body (aspect ②)', async () => {
    let seen: HttpRequest | undefined;
    await runTaskSubmit(
      dialect,
      submitInput([{ param: 'image', form: 'url', url: 'https://cdn/ref.png' }]),
      {
        http: fakeHttp((req) => {
          seen = req;
          return jsonResponse(200, { task_id: 'img-2' });
        }),
      },
    );
    expect(seen?.body).toEqual({
      model: 'mv-img-1',
      prompt: 'a cat',
      size: '1024x1024',
      image: 'https://cdn/ref.png',
    });
  });

  it('maps an UNKNOWN poll status to running without crashing (§6)', async () => {
    const query = await runTaskQuery(
      dialect,
      { upstreamTaskId: 'img-9', secret: SECRET, ctx: CTX },
      { http: fakeHttp(() => jsonResponse(200, { task_id: 'img-9', status: 'transcoding' })) },
    );
    expect(query.ok).toBe(true);
    if (query.ok) {
      expect(query.update.status).toBe('running');
      expect(query.update.rawStatus).toBe('transcoding');
    }
  });
});

describe('images.generation (submit_callback)', () => {
  const cbCtx: DialectContext = { ...CTX, config: { callbackSecret: 'whsec_mv' } };

  it('verifies a signed callback and normalizes it to a TaskUpdate', () => {
    const rawBody = JSON.stringify({
      task_id: 'img-1',
      status: 'done',
      image_url: 'https://cdn/img.png',
    });
    const ts = String(Math.floor(cbCtx.nowMs / 1000));
    const sig = createHmac('sha256', 'whsec_mv').update(`${ts}.${rawBody}`).digest('hex');

    const ok = handleCallback(
      dialect,
      { rawBody, headers: { 'x-mockvendor-signature': sig, 'x-mockvendor-timestamp': ts } },
      undefined,
      cbCtx,
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.update).toMatchObject({
        upstreamTaskId: 'img-1',
        status: 'succeeded',
        output: 'https://cdn/img.png',
      });
    }
  });

  it('rejects a forged callback (unauthorized) without parsing', () => {
    const rawBody = JSON.stringify({ task_id: 'img-1', status: 'done' });
    const ts = String(Math.floor(cbCtx.nowMs / 1000));
    const bad = handleCallback(
      dialect,
      { rawBody, headers: { 'x-mockvendor-signature': 'forged', 'x-mockvendor-timestamp': ts } },
      undefined,
      cbCtx,
    );
    expect(bad).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
  });
});

describe('registry + discovery', () => {
  it('registers the compiled pack under its ref@version and resolves it', () => {
    const registry = new DialectRegistry();
    const registered = registerPack(registry, YAML);
    expect(registry.resolve({ ref: 'mockvendor', version: '1.0.0' })).toBe(registered);
    expect(registry.resolve({ ref: 'mockvendor', version: '9.9.9' })).toBeUndefined();
  });

  it('parses a discovery response into ProviderModel[] and builds the discovery request', () => {
    const models = parseDiscoveredModels(pack, {
      data: [
        { id: 'mv-chat-1', name: 'MockVendor Chat' },
        { id: 'mv-img-1', name: 'MockVendor Image' },
        { name: 'no id — skipped' },
      ],
    });
    expect(models).toEqual([
      { id: 'mv-chat-1', displayName: 'MockVendor Chat' },
      { id: 'mv-img-1', displayName: 'MockVendor Image' },
    ]);
    expect(buildDiscoveryRequest(pack)).toMatchObject({
      method: 'GET',
      path: '/v1/models',
      bodyKind: 'none',
    });
  });
});
