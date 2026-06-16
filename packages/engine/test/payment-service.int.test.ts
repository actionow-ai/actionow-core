import type { IntentResult, PaymentProviderKind, VerifiedEvent } from '@actionow/contracts';
import { getAccount, getAccountByTenant, getIntentByProviderRef, schema } from '@actionow/db';
import type { PaymentProvider, PaymentRegistry } from '@actionow/payments';
import { SignatureVerificationError } from '@actionow/payments';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { PaymentService } from '../src/payment-service.js';

const { account, ledgerTxn, paymentEvent, tenant } = schema;

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
  await client`TRUNCATE TABLE payment_event, payment_intent, ledger_txn, account, tenant RESTART IDENTITY CASCADE`;
});

const CREDIT_RATE = 1000n; // µcredits per currency-minor-unit

const PROVIDER_REF = 'sess_test_123';
const EVENT_ID = 'evt_test_abc';

/**
 * A fake `PaymentProvider`: `createIntent` returns a canned providerRef/redirect;
 * `verifyWebhook` returns a canned succeeded `VerifiedEvent` — or throws a
 * {@link SignatureVerificationError} when `signatureValid` is false, exactly as a
 * real provider does on a forged body.
 */
function fakeProvider(opts: { signatureValid?: boolean } = {}): PaymentProvider {
  const signatureValid = opts.signatureValid ?? true;
  const intent: IntentResult = {
    providerRef: PROVIDER_REF,
    redirectUrl: 'https://checkout.example/sess_test_123',
  };
  const verified: VerifiedEvent = {
    eventId: EVENT_ID,
    type: 'checkout.session.completed',
    providerRef: PROVIDER_REF,
    status: 'succeeded',
  };
  return {
    kind: 'stripe',
    createIntent(): Promise<IntentResult> {
      return Promise.resolve(intent);
    },
    verifyWebhook(): Promise<VerifiedEvent> {
      if (!signatureValid) return Promise.reject(new SignatureVerificationError());
      return Promise.resolve(verified);
    },
  };
}

/** A registry exposing exactly one fake stripe provider. */
function fakeRegistry(provider: PaymentProvider): PaymentRegistry {
  return {
    get(kind: PaymentProviderKind): PaymentProvider {
      if (kind !== 'stripe') throw new Error(`unexpected provider ${kind}`);
      return provider;
    },
    has(kind: PaymentProviderKind): boolean {
      return kind === 'stripe';
    },
    configuredKinds(): PaymentProviderKind[] {
      return ['stripe'];
    },
  };
}

async function seedTenantAccount(opening = 0n): Promise<{ tenantId: string; accountId: string }> {
  const [t] = await db.insert(tenant).values({ name: 'acme' }).returning();
  if (!t) throw new Error('tenant insert returned no row');
  const [a] = await db
    .insert(account)
    .values({ tenantId: t.id, creditBalance: opening })
    .returning();
  if (!a) throw new Error('account insert returned no row');
  return { tenantId: t.id, accountId: a.id };
}

function buildService(provider: PaymentProvider): PaymentService {
  return new PaymentService({ db, providers: fakeRegistry(provider), creditRate: CREDIT_RATE });
}

