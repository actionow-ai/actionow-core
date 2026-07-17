// compileDialect: the six-aspect interpreter. Covers the §4.1-layer-3 RED LINE
// (aspect ① reads ONLY EffectiveParams.upstream, never canonical), credential
// placement + signer delegation, aspect-⑤ usage / business-error / error-table
// normalization, aspect-⑥ task parsing incl. UNKNOWN-status survival, and the
// "升代码切面" gate (ak_sk without a signer is refused).
import { createHmac } from 'node:crypto';

import type { CredentialSecret, EffectiveParams } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import type {
  Dialect,
  DialectContext,
  RequestMappingInput,
  WireResponse,
} from '../../src/index.js';
import { compileDialect, dialectPackSchema } from '../../src/index.js';

const CTX: DialectContext = { baseUrl: 'https://api.acme.test', nowMs: 1_752_000_000_000 };
const BEARER: CredentialSecret = { scheme: 'bearer', api_key: 'sk-acme' };

const ERROR_TABLE = {
  rows: [
    { match: { httpStatus: 400 }, code: 'invalid_input', retryable: false, failover: false },
    { match: { httpStatus: 429 }, code: 'rate_limited', retryable: true, failover: true },
    {
      match: { upstreamCode: 'content_policy' },
      code: 'content_filtered',
      retryable: false,
      failover: false,
    },
  ],
  fallback: { code: 'upstream_error', retryable: false, failover: true },
};

function compile(pack: Record<string, unknown>): Dialect {
  return compileDialect(dialectPackSchema.parse(pack));
}

function chatPack(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ref: 'acme',
    version: '1.0.0',
    auth: { scheme: 'bearer' },
    errorTable: ERROR_TABLE,
    operations: {
      'chat.completions': {
        fetchModes: ['direct', 'stream'],
        request: {
          path: '/v1/chat/completions',
          body: {
            upstream_model_name: '$.model',
            messages: '$.messages',
            temperature: '$.temperature',
          },
        },
        response: {
          output: '$.choices',
          usage: {
            input_tokens: '$.usage.prompt_tokens',
            output_tokens: '$.usage.completion_tokens',
          },
          businessError: {
            errorWhenPresent: '$.error',
            codePath: '$.error.code',
            messagePath: '$.error.message',
          },
        },
      },
    },
    ...overrides,
  };
}

function mappingInput(params: EffectiveParams): RequestMappingInput {
  return {
    operation: 'chat.completions',
    upstreamModelName: 'acme-chat-1',
    params,
    stream: false,
    ctx: CTX,
  };
}

describe('aspect ①: request mapping is pure upstream porterage (§4.1 layer 3 red line)', () => {
  it('places ONLY EffectiveParams.upstream values — never canonical', () => {
    const dialect = compile(chatPack());
    // canonical and upstream DELIBERATELY disagree: the draft must reflect
    // upstream (post-planner) and show no trace of the canonical values.
    const draft = dialect.requestMapping.map(
      mappingInput({
        canonical: { temperature: 0.1, messages: [{ role: 'system', content: 'CANON' }] },
        upstream: { temperature: 0.9, messages: [{ role: 'user', content: 'UPSTREAM' }] },
      }),
    );
    expect(draft).toEqual({
      method: 'POST',
      path: '/v1/chat/completions',
      bodyKind: 'json',
      body: {
        model: 'acme-chat-1',
        temperature: 0.9,
        messages: [{ role: 'user', content: 'UPSTREAM' }],
      },
    });
    const serialized = JSON.stringify(draft);
    expect(serialized).toContain('UPSTREAM');
    expect(serialized).not.toContain('CANON');
    expect(serialized).not.toContain('0.1');
  });

  it('skips upstream params that are absent (no null holes)', () => {
    const dialect = compile(chatPack());
    const draft = dialect.requestMapping.map(
      mappingInput({ canonical: {}, upstream: { messages: [] } }),
    );
    // temperature was not supplied upstream → not written at all.
    expect(draft.body).toEqual({ model: 'acme-chat-1', messages: [] });
  });

  it('substitutes {upstream_model_name} and {param:NAME} placeholders in the path', () => {
    const dialect = compile(
      chatPack({
        operations: {
          'chat.completions': {
            fetchModes: ['direct'],
            request: { path: '/v1/{param:region}/models/{upstream_model_name}/invoke' },
            response: {},
          },
        },
      }),
    );
    const draft = dialect.requestMapping.map(
      mappingInput({ canonical: {}, upstream: { region: 'us' } }),
    );
    expect(draft.path).toBe('/v1/us/models/acme-chat-1/invoke');
  });
});

