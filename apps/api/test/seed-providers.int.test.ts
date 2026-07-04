import {
  getActivePricebookEntry,
  getResource,
  listChannels,
  listResources,
  schema,
  type UpstreamChannelRow,
} from '@actionow/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { seedAll } from '../src/seed/seed.js';
import { PROVIDER_SEED_IDS, seedProviders } from '../src/seed/seed-providers.js';

/**
 * Task 12 — the real-provider seed registers image/video/chat resources +
 * channels + pricebooks as DATA (the ONE place a vendor's protocol may appear).
 * Runs `seedProviders` against a plain Testcontainers pg (migrations applied
 * from scratch) and asserts the catalog rows carry the right
 * endpoint/model/config/credential/proxy values, and that a second run is a
 * no-op (idempotent).
 */

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 10 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: '../../packages/db/drizzle' });
}, 180_000);

afterAll(async () => {
  await client.end();
  await container.stop();
});

/** Resolve the `secret_ref.locator` (the env-key ref) a channel's credential points at. */
async function credentialLocator(
  channel: UpstreamChannelRow | undefined,
): Promise<string | undefined> {
  const ref = channel?.credentialRef;
  if (ref === null || ref === undefined) return undefined;
  const rows = await db
    .select({ locator: schema.secretRef.locator })
    .from(schema.secretRef)
    .where(eq(schema.secretRef.id, ref))
    .limit(1);
  return rows[0]?.locator;
}

