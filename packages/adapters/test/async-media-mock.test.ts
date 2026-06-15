import type { AdapterContext, HttpClient, SubmitInput } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import { createAsyncMediaMock } from '../src/async-media-mock.js';

// The mock never touches the network, so a throwing HttpClient proves it.
const noNetwork: HttpClient = {
  request: () => Promise.reject(new Error('async-media-mock must not hit the network')),
};

const ctx: AdapterContext = { providerType: 'async-media-mock', http: noNetwork };

const submitInput = (modality: string): SubmitInput => ({
  resourceId: `model:async-media-mock/${modality}`,
  modality,
  inputs: { prompt: 'a cat' },
  execMode: 'async-poll',
  ctx,
});

describe('async-media-mock adapter', () => {
  it('exposes the async-media-mock provider type', () => {
    expect(createAsyncMediaMock().providerType).toBe('async-media-mock');
  });

  it('submit returns an async UpstreamJobHandle with a uuid job id', async () => {
    const adapter = createAsyncMediaMock();
    const r = await adapter.submit(submitInput('image'));
    expect(r.kind).toBe('async');
    if (r.kind === 'async') {
      expect(r.provider).toBe('async-media-mock');
      expect(r.upstreamJobId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
  });

  it('mints distinct ids for distinct submits', async () => {
    const adapter = createAsyncMediaMock();
    const a = await adapter.submit(submitInput('image'));
    const b = await adapter.submit(submitInput('image'));
    if (a.kind === 'async' && b.kind === 'async') {
      expect(a.upstreamJobId).not.toBe(b.upstreamJobId);
    }
  });

  it('polls running once then succeeded with readyAfterPolls=1 (default)', async () => {
    const adapter = createAsyncMediaMock();
    const handle = await adapter.submit(submitInput('image'));
    if (handle.kind !== 'async') throw new Error('expected async handle');
    expect(typeof adapter.poll).toBe('function');

    const first = await adapter.poll?.(handle.upstreamJobId, ctx);
    expect(first?.status).toBe('succeeded');
  });

  it('with readyAfterPolls=2, reports running on the first poll then succeeded', async () => {
    const adapter = createAsyncMediaMock({ readyAfterPolls: 2 });
    const handle = await adapter.submit(submitInput('image'));
    if (handle.kind !== 'async') throw new Error('expected async handle');

    const first = await adapter.poll?.(handle.upstreamJobId, ctx);
    expect(first?.status).toBe('running');
    expect(first?.output).toBeUndefined();

    const second = await adapter.poll?.(handle.upstreamJobId, ctx);
    expect(second?.status).toBe('succeeded');
  });

  it('with readyAfterPolls=0, the first poll is immediately succeeded', async () => {
    const adapter = createAsyncMediaMock({ readyAfterPolls: 0 });
    const handle = await adapter.submit(submitInput('image'));
    if (handle.kind !== 'async') throw new Error('expected async handle');

    const first = await adapter.poll?.(handle.upstreamJobId, ctx);
    expect(first?.status).toBe('succeeded');
  });

  it('image modality succeeds with an image_url + images:1 usage', async () => {
    const adapter = createAsyncMediaMock({ readyAfterPolls: 0 });
    const handle = await adapter.submit(submitInput('image'));
    if (handle.kind !== 'async') throw new Error('expected async handle');

    const r = await adapter.poll?.(handle.upstreamJobId, ctx);
    expect(r?.status).toBe('succeeded');
    expect(r?.output?.image_url).toBe(`https://mock.local/${handle.upstreamJobId}`);
    expect(r?.output?.video_url).toBeUndefined();
    expect(r?.usage).toEqual({ images: 1 });
  });

  it('video modality succeeds with a video_url + duration_seconds usage', async () => {
    const adapter = createAsyncMediaMock({ readyAfterPolls: 0 });
    const handle = await adapter.submit(submitInput('video'));
    if (handle.kind !== 'async') throw new Error('expected async handle');

    const r = await adapter.poll?.(handle.upstreamJobId, ctx);
    expect(r?.status).toBe('succeeded');
    expect(r?.output?.video_url).toBe(`https://mock.local/${handle.upstreamJobId}`);
    expect(r?.output?.image_url).toBeUndefined();
    expect(r?.usage).toMatchObject({ duration_seconds: expect.any(Number) });
  });

  it('polling an unknown id reports failed with an upstream_error', async () => {
    const adapter = createAsyncMediaMock();
    const r = await adapter.poll?.('does-not-exist', ctx);
    expect(r?.status).toBe('failed');
    expect(r?.error?.code).toBe('upstream_error');
  });

  it('parseCallback parses an {upstreamJobId, status} payload', () => {
    const adapter = createAsyncMediaMock();
    const cb = adapter.parseCallback?.({ upstreamJobId: 'job-1', status: 'succeeded' });
    expect(cb).toMatchObject({ upstreamJobId: 'job-1', status: 'succeeded' });
  });

  it('parseCallback defaults an unparseable status to failed', () => {
    const adapter = createAsyncMediaMock();
    const cb = adapter.parseCallback?.({ upstreamJobId: 'job-2', status: 'nonsense' });
    expect(cb?.status).toBe('failed');
  });

  it('extractUsage is a no-op returning an empty vector', () => {
    const adapter = createAsyncMediaMock();
    expect(adapter.extractUsage({})).toEqual({});
  });
});