describe('PaymentService', () => {
  it('creates a topup intent with the frozen credit_amount and a redirect url', async () => {
    const { tenantId } = await seedTenantAccount();
    const svc = buildService(fakeProvider());

    const result = await svc.createIntent({
      tenantId,
      provider: 'stripe',
      purpose: 'topup',
      amountMinor: 1000n,
      currency: 'usd',
    });

    expect(result.redirectUrl).toBe('https://checkout.example/sess_test_123');

    const intent = await getIntentByProviderRef(db, 'stripe', PROVIDER_REF);
    expect(intent?.id).toBe(result.intentId);
    expect(intent?.status).toBe('created');
    expect(intent?.amountMinor).toBe(1000n);
    // 1000 minor units × 1000 µcredits = 1_000_000 µcredits.
    expect(intent?.creditAmount).toBe(1_000_000n);
  });

  it('credits the account exactly once on a succeeded topup webhook', async () => {
    const { tenantId, accountId } = await seedTenantAccount(0n);
    const svc = buildService(fakeProvider());

    await svc.createIntent({
      tenantId,
      provider: 'stripe',
      purpose: 'topup',
      amountMinor: 1000n,
      currency: 'usd',
    });

    const out = await svc.handleWebhook('stripe', Buffer.from('{}'), {});
    expect(out).toEqual({ fulfilled: true });

    // Balance up by credit_amount (1000 × 1000 = 1_000_000).
    const acct = await getAccount(db, accountId);
    expect(acct?.creditBalance).toBe(1_000_000n);

    // Exactly one `topup` ledger row.
    const ledger = await db.select().from(ledgerTxn).where(eq(ledgerTxn.accountId, accountId));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.type).toBe('topup');
    expect(ledger[0]?.creditsDelta).toBe(1_000_000n);

    // Intent transitioned to succeeded; the event row is marked processed.
    const intent = await getIntentByProviderRef(db, 'stripe', PROVIDER_REF);
    expect(intent?.status).toBe('succeeded');
    const events = await db
      .select()
      .from(paymentEvent)
      .where(eq(paymentEvent.providerEventId, EVENT_ID));
    expect(events).toHaveLength(1);
    expect(events[0]?.processedAt).not.toBeNull();
  });

  it('no-ops a duplicate webhook delivery (same event id) — balance unchanged', async () => {
    const { tenantId, accountId } = await seedTenantAccount(0n);
    const svc = buildService(fakeProvider());

    await svc.createIntent({
      tenantId,
      provider: 'stripe',
      purpose: 'topup',
      amountMinor: 1000n,
      currency: 'usd',
    });

    const first = await svc.handleWebhook('stripe', Buffer.from('{}'), {});
    expect(first).toEqual({ fulfilled: true });

    const second = await svc.handleWebhook('stripe', Buffer.from('{}'), {});
    expect(second).toEqual({ duplicate: true });

    // Still credited exactly once.
    const acct = await getAccount(db, accountId);
    expect(acct?.creditBalance).toBe(1_000_000n);

    const ledger = await db.select().from(ledgerTxn).where(eq(ledgerTxn.accountId, accountId));
    expect(ledger).toHaveLength(1);

    // Only one event row recorded across both deliveries.
    const events = await db.select().from(paymentEvent);
    expect(events).toHaveLength(1);
  });

  it('propagates a bad signature — no event row, no credit', async () => {
    const { tenantId, accountId } = await seedTenantAccount(0n);
    const svc = buildService(fakeProvider({ signatureValid: false }));

    await svc.createIntent({
      tenantId,
      provider: 'stripe',
      purpose: 'topup',
      amountMinor: 1000n,
      currency: 'usd',
    });

    await expect(svc.handleWebhook('stripe', Buffer.from('forged'), {})).rejects.toBeInstanceOf(
      SignatureVerificationError,
    );

    // No event recorded, no credit applied, intent still `created`.
    const events = await db.select().from(paymentEvent);
    expect(events).toHaveLength(0);

    const acct = await getAccount(db, accountId);
    expect(acct?.creditBalance).toBe(0n);

    const ledger = await db.select().from(ledgerTxn).where(eq(ledgerTxn.accountId, accountId));
    expect(ledger).toHaveLength(0);

    const intent = await getIntentByProviderRef(db, 'stripe', PROVIDER_REF);
    expect(intent?.status).toBe('created');
  });

  it('records but does not fulfill an order intent (no credit), marking it succeeded', async () => {
    const { tenantId, accountId } = await seedTenantAccount(0n);
    const svc = buildService(fakeProvider());

    await svc.createIntent({
      tenantId,
      provider: 'stripe',
      purpose: 'order',
      amountMinor: 500n,
      currency: 'usd',
      targetRef: 'order-1',
    });

    const out = await svc.handleWebhook('stripe', Buffer.from('{}'), {});
    expect(out).toEqual({ fulfilled: true });

    // Order: intent succeeded, event processed, but NO ledger credit.
    const intent = await getIntentByProviderRef(db, 'stripe', PROVIDER_REF);
    expect(intent?.status).toBe('succeeded');
    expect(intent?.creditAmount).toBeNull();

    const acct = await getAccount(db, accountId);
    expect(acct?.creditBalance).toBe(0n);
    const ledger = await db.select().from(ledgerTxn).where(eq(ledgerTxn.accountId, accountId));
    expect(ledger).toHaveLength(0);
  });

  it('resolves the topup credit to the tenant account (getAccountByTenant sanity)', async () => {
    const { tenantId, accountId } = await seedTenantAccount(0n);
    const resolved = await getAccountByTenant(db, tenantId);
    expect(resolved?.id).toBe(accountId);
  });
});
