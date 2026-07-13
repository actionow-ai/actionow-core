// packages/engine/test/planner/planner.int.test.ts
//
// model-supply-greenfield 批次3 slice 4 — REAL-DB integration tests for the
// planner's composition entry (planExecution) over a testcontainers postgres:
// real slice-1 repos seed the five supply entities + price cards, a REAL
// tenant account takes the §7.8 hold, and only the concurrency/rate-limit
// primitives are injected fakes (no Redis; the container has NO network
// egress beyond postgres itself). The pure-logic corners are already locked
// by the slice 2/3a/3b unit suites — these tests exercise the SEAM: real SQL
// gates (visibility/BYOK/tag pin) × real breaker persistence × real ledger
// writes, all through the ONE entry 批次4 will mount.
import type {
  CanonicalParam,
  CanonicalParamValue,
  GatewayRequest,
  ModelOperation,
  Operation,
} from '@actionow/contracts';
import type { Database, SupplyModelRow } from '@actionow/db';
import {
  createDb,
  createSupplyChannel,
  createSupplyCredential,
  createSupplyModel,
  createSupplyOffering,
  createSupplyPriceCard,
  createSupplyProvider,
  getSupplyOfferingBreakers,
  grantSupplyModel,
  schema,
  updateSupplyOffering,
} from '@actionow/db';
import type { ConcurrencyLimiter, RateLimiter, RateLimitResult } from '@actionow/infra';
import { FakeBreakerRedis, FakeConcurrencyLimiter } from '@actionow/infra';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { type BreakerConfig, DEFAULT_BREAKER_CONFIG } from '../../src/breaker.js';
import {
  type PlanDeps,
  planExecution,
  type PlanExecutionInput,
  recordOfferingOutcome,
} from '../../src/index.js';

/** The vault master key credentials are encrypted with (real AES-GCM vault rows). */
const KEY = Buffer.alloc(32, 7).toString('base64');

/** The fixed plan instant every test judges against (breaker cooldowns offset from it). */
const NOW = new Date('2026-07-12T12:00:00.000Z');

let container: StartedPostgreSqlContainer;
let db: Database;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  db = createDb(container.getConnectionUri());
  await migrate(db, { migrationsFolder: '../db/drizzle' });
}, 120_000);

afterAll(async () => {
  await container.stop();
});

afterEach(async () => {
  await db.execute(
    sql`TRUNCATE TABLE supply_offering_breaker, supply_model_grant, supply_offering, supply_credential, supply_model, supply_channel, supply_provider, supply_price_card, secret_material, secret_ref, account, tenant RESTART IDENTITY CASCADE`,
  );
});

// --- seed helpers (real slice-1 repos everywhere) ----------------------------

async function mkTenantAccount(
  name: string,
  balance: bigint,
): Promise<{ tenantId: string; accountId: string }> {
  const [t] = await db.insert(schema.tenant).values({ name }).returning();
  if (!t) throw new Error('tenant insert returned no row');
  const [a] = await db
    .insert(schema.account)
    .values({ tenantId: t.id, creditBalance: balance, creditHeld: 0n })
    .returning();
  if (!a) throw new Error('account insert returned no row');
  return { tenantId: t.id, accountId: a.id };
}

async function readHeld(accountId: string): Promise<bigint> {
  const [a] = await db.select().from(schema.account).where(eq(schema.account.id, accountId));
  if (!a) throw new Error('account not found');
  return a.creditHeld;
}

function chatOp(params: CanonicalParam[] = []): ModelOperation {
  return { operation: 'chat.completions', paradigms: ['sync', 'stream'], slow: false, params };
}

function videoOp(params: CanonicalParam[] = []): ModelOperation {
  return { operation: 'video.generation', paradigms: ['task'], slow: false, params };
}

/** A fixed-amount sale card: always pre-quotable → hold = amount µcredits. */
async function mkSaleCard(amount = 5_000): Promise<string> {
  const card = await createSupplyPriceCard(db, {
    name: `sale-${String(amount)}`,
    method: 'fixed',
    unit: 'request',
    spec: { method: 'fixed', amount },
  });
  return card.id;
}

interface ChainSeed {
  providerId: string;
  channelId: string;
  credentialId: string;
  modelId: string;
  model: SupplyModelRow;
  offeringId: string;
  saleCardId: string;
  costCardId: string;
}

