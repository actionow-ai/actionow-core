import type { HttpClient, HttpRequest, SubmitInput } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import { difyWorkflowAdapter } from '../src/dify-workflow.js';
import { AdapterError } from '../src/errors.js';

const fakeHttp = (
  resp: { status: number; body: unknown },
  capture?: (req: HttpRequest) => void,
): HttpClient => ({
  request: (req: HttpRequest) => {
    capture?.(req);
    return Promise.resolve({
      status: resp.status,
      ok: resp.status < 400,
      body: resp.body,
      text: JSON.stringify(resp.body),
    });
  },
});

const baseInput = (http: HttpClient, inputs: Record<string, unknown>): SubmitInput => ({
  resourceId: 'app:dify/my-flow',
  modality: 'workflow',
  inputs,
  execMode: 'blocking',
  ctx: {
    providerType: 'dify-workflow',
    endpoint: 'https://dify.example.com',
    apiKey: 'app-secret',
    http,
  },
});

describe('dify-workflow adapter', () => {
  it('exposes the dify-workflow provider type', () => {
    expect(difyWorkflowAdapter.providerType).toBe('dify-workflow');
  });

  it('runs a blocking workflow and returns outputs + total_tokens usage', async () => {
    const http = fakeHttp({
      status: 200,
      body: { data: { status: 'succeeded', outputs: { answer: '42' }, total_tokens: 99 } },
    });
    const r = await difyWorkflowAdapter.submit(baseInput(http, { question: 'meaning?' }));
    expect(r.kind).toBe('sync');
    if (r.kind === 'sync') {
      expect(r.output).toEqual({ answer: '42' });
      expect(r.usage).toEqual({ total_tokens: 99 });
    }
  });

  it('posts to /v1/workflows/run with bearer auth and the blocking envelope', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp(
      { status: 200, body: { data: { status: 'succeeded', outputs: {} } } },
      (req) => {
        seen = req;
      },
    );
    await difyWorkflowAdapter.submit(baseInput(http, { question: 'hi' }));
    expect(seen?.method).toBe('POST');
    expect(seen?.url).toBe('https://dify.example.com/v1/workflows/run');
    expect(seen?.headers?.Authorization).toBe('Bearer app-secret');
    expect(seen?.body).toEqual({
      inputs: { question: 'hi' },
      response_mode: 'blocking',
      user: 'actionow',
    });
  });

  it('defaults outputs to {} and total_tokens to 0 when absent', async () => {
    const http = fakeHttp({ status: 200, body: { data: { status: 'succeeded' } } });
    const r = await difyWorkflowAdapter.submit(baseInput(http, {}));
    if (r.kind === 'sync') {
      expect(r.output).toEqual({});
      expect(r.usage).toEqual({ total_tokens: 0 });
    }
  });

  it('throws job_failed when data.status is failed', async () => {
    const http = fakeHttp({
      status: 200,
      body: { data: { status: 'failed', error: 'node X blew up' } },
    });
    await expect(difyWorkflowAdapter.submit(baseInput(http, {}))).rejects.toMatchObject({
      unified: { code: 'job_failed', retryable: false },
    });
  });

  it('throws job_failed for an unrecognized/missing status', async () => {
    const http = fakeHttp({ status: 200, body: { data: { status: 'running' } } });
    await expect(difyWorkflowAdapter.submit(baseInput(http, {}))).rejects.toBeInstanceOf(
      AdapterError,
    );
  });

  it('maps a 401 to unauthorized (non-retryable)', async () => {
    const http = fakeHttp({ status: 401, body: { message: 'invalid api key' } });
    await expect(difyWorkflowAdapter.submit(baseInput(http, {}))).rejects.toMatchObject({
      unified: { code: 'unauthorized', retryable: false, upstream: { provider: 'dify-workflow' } },
    });
  });

  it('maps a 500 to upstream_error (retryable)', async () => {
    const http = fakeHttp({ status: 500, body: { message: 'boom' } });
    await expect(difyWorkflowAdapter.submit(baseInput(http, {}))).rejects.toMatchObject({
      unified: { code: 'upstream_error', retryable: true },
    });
  });

  it('extractUsage reads data.total_tokens', () => {
    expect(
      difyWorkflowAdapter.extractUsage({ data: { status: 'succeeded', total_tokens: 7 } }),
    ).toEqual({ total_tokens: 7 });
  });
});
