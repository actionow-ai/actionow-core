/**
 * Opt-in LIVE provider e2e — REALLY hits the upstreams. SKIPPED by default.
 *
 * The default `pnpm test` never runs this suite (no network): it self-skips
 * unless `LIVE_PROVIDER_TEST=1` AND the relevant secrets are present in the
 * environment. To run it manually, load `.env` and set the flag, e.g.:
 *
 *   LIVE_PROVIDER_TEST=1 node --env-file=.env \
 *     ./node_modules/.bin/vitest run --dir apps/api test/live-providers
 *
 * Required env (read from `process.env`; the operator supplies them):
 *   - SECRET_DEEPSEEK   (alias: SECRET_DEEPSEEK_API_KEY) — DeepSeek chat key
 *   - SECRET_HUIMENG    (alias: SECRET_HUIMENG_API_KEY)  — relay media key
 *   - STORAGE_ENDPOINT / STORAGE_ACCESS_KEY_ID / STORAGE_SECRET_ACCESS_KEY
 *     (+ optional STORAGE_BUCKET) — R2 round-trip
 *   - UPSTREAM_PROXY_URL (optional) — egress proxy honoured if set
 *
 * The suite drives the adapters + storage provider DIRECTLY with keys read
 * from env (no NestJS boot, no seed-credential resolution), exercising the
 * real integration: async-media relay (image submit→poll), OpenAI-compatible
 * blocking chat, and an R2 PUT/GET round-trip.
 */
import { asyncMediaAdapter, openaiAdapter } from '@actionow/adapters';
import { createS3StorageProvider, FetchHttpClient } from '@actionow/infra';
import { describe, expect, it } from 'vitest';

const LIVE = process.env.LIVE_PROVIDER_TEST === '1';

/** Read the first defined env var from a list of aliases. */
const env = (...keys: readonly string[]): string | undefined => {
  for (const key of keys) {
    const v = process.env[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
};

const deepseekKey = env('SECRET_DEEPSEEK', 'SECRET_DEEPSEEK_API_KEY');
const huimengKey = env('SECRET_HUIMENG', 'SECRET_HUIMENG_API_KEY');
const hasR2 =
  env('STORAGE_ENDPOINT') !== undefined &&
  env('STORAGE_ACCESS_KEY_ID') !== undefined &&
  env('STORAGE_SECRET_ACCESS_KEY') !== undefined;

const proxyUrl = env('UPSTREAM_PROXY_URL');
const http = new FetchHttpClient();

/** Relay protocol config (vendor specifics supplied as data, not code). */
const relayConfig: Record<string, unknown> = {
  submitPath: '/api/v1/tasks',
  pollPath: '/api/v1/tasks/{id}',
  signatureHeader: 'X-HuiMeng-Signature',
  timestampHeader: 'X-HuiMeng-Timestamp',
};

describe.skipIf(!(LIVE && deepseekKey !== undefined))('LIVE: DeepSeek blocking chat', () => {
  it('returns text from a real deepseek-chat completion', async () => {
    const r = await openaiAdapter.submit({
      resourceId: 'deepseek-chat',
      modality: 'text',
      inputs: { prompt: 'Reply with the single word: ok', max_tokens: 16 },
      execMode: 'blocking',
      ctx: {
        providerType: 'openai',
        model: 'deepseek-chat',
        endpoint: 'https://api.deepseek.com/v1',
        ...(deepseekKey !== undefined ? { apiKey: deepseekKey } : {}),
        ...(proxyUrl !== undefined ? { proxyUrl } : {}),
        http,
      },
    });
    expect(r.kind).toBe('sync');
    if (r.kind === 'sync') {
      expect(typeof r.output.text).toBe('string');
      expect((r.output.text as string).length).toBeGreaterThan(0);
    }
  }, 60_000);
});

describe.skipIf(!(LIVE && huimengKey !== undefined))(
  'LIVE: async-media relay image submit→poll',
  () => {
    it('submits an image task and polls to completed with a media URL', async () => {
      const ctx = {
        providerType: 'async-media',
        model: 'seedream-4.5',
        endpoint: 'https://api.huimengi.com',
        config: relayConfig,
        ...(huimengKey !== undefined ? { apiKey: huimengKey } : {}),
        ...(proxyUrl !== undefined ? { proxyUrl } : {}),
        http,
      } as const;

      const submitted = await asyncMediaAdapter.submit({
        resourceId: 'relay-image',
        modality: 'image',
        inputs: { prompt: 'a single red apple on a white background' },
        execMode: 'async-poll',
        ctx,
      });
      expect(submitted.kind).toBe('async');
      if (submitted.kind !== 'async') throw new Error('expected an async handle');

      // Poll up to ~90s (45 attempts * 2s).
      let last: Awaited<ReturnType<NonNullable<typeof asyncMediaAdapter.poll>>> | undefined;
      for (let i = 0; i < 45; i += 1) {
        last = await asyncMediaAdapter.poll?.(submitted.upstreamJobId, ctx);
        if (last?.status === 'succeeded' || last?.status === 'failed') break;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      expect(last?.status).toBe('succeeded');
      const mediaUrl = last?.output?.image_url ?? last?.output?.video_url;
      expect(typeof mediaUrl).toBe('string');
    }, 90_000);
  },
);

describe.skipIf(!(LIVE && hasR2))('LIVE: R2 persistence round-trip', () => {
  it('uploads and downloads bytes via the real R2 bucket', async () => {
    const endpoint = env('STORAGE_ENDPOINT');
    const storage = createS3StorageProvider({
      kind: 'r2',
      bucket: env('STORAGE_BUCKET') ?? 'actionow',
      region: 'auto',
      ...(endpoint !== undefined ? { endpoint } : {}),
      accessKeyId: env('STORAGE_ACCESS_KEY_ID') ?? '',
      secretAccessKey: env('STORAGE_SECRET_ACCESS_KEY') ?? '',
      forcePathStyle: true,
    });
    const key = `live-test/${String(Date.now())}.txt`;
    const expected = 'actionow live r2';

    const put = await storage.presignPut(key, { contentType: 'text/plain' });
    const putRes = await fetch(put.url, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: new TextEncoder().encode(expected),
    });
    expect(putRes.status).toBe(200);
    expect((await storage.head(key)).exists).toBe(true);

    const get = await storage.presignGet(key);
    const got = await (await fetch(get.url)).text();
    expect(got).toBe(expected);

    await storage.delete(key);
  }, 60_000);
});