describe('aspect ③: credential injection', () => {
  it('bearer places Authorization: Bearer <key> in the header', () => {
    const dialect = compile(chatPack());
    const injected = dialect.credentialInjection.injectCredential(
      { method: 'POST', path: 'https://api.acme.test/v1/chat', bodyKind: 'json', body: {} },
      BEARER,
      CTX,
    );
    expect(injected.headers?.Authorization).toBe('Bearer sk-acme');
  });

  it('x_api_key + custom placement honors the configured header name', () => {
    const dialect = compile(
      chatPack({ auth: { scheme: 'x_api_key', placement: { name: 'api-key' } } }),
    );
    const injected = dialect.credentialInjection.injectCredential(
      { method: 'POST', path: 'https://api.acme.test/v1/chat', bodyKind: 'json', body: {} },
      { scheme: 'x_api_key', api_key: 'xk-1' },
      CTX,
    );
    expect(injected.headers?.['api-key']).toBe('xk-1');
  });

  it('a signer scheme (ak_sk) delegates to the shared code signer (signed headers appear)', () => {
    const dialect = compile(chatPack({ auth: { scheme: 'ak_sk', signer: 'kling-jwt' } }));
    const injected = dialect.credentialInjection.injectCredential(
      { method: 'POST', path: 'https://api.acme.test/v1/chat', bodyKind: 'json', body: { a: 1 } },
      { scheme: 'ak_sk', access_key: 'AK', secret_key: 'SK' },
      CTX,
    );
    expect(injected.headers?.Authorization).toMatch(/^Bearer .+\..+\..+$/); // HS256 JWT
  });

  it('refuses to compile an ak_sk pack with no signer (升代码切面 gate)', () => {
    expect(() => compile(chatPack({ auth: { scheme: 'ak_sk' } }))).toThrow(/needs a code signer/);
  });

  it('refuses to compile an oauth pack with no signer', () => {
    expect(() => compile(chatPack({ auth: { scheme: 'oauth' } }))).toThrow(/needs a code signer/);
  });
});

describe('aspect ⑤: response normalization', () => {
  const dialect = compile(chatPack());

  it('extracts output + usage on a clean 2xx', () => {
    const res: WireResponse = {
      status: 200,
      headers: {},
      body: { choices: [{ text: 'hi' }], usage: { prompt_tokens: 11, completion_tokens: 4 } },
    };
    const out = dialect.responseNormalization.normalize(res, CTX);
    expect(out).toEqual({
      ok: true,
      output: [{ text: 'hi' }],
      usage: { metrics: { input_tokens: 11, output_tokens: 4 }, billingDims: {}, estimated: false },
    });
  });

  it('translates a 200-carried business error via the error table (errorTable 命中)', () => {
    const res: WireResponse = {
      status: 200,
      headers: {},
      body: { error: { code: 'content_policy', message: 'blocked by policy' } },
    };
    const out = dialect.responseNormalization.normalize(res, CTX);
    expect(out).toEqual({
      ok: false,
      error: {
        code: 'content_filtered',
        message: 'blocked by policy',
        retryable: false,
        failover: false,
      },
    });
  });

  it('translates an HTTP error via the error table', () => {
    const res: WireResponse = { status: 429, headers: {}, body: { message: 'slow down' } };
    const out = dialect.responseNormalization.normalize(res, CTX);
    expect(out).toMatchObject({
      ok: false,
      error: { code: 'rate_limited', retryable: true, failover: true },
    });
  });

  it('normalizeStreamFrame passes data through as delta and closes on the sentinel', () => {
    const first = dialect.responseNormalization.normalizeStreamFrame('{"delta":"hi"}', {});
    expect(first).toEqual([{ kind: 'delta', payload: '{"delta":"hi"}' }]);
    const done = dialect.responseNormalization.normalizeStreamFrame('[DONE]', {});
    expect(done).toEqual([{ kind: 'done' }]);
  });

  it('emits a usage frame when stream.usage is declared', () => {
    const streamed = compile(
      chatPack({
        operations: {
          'chat.completions': {
            fetchModes: ['stream'],
            request: { path: '/v1/chat' },
            response: { stream: { usage: { output_tokens: '$.usage.completion_tokens' } } },
          },
        },
      }),
    );
    const frames = streamed.responseNormalization.normalizeStreamFrame(
      '{"usage":{"completion_tokens":7}}',
      {},
    );
    expect(frames).toEqual([
      {
        kind: 'usage',
        usage: { metrics: { output_tokens: 7 }, billingDims: {}, estimated: false },
      },
      { kind: 'delta', payload: '{"usage":{"completion_tokens":7}}' },
    ]);
  });
});