/** provider → channel → credential (vaulted) → sale/cost cards → model → enabled offering. */
async function mkChain(o: {
  slug: string;
  modelName: string;
  operations?: ModelOperation[];
  modelStatus?: string;
  visibility?: string;
  channelTenantId?: string | null;
  channelTags?: string[];
  fetchMode?: 'direct' | 'stream' | 'submit_poll' | 'submit_callback';
  paramDeclarations?: Parameters<typeof createSupplyOffering>[1]['paramDeclarations'];
  tier?: number;
  maxConcurrency?: number | null;
}): Promise<ChainSeed> {
  const provider = await createSupplyProvider(db, {
    slug: o.slug,
    name: `Brand ${o.slug}`,
    defaultDialect: { ref: 'openai.chat', version: 'v1' },
  });
  const channel = await createSupplyChannel(db, {
    providerId: provider.id,
    name: `${o.slug}-ch`,
    authScheme: 'bearer',
    ...(o.channelTenantId !== undefined ? { tenantId: o.channelTenantId } : {}),
    ...(o.channelTags !== undefined ? { tags: o.channelTags } : {}),
  });
  const credential = await createSupplyCredential(db, {
    channelId: channel.id,
    name: `${o.slug}-key`,
    secret: { scheme: 'bearer', api_key: `sk-${o.slug}-abcd` },
    keyB64: KEY,
    quota: { rpm: null, tpm: null, max_concurrency: o.maxConcurrency ?? 4 },
  });
  const saleCardId = await mkSaleCard();
  const cost = await createSupplyPriceCard(db, {
    name: `cost-${o.slug}`,
    method: 'fixed',
    unit: 'request',
    spec: { method: 'fixed', amount: 1_000 },
  });
  const model = await createSupplyModel(db, {
    name: o.modelName,
    displayName: `Model ${o.modelName}`,
    modality: 'text',
    operations: o.operations ?? [chatOp(), videoOp()],
    status: o.modelStatus ?? 'active',
    visibility: o.visibility ?? 'public',
    priceCardId: saleCardId,
  });
  const offering = await createSupplyOffering(db, {
    modelId: model.id,
    channelId: channel.id,
    status: 'enabled',
    upstreamModelName: `up-${o.modelName}`,
    fetchProfile: { mode: o.fetchMode ?? 'stream' },
    ...(o.paramDeclarations !== undefined ? { paramDeclarations: o.paramDeclarations } : {}),
    costPriceCardId: cost.id,
    ...(o.tier !== undefined ? { tier: o.tier } : {}),
  });
  return {
    providerId: provider.id,
    channelId: channel.id,
    credentialId: credential.id,
    modelId: model.id,
    model,
    offeringId: offering.id,
    saleCardId,
    costCardId: cost.id,
  };
}

/** Attach ANOTHER enabled offering (own channel + key) to an existing model. */
async function mkOfferingOnNewChannel(o: {
  slug: string;
  modelId: string;
  channelTenantId?: string | null;
  channelTags?: string[];
  fetchMode?: 'direct' | 'stream' | 'submit_poll' | 'submit_callback';
  paramDeclarations?: Parameters<typeof createSupplyOffering>[1]['paramDeclarations'];
  tier?: number;
}): Promise<{ channelId: string; credentialId: string; offeringId: string }> {
  const provider = await createSupplyProvider(db, {
    slug: o.slug,
    name: `Brand ${o.slug}`,
    defaultDialect: { ref: 'openai.chat', version: 'v1' },
  });
  const channel = await createSupplyChannel(db, {
    providerId: provider.id,
    name: `${o.slug}-ch`,
    authScheme: 'bearer',
    ...(o.channelTenantId !== undefined ? { tenantId: o.channelTenantId } : {}),
    ...(o.channelTags !== undefined ? { tags: o.channelTags } : {}),
  });
  const credential = await createSupplyCredential(db, {
    channelId: channel.id,
    name: `${o.slug}-key`,
    secret: { scheme: 'bearer', api_key: `sk-${o.slug}-efgh` },
    keyB64: KEY,
    quota: { rpm: null, tpm: null, max_concurrency: 4 },
  });
  const offering = await createSupplyOffering(db, {
    modelId: o.modelId,
    channelId: channel.id,
    status: 'enabled',
    upstreamModelName: `up-${o.slug}`,
    fetchProfile: { mode: o.fetchMode ?? 'stream' },
    ...(o.paramDeclarations !== undefined ? { paramDeclarations: o.paramDeclarations } : {}),
    ...(o.tier !== undefined ? { tier: o.tier } : {}),
  });
  return { channelId: channel.id, credentialId: credential.id, offeringId: offering.id };
}

