// 批次5 slice4 — listGatewaySettleSamples: the per-settle feed of the §9.2
// official-channel daily comparer. Red lines: exact `supply_offering:<id>`
// attribution match, [from, to) window edges, cost-side stamp parsed with
// BigInt (degraded null preserved), usage vector coerced defensively, and
// non-settle / foreign rows excluded.
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { listGatewaySettleSamples } from '../src/repositories/index.js';
import * as schema from '../src/schema/index.js';

const { account, tenant, ledgerTxn } = schema;

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 20 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
}, 120_000);

afterAll(async () => {
  await client.end();
  await container.stop();
});

afterEach(async () => {
  await client`TRUNCATE TABLE ledger_txn, account, tenant RESTART IDENTITY CASCADE`;
});

const OFFERING_A = '11111111-1111-1111-1111-111111111111';
const OFFERING_B = '22222222-2222-2222-2222-222222222222';

async function seed(): Promise<{ tenantId: string; accountId: string }> {
  const [t] = await db.insert(tenant).values({ name: 'acme' }).returning();
  if (!t) throw new Error('tenant insert returned no row');
  const [a] = await db
    .insert(account)
    .values({ tenantId: t.id, creditBalance: 1_000_000n, creditHeld: 0n })
    .returning();
  if (!a) throw new Error('account insert returned no row');
  return { tenantId: t.id, accountId: a.id };
}

interface SettleSeed {
  offeringId?: string;
  type?: string;
  usage?: Record<string, number> | null;
  costSide?: string | null;
  estimated?: boolean;
  createdAt?: Date;
  resourceId?: string;
}

async function seedSettle(
  ids: { tenantId: string; accountId: string },
  over: SettleSeed = {},
): Promise<void> {
  await db.insert(ledgerTxn).values({
    tenantId: ids.tenantId,
    accountId: ids.accountId,
    type: over.type ?? 'settle',
    creditsDelta: -100n,
    balanceAfter: 999_900n,
    jobId: null,
    resourceId: over.resourceId ?? `supply_offering:${over.offeringId ?? OFFERING_A}`,
    modifiersApplied: {
      applied: [],
      cost_side_credits: over.costSide === undefined ? '80' : over.costSide,
      estimated: over.estimated ?? false,
    },
    usageVector: over.usage === undefined ? { input_tokens: 10, output_tokens: 5 } : over.usage,
    ...(over.createdAt !== undefined ? { createdAt: over.createdAt } : {}),
  });
}

const DAY_START = new Date('2026-07-12T00:00:00.000Z');
const DAY_END = new Date('2026-07-13T00:00:00.000Z');
const IN_DAY = new Date('2026-07-12T09:00:00.000Z');

describe('listGatewaySettleSamples', () => {
  it('returns per-settle usage + cost stamps for the requested offerings, BigInt-parsed', async () => {
    const ids = await seed();
    await seedSettle(ids, { createdAt: IN_DAY, costSide: '123456789012345678' });
    await seedSettle(ids, { createdAt: IN_DAY, costSide: null, usage: null, estimated: true });

    const rows = await listGatewaySettleSamples(db, {
      from: DAY_START,
      to: DAY_END,
      offeringIds: [OFFERING_A],
    });

    expect(rows).toHaveLength(2);
    const priced = rows.find((r) => r.costSideCredits !== null);
    expect(priced?.offeringId).toBe(OFFERING_A);
    expect(priced?.usageVector).toEqual({ input_tokens: 10, output_tokens: 5 });
    // int64-overflowing µcredits survive (BigInt, never Number).
    expect(priced?.costSideCredits).toBe(123456789012345678n);
    expect(priced?.estimated).toBe(false);

    const degraded = rows.find((r) => r.costSideCredits === null);
    expect(degraded?.usageVector).toBeNull();
    expect(degraded?.estimated).toBe(true);
  });

  it('matches attribution EXACTLY per offering and ignores foreign/non-gateway rows', async () => {
    const ids = await seed();
    await seedSettle(ids, { createdAt: IN_DAY, offeringId: OFFERING_A });
    await seedSettle(ids, { createdAt: IN_DAY, offeringId: OFFERING_B });
    // Old-world settle attribution — never sampled:
    await seedSettle(ids, { createdAt: IN_DAY, resourceId: 'task:some-task-id' });

    const rows = await listGatewaySettleSamples(db, {
      from: DAY_START,
      to: DAY_END,
      offeringIds: [OFFERING_A],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.offeringId).toBe(OFFERING_A);
  });

  it('excludes non-settle rows and enforces the [from, to) window edges', async () => {
    const ids = await seed();
    await seedSettle(ids, { createdAt: DAY_START }); // inclusive start — in
    await seedSettle(ids, { createdAt: DAY_END }); // exclusive end — out
    await seedSettle(ids, { createdAt: new Date('2026-07-11T23:59:59.999Z') }); // before — out
    await seedSettle(ids, { createdAt: IN_DAY, type: 'topup' }); // wrong type — out

    const rows = await listGatewaySettleSamples(db, {
      from: DAY_START,
      to: DAY_END,
      offeringIds: [OFFERING_A],
    });

    expect(rows).toHaveLength(1);
  });

  it('answers [] for an empty offering set without touching the db', async () => {
    const rows = await listGatewaySettleSamples(db, {
      from: DAY_START,
      to: DAY_END,
      offeringIds: [],
    });
    expect(rows).toEqual([]);
  });
});