describe('aspect ⑥: task lifecycle', () => {
  function taskPack(): Record<string, unknown> {
    return {
      ref: 'acme',
      version: '1.0.0',
      auth: { scheme: 'bearer' },
      errorTable: ERROR_TABLE,
      operations: {
        'video.generation': {
          fetchModes: ['submit_poll', 'submit_callback'],
          request: {
            path: '/v1/videos',
            body: { upstream_model_name: '$.model', prompt: '$.prompt' },
          },
          response: {},
          task: {
            submit: { response: { taskIdPath: '$.task_id', inlinePath: '$.video_url' } },
            query: {
              request: { method: 'GET', path: '/v1/videos/{task_id}' },
              taskIdPath: '$.task_id',
              statusPath: '$.status',
              statusMap: {
                queued: 'pending',
                processing: 'running',
                done: 'succeeded',
                error: 'failed',
              },
              unknownStatus: 'running',
              outputPath: '$.video_url',
              progressPath: '$.progress',
              usage: { video_seconds: '$.usage.seconds' },
              errorMessagePath: '$.error.message',
            },
            callback: {
              verify: {
                strategy: 'hmac_sha256_timestamp',
                signatureHeader: 'x-sig',
                timestampHeader: 'x-ts',
                windowMs: 300000,
                secretConfigKey: 'callbackSecret',
              },
              taskIdPath: '$.task_id',
              statusPath: '$.status',
              statusMap: { done: 'succeeded', error: 'failed' },
              unknownStatus: 'running',
              outputPath: '$.video_url',
            },
          },
        },
      },
    };
  }

  const dialect = compile(taskPack());
  const tl = dialect.taskLifecycle;
  if (tl === undefined) throw new Error('fixture must produce a taskLifecycle aspect');

  it('parseSubmitResponse reads the task handle', () => {
    expect(tl.parseSubmitResponse({ status: 200, headers: {}, body: { task_id: 'up-7' } })).toEqual(
      {
        upstreamTaskId: 'up-7',
      },
    );
  });

  it('parseSubmitResponse detects synchronous inline completion', () => {
    const parsed = tl.parseSubmitResponse({
      status: 200,
      headers: {},
      body: { video_url: 'https://cdn/v.mp4' },
    });
    expect(parsed).toEqual({ inline: { output: 'https://cdn/v.mp4', usage: expect.anything() } });
  });

  it('buildQuery substitutes {task_id} and defaults to GET', () => {
    expect(tl.buildQuery('up-7', CTX)).toEqual({
      method: 'GET',
      path: '/v1/videos/up-7',
      bodyKind: 'none',
    });
  });

  it('parseQueryResponse maps a known status and extracts output/usage/progress', () => {
    const update = tl.parseQueryResponse({
      status: 200,
      headers: {},
      body: {
        task_id: 'up-7',
        status: 'done',
        video_url: 'https://cdn/v.mp4',
        progress: 100,
        usage: { seconds: 6 },
      },
    });
    expect(update).toMatchObject({
      upstreamTaskId: 'up-7',
      status: 'succeeded',
      rawStatus: 'done',
      output: 'https://cdn/v.mp4',
      progress: 100,
      usage: { metrics: { video_seconds: 6 } },
    });
  });

  it('an UNKNOWN upstream status maps to unknownStatus and preserves rawStatus (§6 不崩)', () => {
    const update = tl.parseQueryResponse({
      status: 200,
      headers: {},
      body: { task_id: 'up-7', status: 'reticulating_splines' },
    });
    expect(update.status).toBe('running'); // unknownStatus
    expect(update.rawStatus).toBe('reticulating_splines'); // verbatim, not lost
  });

  it('a failed status synthesizes a task_failed error with the mapped message', () => {
    const update = tl.parseQueryResponse({
      status: 200,
      headers: {},
      body: { task_id: 'up-7', status: 'error', error: { message: 'render crashed' } },
    });
    expect(update.status).toBe('failed');
    expect(update.error).toMatchObject({ code: 'task_failed', message: 'render crashed' });
  });

  it('verifyCallback accepts a correct HMAC signature and rejects a forged one', () => {
    const ctx: DialectContext = { ...CTX, config: { callbackSecret: 'whsec_1' } };
    const rawBody = JSON.stringify({ task_id: 'up-7', status: 'done' });
    const ts = String(Math.floor(ctx.nowMs / 1000));
    const sig = createHmac('sha256', 'whsec_1').update(`${ts}.${rawBody}`).digest('hex');

    expect(
      tl.verifyCallback({ rawBody, headers: { 'x-sig': sig, 'x-ts': ts } }, undefined, ctx),
    ).toBe(true);
    expect(
      tl.verifyCallback({ rawBody, headers: { 'x-sig': 'deadbeef', 'x-ts': ts } }, undefined, ctx),
    ).toBe(false);
  });

  it('verifyCallback rejects a replayed (out-of-window) timestamp', () => {
    const ctx: DialectContext = { ...CTX, config: { callbackSecret: 'whsec_1' } };
    const rawBody = JSON.stringify({ task_id: 'up-7', status: 'done' });
    const staleTs = String(Math.floor(ctx.nowMs / 1000) - 10_000); // 10s window default 300s → 10000s stale
    const sig = createHmac('sha256', 'whsec_1').update(`${staleTs}.${rawBody}`).digest('hex');
    expect(
      tl.verifyCallback({ rawBody, headers: { 'x-sig': sig, 'x-ts': staleTs } }, undefined, ctx),
    ).toBe(false);
  });
});