// --- fake primitives (the ONLY fakes — everything else is the real db) -------

interface Harness {
  deps: PlanDeps;
  /** Every RateLimiter.take key, in order (asserting which buckets were consulted). */
  rateKeys: string[];
  /** Every ConcurrencyLimiter.acquire key, in order (asserting zero-acquire paths). */
  semKeys: string[];
}

function harness(
  o: {
    now?: Date;
    rejectRateKeys?: Set<string>;
    breakerConfig?: BreakerConfig;
  } = {},
): Harness {
  const rateKeys: string[] = [];
  const semKeys: string[] = [];
  const limiter: RateLimiter = {
    take(key: string): Promise<RateLimitResult> {
      rateKeys.push(key);
      if (o.rejectRateKeys?.has(key) === true) {
        return Promise.resolve({ allowed: false, retryAfterMs: 1_234 });
      }
      return Promise.resolve({ allowed: true, retryAfterMs: 0 });
    },
  };
  const inner = new FakeConcurrencyLimiter();
  const concurrency: ConcurrencyLimiter = {
    acquire: (key, max) => {
      semKeys.push(key);
      return inner.acquire(key, max);
    },
  };
  // Deterministic time: the injected sleep ADVANCES the fake ms clock, so a
  // saturated pool times out instantly instead of really waiting.
  let t = 0;
  const deps: PlanDeps = {
    db,
    now: () => o.now ?? NOW,
    rng: () => 0,
    limiter,
    concurrency,
    nowMs: () => t,
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
    ...(o.breakerConfig !== undefined ? { breakerConfig: o.breakerConfig } : {}),
  };
  return { deps, rateKeys, semKeys };
}

function req(o: {
  tenantId: string;
  model: string;
  operation?: Operation;
  params?: Record<string, CanonicalParamValue>;
  stream?: boolean;
  routeTag?: string;
}): GatewayRequest {
  return {
    tenantId: o.tenantId,
    apiKeyId: 'key-int-1',
    operation: o.operation ?? 'chat.completions',
    model: o.model,
    params: o.params ?? {},
    mediaRefs: [],
    options: {
      ...(o.stream !== undefined ? { stream: o.stream } : {}),
      ...(o.routeTag !== undefined ? { routeTag: o.routeTag } : {}),
    },
  };
}

function planInput(
  request: GatewayRequest,
  accountId: string,
  extra: Partial<PlanExecutionInput> = {},
): PlanExecutionInput {
  return { request, accountId, maxWaitMs: 100, maxQueueMs: 400, ...extra };
}

// --- 1. 全链正路 --------------------------------------------------------------

