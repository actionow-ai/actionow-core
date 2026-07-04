import { createHmac } from 'node:crypto';

import type { HttpClient, HttpRequest, SubmitInput } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import { asyncMediaAdapter } from '../src/async-media.js';

const RELAY_ENDPOINT = 'https://relay.example';
const RELAY_CONFIG = { submitPath: '/v1/tasks', pollPath: '/v1/tasks/{id}' };

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

const input = (
  http: HttpClient,
  modality: string,
  inputs: Record<string, unknown>,
  model: string,
): SubmitInput => ({
  resourceId: `model:async-media/${modality}`,
  modality,
  inputs,
  execMode: 'async-poll',
  ctx: {
    providerType: 'async-media',
    model,
    endpoint: RELAY_ENDPOINT,
    apiKey: 'relay-test',
    config: RELAY_CONFIG,
    http,
  },
});

describe('async-media adapter', () => {
  it('exposes the async-media provider type', () => {
    expect(asyncMediaAdapter.providerType).toBe('async-media');
  });

  it('submits an image task: POST config.submitPath with model + params.prompt', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp(
      { status: 200, body: { task_id: 'task-uuid-1', status: 'pending' } },
      (r) => {
        seen = r;
      },
    );
    const r = await asyncMediaAdapter.submit(
      input(http, 'image', { prompt: 'a cat', size: '1024x1024' }, 'img-model'),
    );
    expect(seen?.method).toBe('POST');
    expect(seen?.url).toBe('https://relay.example/v1/tasks');
    expect(seen?.headers?.Authorization).toBe('Bearer relay-test');
    expect(seen?.body).toEqual({
      model: 'img-model',
      params: { prompt: 'a cat', size: '1024x1024' },
    });
    expect(r.kind).toBe('async');
    if (r.kind === 'async') {
      expect(r.provider).toBe('async-media');
      expect(r.upstreamJobId).toBe('task-uuid-1');
    }
  });

  it('media model passthrough: inputs.model overrides ctx.model (never leaks into params)', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp({ status: 200, body: { task_id: 'task-pt', status: 'pending' } }, (r) => {
      seen = r;
    });
    // Channel default is seedream-4.5, but the request asks for seedream-5.0-lite.
    await asyncMediaAdapter.submit(
      input(http, 'image', { prompt: 'a cat', model: 'seedream-5.0-lite' }, 'seedream-4.5'),
    );
    // The requested model wins at the top level; params carries only prompt.
    expect(seen?.body).toEqual({
      model: 'seedream-5.0-lite',
      params: { prompt: 'a cat' },
    });
  });

  it('submits a video task: params carries prompt, duration, ratio', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp({ status: 200, body: { task_id: 'task-v', status: 'pending' } }, (r) => {
      seen = r;
    });
    await asyncMediaAdapter.submit(
      input(http, 'video', { prompt: 'a dog runs', duration: 5, ratio: '16:9' }, 'vid-model'),
    );
    expect(seen?.body).toEqual({
      model: 'vid-model',
      params: { prompt: 'a dog runs', duration: 5, ratio: '16:9' },
    });
  });

  it('submits an audio task: params carries prompt, voice, language', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp({ status: 200, body: { task_id: 'task-a', status: 'pending' } }, (r) => {
      seen = r;
    });
    await asyncMediaAdapter.submit(
      input(
        http,
        'audio',
        { prompt: 'read this aloud', voice: 'aria', language: 'en' },
        'tts-model',
      ),
    );
    expect(seen?.body).toEqual({
      model: 'tts-model',
      params: { prompt: 'read this aloud', voice: 'aria', language: 'en' },
    });
  });

  it('normalizes a reference image (img2img) to HuiMeng image_url', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp({ status: 200, body: { task_id: 't-i2i', status: 'pending' } }, (r) => {
      seen = r;
    });
    // The run path resolves a `file` input (file_id) to a fetchable URL before the
    // adapter sees it; the adapter normalizes any known reference-image alias
    // (image_url / image / init_image / reference_image) to HuiMeng's `image_url`.
    await asyncMediaAdapter.submit(
      input(
        http,
        'image',
        {
          prompt: 'restyle this product on a marble table',
          init_image: 'https://asset.actionow.ai/t/in.jpg',
        },
        'img-model',
      ),
    );
    expect(seen?.body).toEqual({
      model: 'img-model',
      params: {
        prompt: 'restyle this product on a marble table',
        image_url: 'https://asset.actionow.ai/t/in.jpg',
      },
    });
  });

  it('passes a direct image_url reference through unchanged', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp({ status: 200, body: { task_id: 't-url', status: 'pending' } }, (r) => {
      seen = r;
    });
    await asyncMediaAdapter.submit(
      input(
        http,
        'image',
        { prompt: 'a cat', image_url: 'https://asset.actionow.ai/t/ref.jpg' },
        'nb-2',
      ),
    );
    expect(seen?.body).toEqual({
      model: 'nb-2',
      params: { prompt: 'a cat', image_url: 'https://asset.actionow.ai/t/ref.jpg' },
    });
  });

  it('forwards webhook_url + idempotency_key when present on inputs', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp({ status: 200, body: { task_id: 't2', status: 'pending' } }, (r) => {
      seen = r;
    });
    await asyncMediaAdapter.submit({
      ...input(http, 'image', { prompt: 'x' }, 'img-model'),
      inputs: { prompt: 'x', webhook_url: 'https://cb.test/relay', idempotency_key: 'idem-1' },
    });
    const body = seen?.body as Record<string, unknown>;
    expect(body.webhook_url).toBe('https://cb.test/relay');
    expect(body.idempotency_key).toBe('idem-1');
    expect(body.params).toEqual({ prompt: 'x' });
  });

  it('throws invalid_input when no prompt is supplied', async () => {
    const http = fakeHttp({ status: 200, body: {} });
    await expect(
      asyncMediaAdapter.submit(input(http, 'image', {}, 'img-model')),
    ).rejects.toMatchObject({ unified: { code: 'invalid_input', retryable: false } });
  });

  it('maps a 401 submit to unauthorized', async () => {
    const http = fakeHttp({ status: 401, body: { error_message: 'bad key' } });
    await expect(
      asyncMediaAdapter.submit(input(http, 'image', { prompt: 'x' }, 'img-model')),
    ).rejects.toMatchObject({
      unified: { code: 'unauthorized', retryable: false, upstream: { provider: 'async-media' } },
    });
  });

  it('polls pending/processing as running, no output', async () => {
    let seen: HttpRequest | undefined;
    const ctx = input(
      fakeHttp(
        { status: 200, body: { id: 't', model: 'img-model', status: 'processing' } },
        (r) => {
          seen = r;
        },
      ),
      'image',
      { prompt: 'x' },
      'img-model',
    ).ctx;
    const r = await asyncMediaAdapter.poll?.('t', ctx);
    expect(seen?.method).toBe('GET');
    expect(seen?.url).toBe('https://relay.example/v1/tasks/t');
    expect(r?.status).toBe('running');
    expect(r?.output).toBeUndefined();
  });

  it('polls completed image as succeeded with image_url(s) output + per-image usage', async () => {
    const ctx = input(
      fakeHttp({
        status: 200,
        body: {
          id: 't',
          model: 'img-model',
          status: 'completed',
          result: {
            image_url: 'https://cdn.relay.example/a.png',
            image_urls: ['https://cdn.relay.example/a.png'],
            image_count: 1,
            size: '1024x1024',
          },
          cost: 0.25,
        },
      }),
      'image',
      { prompt: 'x' },
      'img-model',
    ).ctx;
    const r = await asyncMediaAdapter.poll?.('t', ctx);
    expect(r?.status).toBe('succeeded');
    expect(r?.output).toMatchObject({
      image_url: 'https://cdn.relay.example/a.png',
      image_urls: ['https://cdn.relay.example/a.png'],
    });
    expect(r?.usage).toEqual({ images: 1 });
  });

  it('polls a multi-image task: usage reflects image_count (per-image metering)', async () => {
    const ctx = input(
      fakeHttp({
        status: 200,
        body: {
          status: 'completed',
          result: {
            image_urls: [
              'https://cdn/1.png',
              'https://cdn/2.png',
              'https://cdn/3.png',
              'https://cdn/4.png',
            ],
            image_count: 4,
            generated_images: 4,
          },
        },
      }),
      'image',
      { prompt: 'x' },
      'img-model',
    ).ctx;
    const r = await asyncMediaAdapter.poll?.('t', ctx);
    expect(r?.usage).toEqual({ images: 4 });
  });

  it('polls completed video as succeeded with video_url output + per-second usage', async () => {
    const ctx = input(
      fakeHttp({
        status: 200,
        body: {
          id: 't',
          model: 'vid-model',
          status: 'completed',
          result: {
            video_url: 'https://cdn.relay.example/v.mp4',
            duration: 5,
            resolution: '720p',
            ratio: '16:9',
          },
          cost: 1,
        },
      }),
      'video',
      { prompt: 'x' },
      'vid-model',
    ).ctx;
    const r = await asyncMediaAdapter.poll?.('t', ctx);
    expect(r?.status).toBe('succeeded');
    expect(r?.output).toMatchObject({ video_url: 'https://cdn.relay.example/v.mp4' });
    expect(r?.usage).toEqual({ duration_seconds: 5 });
  });

  it('polls completed audio as succeeded with audio_url output + per-character usage', async () => {
    const ctx = input(
      fakeHttp({
        status: 200,
        body: {
          status: 'completed',
          result: {
            audio_url: 'https://cdn.relay.example/speech.mp3',
            character_count: 42,
            audio_duration: 7,
          },
        },
      }),
      'audio',
      { prompt: 'x' },
      'tts-model',
    ).ctx;
    const r = await asyncMediaAdapter.poll?.('t', ctx);
    expect(r?.status).toBe('succeeded');
    expect(r?.output).toMatchObject({ audio_url: 'https://cdn.relay.example/speech.mp3' });
    // character_count takes precedence (TTS bills per input character).
    expect(r?.usage).toEqual({ characters: 42 });
  });

  it('meters generated audio by audio_seconds when no character count is present', async () => {
    const ctx = input(
      fakeHttp({
        status: 200,
        body: {
          status: 'completed',
          result: { audio_url: 'https://cdn.relay.example/music.wav', audio_duration: 30 },
        },
      }),
      'audio',
      { prompt: 'lofi beat' },
      'music-model',
    ).ctx;
    const r = await asyncMediaAdapter.poll?.('t', ctx);
    expect(r?.usage).toEqual({ audio_seconds: 30 });
  });

  it('polls failed as failed with a job_failed error carrying error_message', async () => {
    const ctx = input(
      fakeHttp({
        status: 200,
        body: { id: 't', model: 'img-model', status: 'failed', error_message: 'nsfw blocked' },
      }),
      'image',
      { prompt: 'x' },
      'img-model',
    ).ctx;
    const r = await asyncMediaAdapter.poll?.('t', ctx);
    expect(r?.status).toBe('failed');
    expect(r?.error?.code).toBe('job_failed');
    expect(r?.error?.message).toContain('nsfw blocked');
  });

  it('parseCallback verifies a valid HMAC signature and returns the mapped result', () => {
    const secret = 'relay-webhook-secret';
    const ts = '1750000000';
    const rawBody = JSON.stringify({
      event: 'task.completed',
      task_id: 'task-uuid-1',
      data: {
        status: 'completed',
        result: { image_url: 'https://cdn.relay.example/a.png' },
        cost: 0.25,
        created_at: '2026-06-16T00:00:00Z',
        completed_at: '2026-06-16T00:01:00Z',
      },
    });
    const sig = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
    const cb = asyncMediaAdapter.parseCallback?.({
      rawBody,
      headers: {
        'x-signature': sig,
        'x-timestamp': ts,
        'x-event': 'task.completed',
      },
      secret,
      nowMs: Number(ts) * 1000,
      signatureHeader: 'x-signature',
      timestampHeader: 'x-timestamp',
    });
    expect(cb).toMatchObject({ upstreamJobId: 'task-uuid-1', status: 'succeeded' });
    expect(cb?.output).toMatchObject({ image_url: 'https://cdn.relay.example/a.png' });
    expect(cb?.usage).toEqual({ images: 1 });
  });

  it('parseCallback returns an empty upstreamJobId for a bad signature', () => {
    const cb = asyncMediaAdapter.parseCallback?.({
      rawBody: '{"task_id":"x"}',
      headers: { 'x-signature': 'deadbeef', 'x-timestamp': '1750000000' },
      secret: 'relay-webhook-secret',
      nowMs: 1750000000 * 1000,
      signatureHeader: 'x-signature',
      timestampHeader: 'x-timestamp',
    });
    expect(cb?.upstreamJobId).toBe('');
  });

  it('parseCallback rejects a stale timestamp outside the replay window', () => {
    const secret = 'relay-webhook-secret';
    const ts = '1000000000';
    const rawBody = '{"event":"task.completed","task_id":"x","data":{"status":"completed"}}';
    const sig = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
    const cb = asyncMediaAdapter.parseCallback?.({
      rawBody,
      headers: { 'x-signature': sig, 'x-timestamp': ts },
      secret,
      nowMs: 1750000000 * 1000, // ~24 years later → outside the 5-min window
      signatureHeader: 'x-signature',
      timestampHeader: 'x-timestamp',
    });
    expect(cb?.upstreamJobId).toBe('');
  });

  it('extractUsage maps a completed task to a single-task vector', () => {
    expect(asyncMediaAdapter.extractUsage({ status: 'completed', cost: 0.25 })).toEqual({
      tasks: 1,
    });
  });

  it('forwards ctx.proxyUrl onto the submit request', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp({ status: 200, body: { task_id: 't', status: 'pending' } }, (r) => {
      seen = r;
    });
    const submitInput = input(http, 'image', { prompt: 'x' }, 'img-model');
    submitInput.ctx.proxyUrl = 'http://p:8080';
    await asyncMediaAdapter.submit(submitInput);
    expect(seen?.proxyUrl).toBe('http://p:8080');
  });

  it('forwards ctx.proxyUrl onto the poll request', async () => {
    let seen: HttpRequest | undefined;
    const ctx = input(
      fakeHttp({ status: 200, body: { id: 't', status: 'processing' } }, (r) => {
        seen = r;
      }),
      'image',
      { prompt: 'x' },
      'img-model',
    ).ctx;
    ctx.proxyUrl = 'http://p:8080';
    await asyncMediaAdapter.poll?.('t', ctx);
    expect(seen?.proxyUrl).toBe('http://p:8080');
  });
});
