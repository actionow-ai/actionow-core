import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createIntent,
  getIntentByProviderRef,
  insertEventIfNew,
  markEventProcessed,
  setIntentStatus,
} from '../src/repositories/index.js';
import * as schema from '../src/schema/index.js';

const { tenant } = schema;

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 10 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
}, 120_000);

afterAll(async () => {
  await client.end();
  await container.stop();
});

afterEach(async () => {
  await client`TRUNCATE TABLE payment_event, payment_intent, tenant RESTART IDENTITY CASCADE`;
});

async function makeTenant(): Promise<string> {
  const [t] = await db.insert(tenant).values({ name: 'acme' }).returning();
  if (!t) throw new Error('tenant insert returned no row');
  return t.id;
}

describe('payment_intent repository', () => {
  it('createIntent inserts a created intent with bigint money preserved', async () => {
    const tenantId = await makeTenant();
    const intent = await createIntent(db, {
      tenantId,
      provider: 'stripe',
      providerRef: 'cs_test_1',
      purpose: 'topup',
      amountMinor: 1000n,
      currency: 'usd',
      creditAmount: 1_000_000n,
    });

    expect(intent.status).toBe('created');
    expect(intent.amountMinor).toBe(1000n);
    expect(intent.creditAmount).toBe(1_000_000n);
    expect(intent.providerRef).toBe('cs_test_1');
  });

  it('getIntentByProviderRef resolves an intent by (provider, provider_ref)', async () => {
    const tenantId = await makeTenant();
    await createIntent(db, {
      tenantId,
      provider: 'stripe',
      providerRef: 'cs_test_2',
      purpose: 'topup',
      amountMinor: 500n,
      currency: 'usd',
    });

    const found = await getIntentByProviderRef(db, 'stripe', 'cs_test_2');
    expect(found?.providerRef).toBe('cs_test_2');

    // Different provider, same ref → no match (the unique key is the pair).
    expect(await getIntentByProviderRef(db, 'alipay', 'cs_test_2')).toBeUndefined();
  });

  it('rejects a duplicate (provider, provider_ref)', async () => {
    const tenantId = await makeTenant();
    await createIntent(db, {
      tenantId,
      provider: 'stripe',
      providerRef: 'cs_dup',
      purpose: 'topup',
      amountMinor: 100n,
      currency: 'usd',
    });

    await expect(
      createIntent(db, {
        tenantId,
        provider: 'stripe',
        providerRef: 'cs_dup',
        purpose: 'topup',
        amountMinor: 200n,
        currency: 'usd',
      }),
    ).rejects.toThrow();
  });

  it('setIntentStatus transitions the status', async () => {
    const tenantId = await makeTenant();
    const intent = await createIntent(db, {
      tenantId,
      provider: 'stripe',
      providerRef: 'cs_status',
      purpose: 'topup',
      amountMinor: 100n,
      currency: 'usd',
    });

    const updated = await setIntentStatus(db, intent.id, 'succeeded');
    expect(updated?.status).toBe('succeeded');
  });
});

describe('payment_event repository (idempotency)', () => {
  it('insertEventIfNew inserts a new event and reports inserted:true', async () => {
    const r = await insertEventIfNew(db, {
      provider: 'stripe',
      providerEventId: 'evt_1',
      type: 'checkout.session.completed',
      rawPayload: { id: 'evt_1' },
      signatureOk: true,
    });

    expect(r.inserted).toBe(true);
    expect(r.existing).toBeUndefined();
  });

  it('a redelivery of the same (provider, event_id) is not re-inserted', async () => {
    const first = await insertEventIfNew(db, {
      provider: 'stripe',
      providerEventId: 'evt_dup',
      type: 'checkout.session.completed',
      rawPayload: { id: 'evt_dup', n: 1 },
      signatureOk: true,
    });
    expect(first.inserted).toBe(true);

    const second = await insertEventIfNew(db, {
      provider: 'stripe',
      providerEventId: 'evt_dup',
      type: 'checkout.session.completed',
      rawPayload: { id: 'evt_dup', n: 2 },
      signatureOk: true,
    });

    expect(second.inserted).toBe(false);
    expect(second.existing?.providerEventId).toBe('evt_dup');
    // The original payload is preserved (the redelivery did not overwrite it).
    expect(second.existing?.rawPayload).toEqual({ id: 'evt_dup', n: 1 });

    // Exactly one row persists.
    const rows =
      await client`SELECT count(*)::int AS c FROM payment_event WHERE provider_event_id = 'evt_dup'`;
    expect(rows[0]?.c).toBe(1);
  });

  it('the same event id under a different provider is an independent event', async () => {
    const a = await insertEventIfNew(db, {
      provider: 'stripe',
      providerEventId: 'shared_evt',
      type: 't',
      rawPayload: {},
      signatureOk: true,
    });
    const b = await insertEventIfNew(db, {
      provider: 'crypto',
      providerEventId: 'shared_evt',
      type: 't',
      rawPayload: {},
      signatureOk: true,
    });

    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(true);
  });

  it('markEventProcessed sets processed_at', async () => {
    const r = await insertEventIfNew(db, {
      provider: 'stripe',
      providerEventId: 'evt_proc',
      type: 't',
      rawPayload: {},
      signatureOk: true,
    });
    expect(r.inserted).toBe(true);

    const rows = await client`SELECT id FROM payment_event WHERE provider_event_id = 'evt_proc'`;
    const id = rows[0]?.id as string;
    const processed = await markEventProcessed(db, id);
    expect(processed?.processedAt).not.toBeNull();
  });
});