describe('planExecution 全链正路 (real chain, real hold)', () => {
  it('plans a chat request end-to-end: reservation on the seeded offering, REAL hold, release rolls it back', async () => {
    const { tenantId, accountId } = await mkTenantAccount('happy', 1_000_000n);
    const seed = await mkChain({ slug: 'happy', modelName: 'happy-model' });
    const h = harness();

    const res = await planExecution(
      h.deps,
      planInput(req({ tenantId, model: 'happy-model' }), accountId),
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // served by THE seeded offering/credential
    expect(res.reservation.candidate.offering.id).toBe(seed.offeringId);
    expect(res.reservation.credential.id).toBe(seed.credentialId);
    expect(res.reservation.candidate.offering.upstreamModelName).toBe('up-happy-model');
    // §3: sync-declared chat without a stream ask → sync; stream-fetch offering → pre-commit marker
    expect(res.paradigmPlan).toMatchObject({ externalParadigm: 'sync', autoUpgraded: false });
    expect(res.fetchPlan).toMatchObject({ mode: 'stream', preCommit: true, recoverable: false });
    // §9.2 snapshot refs: sale card v1 + the offering's cost card
    expect(res.reservation.saleCardRef).toEqual({ cardId: seed.saleCardId, version: 1 });
    expect(res.reservation.costCardRef).toEqual({ cardId: seed.costCardId, version: 1 });
    // active model → no deprecation marker
    expect(res.deprecation).toBeUndefined();

    // the hold is REAL: credit_held increased by the fixed-card amount
    expect(res.reservation.holdAmount).toBe(5_000n);
    await expect(readHeld(accountId)).resolves.toBe(5_000n);

    // §7.8 failure path: release() rolls the hold back (and is idempotent)
    await res.reservation.release();
    await expect(readHeld(accountId)).resolves.toBe(0n);
    await res.reservation.release();
    await expect(readHeld(accountId)).resolves.toBe(0n);
  });

  it('§10 shelf semantics: deprecated still serves WITH the deprecation marker; disabled/unknown → model_not_found; undeclared operation → invalid_input', async () => {
    const { tenantId, accountId } = await mkTenantAccount('shelf', 1_000_000n);
    await mkChain({ slug: 'shelf-dep', modelName: 'shelf-dep', modelStatus: 'deprecated' });
    await mkChain({ slug: 'shelf-dis', modelName: 'shelf-dis', modelStatus: 'disabled' });
    // deprecated: served + marked (批次4 attaches the 预告 header from this)
    const dep = await planExecution(
      harness().deps,
      planInput(req({ tenantId, model: 'shelf-dep' }), accountId),
    );
    expect(dep.ok).toBe(true);
    expect(dep.deprecation).toEqual({ model: 'shelf-dep', status: 'deprecated' });
    if (dep.ok) await dep.reservation.release();

    // disabled: hard 404 — indistinguishable from missing
    const dis = await planExecution(
      harness().deps,
      planInput(req({ tenantId, model: 'shelf-dis' }), accountId),
    );
    expect(dis.ok).toBe(false);
    if (!dis.ok) expect(dis.error.code).toBe('model_not_found');

    const missing = await planExecution(
      harness().deps,
      planInput(req({ tenantId, model: 'no-such-model' }), accountId),
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('model_not_found');

    // operation not on the model's operation surface → invalid_input
    const badOp = await planExecution(
      harness().deps,
      planInput(req({ tenantId, model: 'shelf-dep', operation: 'embeddings' }), accountId),
    );
    expect(badOp.ok).toBe(false);
    if (!badOp.ok) expect(badOp.error.code).toBe('invalid_input');
    // zero ledger residue across all the refusals
    await expect(readHeld(accountId)).resolves.toBe(0n);
  });
});

// --- 2. 毛利倒挂过滤 (§4 rule 2 — 判据 2.3 核心) --------------------------------

describe('planExecution billing_relevant margin-inversion filter (§4 rule 2)', () => {
  const RESOLUTION: CanonicalParam = {
    name: 'resolution',
    type: 'enum',
    billingRelevant: true,
    required: false,
    default: '720p',
    values: ['720p', '1080p'],
  };

  it('a fixed-1080p offering is filtered on the RESOLVED default 720p; the 720p-domain sibling serves — even at lower tier', async () => {
    const { tenantId, accountId } = await mkTenantAccount('margin', 1_000_000n);
    // offering A: pins resolution to 1080p, HIGHER tier (would win if not filtered)
    const seed = await mkChain({
      slug: 'margin-a',
      modelName: 'margin-model',
      operations: [chatOp([RESOLUTION])],
      paramDeclarations: [
        { param: 'resolution', origin: 'upstream', rule: { kind: 'fixed', value: '1080p' } },
      ],
      tier: 10,
    });
    // offering B: domain contains 720p, lower tier
    const b = await mkOfferingOnNewChannel({
      slug: 'margin-b',
      modelId: seed.modelId,
      paramDeclarations: [
        { param: 'resolution', origin: 'upstream', rule: { kind: 'domain', values: ['720p'] } },
      ],
      tier: 0,
    });

    // caller omits resolution entirely → rule 2 judges the canonical default 720p
    const res = await planExecution(
      harness().deps,
      planInput(req({ tenantId, model: 'margin-model' }), accountId),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.reservation.candidate.offering.id).toBe(b.offeringId);
    // A fell at the params stage, named in the trace
    expect(res.trace.rejected).toContainEqual(
      expect.objectContaining({
        offeringId: seed.offeringId,
        stage: 'params',
        param: 'resolution',
      }),
    );
    // billingDims carry the CANONICAL effective value (the sale tier key)
    expect(res.billingDims).toEqual({ resolution: '720p' });
    expect(res.effective.canonical).toEqual({ resolution: '720p' });
    await res.reservation.release();

    // only A remains → §4 rule 4 total annihilation with per-param details
    await updateSupplyOffering(db, b.offeringId, { status: 'disabled' });
    const dead = await planExecution(
      harness().deps,
      planInput(req({ tenantId, model: 'margin-model' }), accountId),
    );
    expect(dead.ok).toBe(false);
    if (dead.ok) return;
    expect(dead.error.code).toBe('unsupported_parameter');
    expect(dead.error.details).toMatchObject({ excludedBy: { resolution: [seed.offeringId] } });
    // filtering rejections never touch the ledger
    await expect(readHeld(accountId)).resolves.toBe(0n);
  });

  it('an EXPLICIT 1080p ask flips the verdict: the fixed-1080p offering serves, the 720p-domain one is filtered', async () => {
    const { tenantId, accountId } = await mkTenantAccount('margin2', 1_000_000n);
    const seed = await mkChain({
      slug: 'margin2-a',
      modelName: 'margin2-model',
      operations: [chatOp([RESOLUTION])],
      paramDeclarations: [
        { param: 'resolution', origin: 'upstream', rule: { kind: 'fixed', value: '1080p' } },
      ],
      tier: 0,
    });
    await mkOfferingOnNewChannel({
      slug: 'margin2-b',
      modelId: seed.modelId,
      paramDeclarations: [
        { param: 'resolution', origin: 'upstream', rule: { kind: 'domain', values: ['720p'] } },
      ],
      tier: 10, // higher tier — must STILL lose on the explicit 1080p ask
    });

    const res = await planExecution(
      harness().deps,
      planInput(
        req({
          tenantId,
          model: 'margin2-model',
          params: { resolution: { value: '1080p', isDefault: false } },
        }),
        accountId,
      ),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.reservation.candidate.offering.id).toBe(seed.offeringId);
    expect(res.billingDims).toEqual({ resolution: '1080p' });
    await res.reservation.release();
  });
});

// --- 3. 可见性 / BYOK ----------------------------------------------------------

describe('planExecution visibility & BYOK gates (§2.1/§2.3, real SQL predicates)', () => {
  it('granted model without a grant → model_not_found; with a grant → serves', async () => {
    const { tenantId, accountId } = await mkTenantAccount('vis-a', 1_000_000n);
    const seed = await mkChain({
      slug: 'vis',
      modelName: 'vis-granted',
      visibility: 'granted',
    });

    const denied = await planExecution(
      harness().deps,
      planInput(req({ tenantId, model: 'vis-granted' }), accountId),
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('model_not_found');

    await grantSupplyModel(db, seed.modelId, tenantId);
    const granted = await planExecution(
      harness().deps,
      planInput(req({ tenantId, model: 'vis-granted' }), accountId),
    );
    expect(granted.ok).toBe(true);
    if (granted.ok) {
      expect(granted.reservation.candidate.offering.id).toBe(seed.offeringId);
      await granted.reservation.release();
    }
  });

  it('BYOK: a tenant-private channel offering routes ONLY for its owner; strangers get no supply and zero hold', async () => {
    const owner = await mkTenantAccount('byok-owner', 1_000_000n);
    const stranger = await mkTenantAccount('byok-stranger', 1_000_000n);
    const seed = await mkChain({
      slug: 'byok',
      modelName: 'byok-model',
      channelTenantId: owner.tenantId, // the ONLY offering lives on the owner's private channel
    });

    const forOwner = await planExecution(
      harness().deps,
      planInput(req({ tenantId: owner.tenantId, model: 'byok-model' }), owner.accountId),
    );
    expect(forOwner.ok).toBe(true);
    if (forOwner.ok) {
      expect(forOwner.reservation.candidate.offering.id).toBe(seed.offeringId);
      await forOwner.reservation.release();
    }

    // the model is PUBLIC (visible to the stranger) but its only supply is private
    const forStranger = await planExecution(
      harness().deps,
      planInput(req({ tenantId: stranger.tenantId, model: 'byok-model' }), stranger.accountId),
    );
    expect(forStranger.ok).toBe(false);
    if (!forStranger.ok) expect(forStranger.error.code).toBe('upstream_error');
    await expect(readHeld(stranger.accountId)).resolves.toBe(0n);

    // add a platform offering → the stranger now routes to THAT one only
    const plat = await mkOfferingOnNewChannel({
      slug: 'byok-plat',
      modelId: seed.modelId,
      tier: 0,
    });
    const again = await planExecution(
      harness().deps,
      planInput(req({ tenantId: stranger.tenantId, model: 'byok-model' }), stranger.accountId),
    );
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.reservation.candidate.offering.id).toBe(plat.offeringId);
      await again.reservation.release();
    }
  });
});

// --- 4. task/sync 钉选对齐 (判据 2.9 方向) --------------------------------------

describe('planExecution route-tag pinning: task path IDENTICAL to sync (§8 产品裁决)', () => {
  it('the same tag pins chat AND video.generation to the tagged channel; zero-match tag 400s BOTH', async () => {
    const { tenantId, accountId } = await mkTenantAccount('pin', 1_000_000n);
    // tagged channel, LOW tier (only the pin can select it)
    const seed = await mkChain({
      slug: 'pin-tagged',
      modelName: 'pin-model',
      operations: [chatOp(), videoOp()],
      channelTags: ['turbo'],
      fetchMode: 'submit_poll',
      tier: 0,
    });
    // untagged channel, HIGH tier (wins whenever no tag narrows). fetch=direct
    // so BOTH paradigms can be served over it (§3 servability: task×stream is
    // not inline-servable and would be filtered for video.generation).
    const untagged = await mkOfferingOnNewChannel({
      slug: 'pin-plain',
      modelId: seed.modelId,
      fetchMode: 'direct',
      tier: 10,
    });

    for (const operation of ['chat.completions', 'video.generation'] as const) {
      // no tag → tier wins (untagged offering)
      const free = await planExecution(
        harness().deps,
        planInput(req({ tenantId, model: 'pin-model', operation }), accountId),
      );
      expect(free.ok).toBe(true);
      if (free.ok) {
        expect(free.reservation.candidate.offering.id).toBe(untagged.offeringId);
        await free.reservation.release();
      }

      // tag → pinned to the tagged channel, SAME semantics for sync and task
      const pinned = await planExecution(
        harness().deps,
        planInput(req({ tenantId, model: 'pin-model', operation, routeTag: 'turbo' }), accountId),
      );
      expect(pinned.ok).toBe(true);
      if (pinned.ok) {
        expect(pinned.reservation.candidate.offering.id).toBe(seed.offeringId);
        expect(pinned.paradigmPlan.externalParadigm).toBe(
          operation === 'video.generation' ? 'task' : 'sync',
        );
        await pinned.reservation.release();
      }

      // zero-match tag → 400 invalid_input for BOTH operations (task 不旁路)
      const zero = await planExecution(
        harness().deps,
        planInput(
          req({ tenantId, model: 'pin-model', operation, routeTag: 'no-such-tag' }),
          accountId,
        ),
      );
      expect(zero.ok).toBe(false);
      if (!zero.ok) {
        expect(zero.error.code).toBe('invalid_input');
        expect(zero.error.details).toMatchObject({ routeTag: 'no-such-tag' });
      }
    }
    await expect(readHeld(accountId)).resolves.toBe(0n);
  });
});

// --- 5. fetch / 自动升格 (§3) ---------------------------------------------------

describe('planExecution paradigm/fetch decoupling (§3 / §1 原则2)', () => {
  it('slow images op auto-upgrades to task; submit_poll offering is recoverable; a direct sibling is at-most-once — paradigm unchanged', async () => {
    const { tenantId, accountId } = await mkTenantAccount('fetch', 1_000_000n);
    const slowImages: ModelOperation = {
      operation: 'images.generation',
      paradigms: ['sync'],
      slow: true,
      params: [],
    };
    const seed = await mkChain({
      slug: 'fetch-poll',
      modelName: 'fetch-model',
      operations: [slowImages],
      fetchMode: 'submit_poll',
      channelTags: ['poll'],
      tier: 0,
    });
    const direct = await mkOfferingOnNewChannel({
      slug: 'fetch-direct',
      modelId: seed.modelId,
      fetchMode: 'direct',
      channelTags: ['direct'],
      tier: 0,
    });

    const viaPoll = await planExecution(
      harness().deps,
      planInput(
        req({ tenantId, model: 'fetch-model', operation: 'images.generation', routeTag: 'poll' }),
        accountId,
      ),
    );
    expect(viaPoll.ok).toBe(true);
    if (viaPoll.ok) {
      // 纯服务端升格: sync-declared slow op answers 202+Task
      expect(viaPoll.paradigmPlan).toMatchObject({ externalParadigm: 'task', autoUpgraded: true });
      expect(viaPoll.fetchPlan).toMatchObject({
        mode: 'submit_poll',
        recoverable: true,
        atMostOnce: false,
      });
      await viaPoll.reservation.release();
    }

    const viaDirect = await planExecution(
      harness().deps,
      planInput(
        req({ tenantId, model: 'fetch-model', operation: 'images.generation', routeTag: 'direct' }),
        accountId,
      ),
    );
    expect(viaDirect.ok).toBe(true);
    if (viaDirect.ok) {
      // SAME external shape (paradigm is the model's), DIFFERENT fetch strategy (the offering's)
      expect(viaDirect.paradigmPlan).toMatchObject({
        externalParadigm: 'task',
        autoUpgraded: true,
      });
      expect(viaDirect.fetchPlan).toMatchObject({
        mode: 'direct',
        recoverable: false,
        atMostOnce: true,
      });
      expect(viaDirect.reservation.candidate.offering.id).toBe(direct.offeringId);
      await viaDirect.reservation.release();
    }
    // recoverable-fetch preference (§3 排序加权): same tier, no tag → submit_poll wins
    const preferred = await planExecution(
      harness().deps,
      planInput(req({ tenantId, model: 'fetch-model', operation: 'images.generation' }), accountId),
    );
    expect(preferred.ok).toBe(true);
    if (preferred.ok) {
      expect(preferred.reservation.candidate.offering.id).toBe(seed.offeringId);
      await preferred.reservation.release();
    }
  });
});

// --- 5b. §3 servability filter (FOUND-1) ----------------------------------------

describe('planExecution §3 servability filter (stream requests never land on submit supply)', () => {
  it('stream ask over MIXED supply picks the stream offering (the submit sibling would win the §3 recoverable weighting otherwise); submit-only supply answers ONE deterministic no-supply with ZERO hold; plain sync still serves the submit offering', async () => {
    const { tenantId, accountId } = await mkTenantAccount('serv', 1_000_000n);
    // submit_poll offering at the SAME tier: pre-filter, §3 recoverable
    // weighting ranks it FIRST — a stream request would select it, hit the
    // dispatch mismatch and spin hold-write/rollback failover hops.
    const seed = await mkChain({
      slug: 'serv-poll',
      modelName: 'serv-model',
      operations: [chatOp()],
      fetchMode: 'submit_poll',
      tier: 0,
    });
    const streaming = await mkOfferingOnNewChannel({
      slug: 'serv-stream',
      modelId: seed.modelId,
      fetchMode: 'stream',
      tier: 0,
    });

    const res = await planExecution(
      harness().deps,
      planInput(req({ tenantId, model: 'serv-model', stream: true }), accountId),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.paradigmPlan.externalParadigm).toBe('stream');
      expect(res.reservation.candidate.offering.id).toBe(streaming.offeringId);
      expect(res.fetchPlan.mode).toBe('stream');
      // the submit offering never entered the candidate set
      expect(res.trace.rejected).toContainEqual(
        expect.objectContaining({ offeringId: seed.offeringId, stage: 'servability' }),
      );
      await res.reservation.release();
    }

    // submit-only supply for a stream ask: ONE deterministic no-supply answer
    // (no hold ever written — nothing to roll back, no failover hops to burn)
    await updateSupplyOffering(db, streaming.offeringId, { status: 'disabled' });
    const dead = await planExecution(
      harness().deps,
      planInput(req({ tenantId, model: 'serv-model', stream: true }), accountId),
    );
    expect(dead.ok).toBe(false);
    if (!dead.ok) {
      expect(dead.error.code).toBe('upstream_error');
      expect(dead.error.failover).toBe(false);
      expect(dead.trace.rejected).toContainEqual(
        expect.objectContaining({ offeringId: seed.offeringId, stage: 'servability' }),
      );
    }
    await expect(readHeld(accountId)).resolves.toBe(0n);

    // the SAME model still serves a plain sync ask over the submit offering
    // (§3 block-poll) — the filter never starves the common path
    const syncRes = await planExecution(
      harness().deps,
      planInput(req({ tenantId, model: 'serv-model' }), accountId),
    );
    expect(syncRes.ok).toBe(true);
    if (syncRes.ok) {
      expect(syncRes.paradigmPlan.externalParadigm).toBe('sync');
      expect(syncRes.reservation.candidate.offering.id).toBe(seed.offeringId);
      await syncRes.reservation.release();
    }
  });
});