describe('seedProviders (real-provider catalog as DATA)', () => {
  it('seeds the image relay channel with the vendor protocol entirely in DATA', async () => {
    const { tenantId } = await seedAll(db, { providerType: 'stub' });
    await seedProviders(db, { tenantId });

    const image = await getResource(db, 'image-relay');
    expect(image?.providerType).toBe('async-media');
    expect(image?.modality).toBe('image');
    expect(image?.execModes).toEqual(['async-poll', 'async-callback']);

    const [channel] = await listChannels(db, 'image-relay');
    expect(channel?.providerType).toBe('async-media');
    expect(channel?.endpoint).toBe('https://api.huimengi.com');
    expect(channel?.model).toBe('seedream-4.5');
    expect(channel?.status).toBe('active');
    // The vendor protocol (task paths + signature header names) is DATA; the image
    // relay carries a 3-min poll budget for HuiMeng's slower image models.
    expect(channel?.config).toEqual({
      submitPath: '/api/v1/tasks',
      pollPath: '/api/v1/tasks/{id}',
      signatureHeader: 'X-HuiMeng-Signature',
      timestampHeader: 'X-HuiMeng-Timestamp',
      maxPolls: 60,
      pollIntervalMs: 3000,
    });
    // credential_ref → secret_ref locator `huimeng` → SecretResolver reads SECRET_HUIMENG.
    expect(await credentialLocator(channel)).toBe('huimeng');

    // Per-image pricing: 250_000 µcredits per image (the `async-media` adapter
    // meters `{ images: N }`); `tasks` is a same-rate fallback for results with
    // no image count, so a media job never settles 0.
    const pricebook = await getActivePricebookEntry(db, 'image-relay', 1);
    expect(pricebook?.method).toBe('unit');
    expect(pricebook?.timing).toBe('post');
    expect(pricebook?.spec).toEqual({
      method: 'unit',
      dimensions: { images: { rate: 250_000 }, tasks: { rate: 250_000 } },
    });
  });

  it('seeds the video relay channel: same endpoint/config, model seedance-2.0, 1.5M µcredits/video', async () => {
    const { tenantId } = await seedAll(db, { providerType: 'stub' });
    await seedProviders(db, { tenantId });

    const video = await getResource(db, 'video-relay');
    expect(video?.providerType).toBe('async-media');
    expect(video?.modality).toBe('video');

    const [channel] = await listChannels(db, 'video-relay');
    expect(channel?.providerType).toBe('async-media');
    expect(channel?.endpoint).toBe('https://api.huimengi.com');
    expect(channel?.model).toBe('seedance-2.0');
    // Video shares the relay protocol but carries a LONGER poll budget so a
    // multi-minute clip doesn't time out at the ~30s default (the job-runner
    // reads maxPolls/pollIntervalMs off the channel config).
    expect(channel?.config).toEqual({
      submitPath: '/api/v1/tasks',
      pollPath: '/api/v1/tasks/{id}',
      signatureHeader: 'X-HuiMeng-Signature',
      timestampHeader: 'X-HuiMeng-Timestamp',
      maxPolls: 120,
      pollIntervalMs: 5000,
    });
    expect(await credentialLocator(channel)).toBe('huimeng');

    // Per-second video pricing (300_000 µcredits/s); `tasks` (1.5M) is the
    // per-clip fallback when the relay result omits a duration.
    const pricebook = await getActivePricebookEntry(db, 'video-relay', 1);
    expect(pricebook?.spec).toEqual({
      method: 'unit',
      dimensions: { duration_seconds: { rate: 300_000 }, tasks: { rate: 1_500_000 } },
    });
  });

  it('seeds media models (image seedream + video seedance/kling) linked to the channel; NO audio relay', async () => {
    const { tenantId } = await seedAll(db, { providerType: 'stub' });
    await seedProviders(db, { tenantId });

    // HuiMeng offers only image/video (+ text), so there is no audio relay.
    expect(await getResource(db, 'audio-relay')).toBeUndefined();

    // image-relay: all HuiMeng image models (seedream/nb/image-2/z-image), active,
    // image modality, no token price; the vendor `maker` is inferred from the id.
    const imgModels = await db
      .select()
      .from(schema.model)
      .where(eq(schema.model.resourceId, 'image-relay'));
    expect(imgModels.map((m) => m.name).sort()).toEqual(
      [
        'image-2',
        'image-2-official',
        'nb-2',
        'nb-2-official',
        'nb-pro',
        'nb-pro-official',
        'seedream-4.5',
        'seedream-5.0-lite',
        'z-image-turbo',
      ].sort(),
    );
    for (const m of imgModels) {
      expect(m.status).toBe('active');
      expect(m.modality).toBe('image');
      expect(m.inputPrice).toBe(0n);
    }
    expect(imgModels.find((m) => m.name === 'nb-2')?.maker).toBe('google');
    expect(imgModels.find((m) => m.name === 'image-2')?.maker).toBe('openai');
    // …all linked to the channel so it ships non-empty (the "N 模型" grid).
    const [imgChannel] = await listChannels(db, 'image-relay');
    const imgLinks = await db
      .select()
      .from(schema.channelModel)
      .where(eq(schema.channelModel.channelId, imgChannel?.id ?? ''));
    expect(imgLinks).toHaveLength(9);

    // video-relay: the 9 seedance/kling models, linked.
    const vidModels = await db
      .select()
      .from(schema.model)
      .where(eq(schema.model.resourceId, 'video-relay'));
    expect(vidModels).toHaveLength(9);
    expect(vidModels.some((m) => m.name === 'kling-v3')).toBe(true);
    expect(vidModels.every((m) => m.status === 'active' && m.modality === 'video')).toBe(true);
  });

  it('seeds the speech-to-text relay channel: openai dialect, whisper-1, per-second pricing, proxy_ref', async () => {
    const { tenantId } = await seedAll(db, { providerType: 'stub' });
    await seedProviders(db, { tenantId });

    const stt = await getResource(db, 'stt-relay');
    expect(stt?.providerType).toBe('openai');
    expect(stt?.modality).toBe('audio');
    // Synchronous transcription — blocking only (no async-poll/callback).
    expect(stt?.execModes).toEqual(['blocking']);

    const [channel] = await listChannels(db, 'stt-relay');
    expect(channel?.providerType).toBe('openai');
    expect(channel?.endpoint).toBeNull(); // use the adapter default OpenAI host
    expect(channel?.model).toBe('whisper-1');
    expect(channel?.status).toBe('active');
    expect(channel?.proxyRef).toBe('upstream_proxy'); // direct OpenAI host → egress proxy
    expect(await credentialLocator(channel)).toBe('openai');

    // STT bills per SECOND of transcribed audio (100 µcredits/s); the relay always
    // yields `audio_seconds`, so there is no `tasks` fallback dimension.
    const pricebook = await getActivePricebookEntry(db, 'stt-relay', 1);
    expect(pricebook?.method).toBe('unit');
    expect(pricebook?.timing).toBe('post');
    expect(pricebook?.spec).toEqual({
      method: 'unit',
      dimensions: { audio_seconds: { rate: 100 } },
    });
  });

  it('seeds the openai-compatible chat channels with per-channel endpoint/model + token pricing', async () => {
    const { tenantId } = await seedAll(db, { providerType: 'stub' });
    await seedProviders(db, { tenantId });

    // DeepSeek
    const deepseek = await getResource(db, 'deepseek-chat');
    expect(deepseek?.providerType).toBe('openai');
    expect(deepseek?.modality).toBe('text');
    expect(deepseek?.execModes).toEqual(['blocking', 'stream']);
    const [dsChannel] = await listChannels(db, 'deepseek-chat');
    expect(dsChannel?.providerType).toBe('openai');
    expect(dsChannel?.endpoint).toBe('https://api.deepseek.com/v1');
    expect(dsChannel?.model).toBe('deepseek-chat');
    expect(dsChannel?.config).toBeNull();
    expect(await credentialLocator(dsChannel)).toBe('deepseek');
    // Token pricing reuses the existing metered method: unit/post over `tokens`.
    const dsPrice = await getActivePricebookEntry(db, 'deepseek-chat', 1);
    expect(dsPrice?.method).toBe('unit');
    expect(dsPrice?.timing).toBe('post');
    expect(dsPrice?.spec).toEqual({ method: 'unit', dimensions: { tokens: { rate: 1 } } });

    // Xiaomi MiMo
    const [mimoChannel] = await listChannels(db, 'xiaomi-mimo');
    expect(mimoChannel?.endpoint).toBe('https://api.xiaomimimo.com/v1');
    expect(mimoChannel?.model).toBe('mimo-v2.5');
    expect(await credentialLocator(mimoChannel)).toBe('xiaomi');

    // relay-text (GPT/Gemini via the relay): openai adapter, relay endpoint + key
    const [relayChannel] = await listChannels(db, 'relay-text');
    expect(relayChannel?.providerType).toBe('openai');
    expect(relayChannel?.endpoint).toBe('https://api.huimengi.com/v1');
    expect(relayChannel?.model).toBe('gpt-5.5');
    expect(await credentialLocator(relayChannel)).toBe('huimeng');
  });

  it('seeds direct openai/anthropic/gemini channels: no endpoint, active, with a proxy_ref', async () => {
    const { tenantId } = await seedAll(db, { providerType: 'stub' });
    await seedProviders(db, { tenantId });

    const cases: { id: string; providerType: string; model: string; locator: string }[] = [
      { id: 'openai-direct', providerType: 'openai', model: 'gpt-4o-mini', locator: 'openai' },
      {
        id: 'anthropic-direct',
        providerType: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        locator: 'anthropic',
      },
      { id: 'gemini-direct', providerType: 'gemini', model: 'gemini-2.5-flash', locator: 'gemini' },
    ];
    for (const c of cases) {
      const resource = await getResource(db, c.id);
      expect(resource?.providerType).toBe(c.providerType);
      expect(resource?.modality).toBe('text');
      const [channel] = await listChannels(db, c.id);
      expect(channel?.providerType).toBe(c.providerType);
      expect(channel?.endpoint).toBeNull(); // use the adapter default host
      expect(channel?.model).toBe(c.model);
      expect(channel?.status).toBe('active');
      expect(channel?.proxyRef).toBe('upstream_proxy'); // decision 4: active + proxy_ref
      expect(await credentialLocator(channel)).toBe(c.locator);
      expect(await getActivePricebookEntry(db, c.id, 1)).toBeDefined();
    }
  });

  it('exports exactly nine provider seed ids (no audio — HuiMeng has none)', () => {
    expect(PROVIDER_SEED_IDS).toHaveLength(9);
    expect(new Set(PROVIDER_SEED_IDS)).toEqual(
      new Set([
        'image-relay',
        'video-relay',
        'stt-relay',
        'deepseek-chat',
        'xiaomi-mimo',
        'relay-text',
        'openai-direct',
        'anthropic-direct',
        'gemini-direct',
      ]),
    );
  });

  it('is idempotent: a second run creates no new resources/channels/pricebooks', async () => {
    const { tenantId } = await seedAll(db, { providerType: 'stub' });
    await seedProviders(db, { tenantId });

    const resourcesAfterFirst = (await listResources(db, { limit: 200 })).rows.length;
    const imageChannelsAfterFirst = (await listChannels(db, 'image-relay')).length;

    await seedProviders(db, { tenantId });

    expect((await listResources(db, { limit: 200 })).rows.length).toBe(resourcesAfterFirst);
    expect((await listChannels(db, 'image-relay')).length).toBe(imageChannelsAfterFirst);
  });
});
