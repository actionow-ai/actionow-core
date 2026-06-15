import { createJob, getJob, holdCredits, schema } from '@actionow/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { Reaper } from '../src/reaper.js';

const { account, resource, resourceVersion, tenant } = schema;

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
  await client`TRUNCATE TABLE webhook_outbox, ledger_txn, idempotency_key, job, account, resource_version, resource, tenant RESTART IDENTITY CASCADE`;
});

interface Seed {
  tenantId: string;
  accountId: string;
  resourceId: string;
}

async function seed(balance: bigint): Promise<Seed> {
  const [t] = await db.insert(tenant).values({ name: 'acme' }).returning();
  if (!t) throw new Error('tenant insert returned no row');
  const [a] = await db
    .insert(account)
    .values({ tenantId: t.id, creditBalance: balance, creditHeld: 0n })
    .returning();
  if (!a) throw new Error('account insert returned no row');
  const resourceId = 'openai';
  await db.insert(resource).values({
    id: resourceId,
    tenantId: t.id,
    kind: 'model',
    modality: 'text',
    providerType: 'fake',
    execModes: ['async-poll'],
  });
  await db
    .insert(resourceVersion)
    .values({ resourceId, version: 1, ioSchema: { inputs: [], outputs: [] } });
  return { tenantId: t.id, accountId: a.id, resourceId };
}

async function readAccount(accountId: string): Promise<{ balance: bigint; held: bigint }> {
  const [a] = await db.select().from(account).where(eq(account.id, accountId));
  if (!a) throw new Error('account not found');
  return { balance: a.creditBalance, held: a.creditHeld };
}

async function makeInFlightJob(s: Seed, hold: bigint, holdExpiresAt: Date): Promise<string> {
  const ok = await holdCredits(db, s.accountId, hold);
  if (!ok) throw new Error('hold failed in fixture');
  const j = await createJob(db, {
    tenantId: s.tenantId,
    resourceId: s.resourceId,
    resourceVersion: 1,
    execMode: 'async-poll',
    inputs: {},
    quotedCredits: hold,
    holdExpiresAt,
  });
  return j.id;
}

describe('Reaper.reapExpiredHolds', () => {
  it('cancels an expired in-flight job and releases its hold (held → 0)', async () => {
    const s = await seed(1_000_000n);
    const past = new Date('2026-06-16T00:00:00.000Z');
    const jobId = await makeInFlightJob(s, 500_000n, past);
    expect(await readAccount(s.accountId)).toEqual({ balance: 1_000_000n, held: 500_000n });

    const reaper = new Reaper();
    const reaped = await reaper.reapExpiredHolds(db, new Date(past.getTime() + 60_000));

    expect(reaped).toBe(1);
    expect(await readAccount(s.accountId)).toEqual({ balance: 1_000_000n, held: 0n });
    expect((await getJob(db, jobId))?.status).toBe('canceled');
  });

  it('does not touch jobs whose hold has not yet expired', async () => {
    const s = await seed(1_000_000n);
    const future = new Date('2026-06-16T01:00:00.000Z');
    await makeInFlightJob(s, 200_000n, future);

    const reaper = new Reaper();
    const reaped = await reaper.reapExpiredHolds(db, new Date('2026-06-16T00:00:00.000Z'));
    expect(reaped).toBe(0);
    expect(await readAccount(s.accountId)).toEqual({ balance: 1_000_000n, held: 200_000n });
  });

  it('does not re-cancel an already-terminal job (idempotent vs late callback)', async () => {
    const s = await seed(1_000_000n);
    const past = new Date('2026-06-16T00:00:00.000Z');
    const jobId = await makeInFlightJob(s, 100_000n, past);

    const reaper = new Reaper();
    const now = new Date(past.getTime() + 60_000);
    expect(await reaper.reapExpiredHolds(db, now)).toBe(1);
    // second pass: the job is canceled (terminal) → not selected → 0 reaped
    expect(await reaper.reapExpiredHolds(db, now)).toBe(0);
    expect(await readAccount(s.accountId)).toEqual({ balance: 1_000_000n, held: 0n });
    expect((await getJob(db, jobId))?.status).toBe('canceled');
  });
});