// --- 6. 熔断真持久化 (§2.5 / §2.4) ----------------------------------------------

describe('planExecution breaker persistence (real supply_offering_breaker rows)', () => {
  /** Small-volume config so five 5xx samples trip the breaker. */
  const CFG: BreakerConfig = { ...DEFAULT_BREAKER_CONFIG, minVolume: 5 };

  it('5xx outcomes trip a REAL open row → offering filtered while cooling → half-open probe admitted after cooldown; 429 never feeds the breaker', async () => {
    const { tenantId, accountId } = await mkTenantAccount('brk', 1_000_000n);
    const seed = await mkChain({ slug: 'brk', modelName: 'brk-model' });
    const redis = new FakeBreakerRedis();

    // §2.4 attribution: a 429 outcome writes NO breaker state at all
    await recordOfferingOutcome(
      { db, redis },
      {
        offeringId: seed.offeringId,
        outcome: 'failure',
        errorClass: 'rate_limited',
        cfg: CFG,
        now: NOW,
      },
    );
    await expect(getSupplyOfferingBreakers(db, [seed.offeringId])).resolves.toEqual(new Map());

    // five 5xx samples (100% failure ≥ 50%, volume 5 ≥ minVolume) → trips OPEN, persisted
    for (let i = 0; i < 5; i += 1) {
      await recordOfferingOutcome(
        { db, redis },
        { offeringId: seed.offeringId, outcome: 'failure', errorClass: '5xx', cfg: CFG, now: NOW },
      );
    }
    const rows = await getSupplyOfferingBreakers(db, [seed.offeringId]);
    expect(rows.get(seed.offeringId)).toMatchObject({
      state: 'open',
      consecutiveOpens: 1,
      openedAt: NOW,
    });

    // still cooling (open cooldown 5s) → the ONLY offering is breaker-filtered → no supply
    const cooling = await planExecution(
      harness({ now: new Date(NOW.getTime() + 1_000), breakerConfig: CFG }).deps,
      planInput(req({ tenantId, model: 'brk-model' }), accountId),
    );
    expect(cooling.ok).toBe(false);
    if (!cooling.ok) {
      expect(cooling.error.code).toBe('upstream_error');
      expect(cooling.trace.rejected).toContainEqual(
        expect.objectContaining({ offeringId: seed.offeringId, stage: 'breaker' }),
      );
    }
    await expect(readHeld(accountId)).resolves.toBe(0n);

    // cooldown elapsed → the open offering is admitted as the half-open probe
    const probing = await planExecution(
      harness({ now: new Date(NOW.getTime() + 6_000), breakerConfig: CFG }).deps,
      planInput(req({ tenantId, model: 'brk-model' }), accountId),
    );
    expect(probing.ok).toBe(true);
    if (probing.ok) {
      expect(probing.reservation.candidate.offering.id).toBe(seed.offeringId);
      await probing.reservation.release();
    }

    // probe success → half_open persisted (lifecycle ADVANCES, never locks open)
    await recordOfferingOutcome(
      { db, redis },
      {
        offeringId: seed.offeringId,
        outcome: 'success',
        cfg: CFG,
        now: new Date(NOW.getTime() + 6_000),
      },
    );
    const afterProbe = await getSupplyOfferingBreakers(db, [seed.offeringId]);
    expect(afterProbe.get(seed.offeringId)?.state).toBe('half_open');
  });
});

