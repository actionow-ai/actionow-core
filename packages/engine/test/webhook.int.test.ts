import type { HttpClient, HttpRequest, HttpResponse } from '@actionow/contracts';
import { schema } from '@actionow/db';
import { assertEgressAllowed } from '@actionow/infra';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { SIGNATURE_HEADER, signPayload, WebhookDispatcher } from '../src/webhook.js';

const { webhookOutbox } = schema;

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 10 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: '../db/drizzle' });
}, 120_000);

afterAll(async () => {
  await client.end();
  await container.stop();
});

afterEach(async () => {
  await client`TRUNCATE TABLE webhook_outbox RESTART IDENTITY CASCADE`;
});

/** A recording HTTP client that returns a scripted status (or throws) per call. */
function recordingHttp(handler: (req: HttpRequest) => HttpResponse | Error): {
  http: HttpClient;
  calls: HttpRequest[];
} {
  const calls: HttpRequest[] = [];
  const http: HttpClient = {
    request(req: HttpRequest): Promise<HttpResponse> {
      calls.push(req);
      const out = handler(req);
      if (out instanceof Error) return Promise.reject(out);
      return Promise.resolve(out);
    },
  };
  return { http, calls };
}

describe('WebhookDispatcher.dispatchDue', () => {
  it('POSTs the signed payload and marks the row sent on success', async () => {
    const payload = { job_id: 'job-1', status: 'succeeded' };
    await db.insert(webhookOutbox).values({
      jobId: '00000000-0000-0000-0000-000000000001',
      url: 'https://hook.test/cb',
      payload,
    });

    const { http, calls } = recordingHttp(() => ({
      status: 200,
      ok: true,
      body: undefined,
      text: 'ok',
    }));
    const dispatcher = new WebhookDispatcher({ resolveSecret: () => Promise.resolve('whsec') });

    const summary = await dispatcher.dispatchDue(db, http, new Date());

    expect(summary).toMatchObject({ processed: 1, sent: 1, retried: 0, dead: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe('https://hook.test/cb');
    // signature header is the HMAC of the serialized payload
    const expectedSig = signPayload('whsec', JSON.stringify(payload));
    expect(calls[0]?.headers?.[SIGNATURE_HEADER]).toBe(expectedSig);

    const rows = await db.select().from(webhookOutbox);
    expect(rows[0]?.status).toBe('sent');
    expect(rows[0]?.attempts).toBe(1);
  });

  it('backs off on failure, bumping attempts, then dead-letters at the cap', async () => {
    // Pin the row's due time explicitly so the test is deterministic regardless of wall clock.
    const t0 = new Date('2026-06-16T00:00:00.000Z');
    await db.insert(webhookOutbox).values({
      jobId: '00000000-0000-0000-0000-000000000002',
      url: 'https://hook.test/down',
      payload: { job_id: 'job-2' },
      nextAttemptAt: t0,
    });

    // Always fail (500).
    const { http } = recordingHttp(() => ({
      status: 500,
      ok: false,
      body: undefined,
      text: 'err',
    }));
    const dispatcher = new WebhookDispatcher({
      maxAttempts: 3,
      backoffBaseMs: 1000,
      resolveSecret: () => Promise.resolve('whsec'),
    });

    // Attempt 1 → retried, attempts=1, next_attempt_at = t0 + 1000ms
    const s1 = await dispatcher.dispatchDue(db, http, t0);
    expect(s1).toMatchObject({ retried: 1, dead: 0, sent: 0 });
    let row = (await db.select().from(webhookOutbox))[0];
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(1);
    expect(row?.nextAttemptAt.getTime()).toBe(t0.getTime() + 1000);

    // Before it is due again, dispatchDue at t0 finds nothing.
    expect((await dispatcher.dispatchDue(db, http, t0)).processed).toBe(0);

    // Attempt 2 at the due time → retried, attempts=2, backoff 2000ms
    const t1 = new Date(t0.getTime() + 1000);
    const s2 = await dispatcher.dispatchDue(db, http, t1);
    expect(s2).toMatchObject({ retried: 1, dead: 0 });
    row = (await db.select().from(webhookOutbox))[0];
    expect(row?.attempts).toBe(2);
    expect(row?.nextAttemptAt.getTime()).toBe(t1.getTime() + 2000);

    // Attempt 3 at the due time → reaches maxAttempts → dead
    const t2 = new Date(t1.getTime() + 2000);
    const s3 = await dispatcher.dispatchDue(db, http, t2);
    expect(s3).toMatchObject({ dead: 1, retried: 0, sent: 0 });
    row = (await db.select().from(webhookOutbox))[0];
    expect(row?.status).toBe('dead');
    expect(row?.attempts).toBe(3);

    // A dead row is never selected again.
    expect(
      (await dispatcher.dispatchDue(db, http, new Date(t2.getTime() + 1_000_000))).processed,
    ).toBe(0);
  });

  it('dead-letters an SSRF callback target without POSTing (default egress guard)', async () => {
    // The cloud metadata IP — a classic SSRF target. The default dispatcher must
    // refuse it and dead-letter immediately (retrying a blocked URL is pointless).
    await db.insert(webhookOutbox).values({
      jobId: '00000000-0000-0000-0000-000000000004',
      url: 'http://169.254.169.254/latest/meta-data/',
      payload: { job_id: 'job-4' },
    });
    const { http, calls } = recordingHttp(() => ({
      status: 200,
      ok: true,
      body: undefined,
      text: 'ok',
    }));
    const dispatcher = new WebhookDispatcher({});

    const summary = await dispatcher.dispatchDue(db, http, new Date());

    expect(summary).toMatchObject({ processed: 1, dead: 1, sent: 0, retried: 0 });
    // The blocked URL is NEVER fetched.
    expect(calls).toHaveLength(0);
    const row = (await db.select().from(webhookOutbox))[0];
    expect(row?.status).toBe('dead');
  });

  it('delivers to a private/loopback target when an allow-private guard is injected', async () => {
    await db.insert(webhookOutbox).values({
      jobId: '00000000-0000-0000-0000-000000000005',
      url: 'http://127.0.0.1:9000/hook',
      payload: { job_id: 'job-5' },
    });
    const { http, calls } = recordingHttp(() => ({
      status: 200,
      ok: true,
      body: undefined,
      text: 'ok',
    }));
    const dispatcher = new WebhookDispatcher({
      assertEgressAllowed: (url) => assertEgressAllowed(url, { allowPrivateTargets: true }),
    });

    const summary = await dispatcher.dispatchDue(db, http, new Date());
    expect(summary).toMatchObject({ processed: 1, sent: 1, dead: 0, retried: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://127.0.0.1:9000/hook');
  });

  it('treats a thrown network error as a delivery failure (retry)', async () => {
    await db.insert(webhookOutbox).values({
      jobId: '00000000-0000-0000-0000-000000000003',
      url: 'https://hook.test/timeout',
      payload: { job_id: 'job-3' },
    });
    const { http } = recordingHttp(() => new Error('ECONNRESET'));
    const dispatcher = new WebhookDispatcher({ maxAttempts: 5 });

    const summary = await dispatcher.dispatchDue(db, http, new Date());
    expect(summary).toMatchObject({ retried: 1, sent: 0, dead: 0 });
    const row = (await db.select().from(webhookOutbox))[0];
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(1);
  });
});