// --- 7. 闸门顺序真库佐证 (§7.8) --------------------------------------------------

describe('planExecution gate order against the REAL ledger (§7.8 red lines)', () => {
  it('insufficient balance → insufficient_credits with ZERO hold leakage', async () => {
    const { tenantId, accountId } = await mkTenantAccount('poor', 100n); // hold needs 5000
    await mkChain({ slug: 'poor', modelName: 'poor-model' });

    const res = await planExecution(
      harness().deps,
      planInput(req({ tenantId, model: 'poor-model' }), accountId),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('insufficient_credits');
      expect(res.trace.attempts).toContainEqual(expect.objectContaining({ stage: 'hold' }));
    }
    // the failed hold left the account untouched (atomic conditional UPDATE)
    await expect(readHeld(accountId)).resolves.toBe(0n);
  });

  it('rate-limit rejection fires BEFORE any semaphore/ledger step: zero acquires, zero hold', async () => {
    const { tenantId, accountId } = await mkTenantAccount('limited', 1_000_000n);
    await mkChain({ slug: 'limited', modelName: 'limited-model' });

    const h = harness({ rejectRateKeys: new Set([`rl:tenant:${tenantId}`]) });
    const res = await planExecution(
      h.deps,
      planInput(req({ tenantId, model: 'limited-model' }), accountId),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('rate_limited');
      expect(res.error.retryAfterMs).toBe(1_234);
    }
    // §7.8: steps 1–3 touch neither the semaphore nor the ledger
    expect(h.semKeys).toEqual([]);
    await expect(readHeld(accountId)).resolves.toBe(0n);
  });
});
