import type { Database } from '@actionow/db';
import {
  addChannelToGroup,
  createAccount,
  createApiKey,
  createDb,
  createPricebookEntry,
  createResource,
  createRouteGroup,
  createSecretRef,
  createTenant,
  createUpstreamChannel,
  createUser,
  findUserByEmail,
  getAccountByTenant,
  getResource,
  getRouteGroupByName,
  listApiKeys,
  listChannels,
  listTenants,
  setApiKeyGroup,
  topUp,
} from '@actionow/db';
import { creditsToMicro } from '@actionow/domain';
import { hashPassword } from '@actionow/infra';

import { OFFICIAL_PRICE_SEED_KEYS, seedOfficialPrices } from './seed-official-prices.js';
import { PROVIDER_SEED_IDS, seedProviders } from './seed-providers.js';

/**
 * Dev seed (Phase 5, Task 6). Creates the minimal end-to-end fixtures so a fresh
 * database can take a `POST /v1/run` with an API key:
 *
 *  - 1 tenant (`SEED_TENANT_NAME`)
 *  - 1 admin user (`admin@actionow.local`, dev password) — argon-equivalent
 *    scrypt hash via `hashPassword`; the plaintext is never persisted.
 *  - 1 account topped up to 100 credits (stored as 100_000_000 µcredits)
 *  - 1 API key (the plaintext is returned ONCE and printed to stdout)
 *  - 1 `openai`-style text resource + frozen io_schema (a `prompt` string input,
 *    a `text` output) + an active pricebook + one upstream channel.
 *
 * PRICING MODEL: a `unit`/`post` pricebook over the `tokens` usage dimension
 * (rate 1 µcredit/token). The hold is sized from the request's `estimated_usage`
 * (an upper bound) and the final settle uses the adapter's reported token usage
 * — so cost == tokens × 1 µcredit. (The alternative `fixed`/`pre` model is left
 * to the admin CRUD path; `unit`/`post` exercises the metered settle path.)
 *
 * Idempotent: every entity is created only when absent (find-then-create), so
 * re-running the seed against a populated db is a no-op. The one exception is the
 * API key — its plaintext is unrecoverable, so when keys already exist the seed
 * does NOT mint another and reports that instead.
 *
 * No secret other than the freshly-minted API key plaintext is ever printed.
 */

/** The well-known dev fixtures. */
export const SEED_TENANT_NAME = 'actionow-dev';
export const SEED_ADMIN_EMAIL = 'admin@actionow.local';
export const SEED_ADMIN_PASSWORD = 'actionow-dev-password';
export const SEED_RESOURCE_ID = 'openai-gpt';
export const SEED_OPENING_CREDITS = 100;
/**
 * The well-known `default` route group (分组; Track 3). Always exists after a
 * seed, at ratio 10000 (1.0×); a key with no `route_group_id` falls back to it
 * at routing time (Track 4). The seeded key is bound to it and the seeded chat
 * channels join it. NOTE: additive only — nothing routes/prices by it yet.
 */
export const SEED_DEFAULT_GROUP_NAME = 'default';
/** Provider type the seeded resource routes to (an openai-compatible adapter). */
export const SEED_PROVIDER_TYPE = 'openai';
/** The env secret ref the seeded upstream channel resolves its credential from. */
export const SEED_CREDENTIAL_REF = 'openai_api_key';

/** The io_schema frozen onto the seeded resource version. */
const SEED_IO_SCHEMA = {
  inputs: [{ key: 'prompt', type: 'string', required: true }],
  outputs: [{ key: 'text', type: 'string' }],
};

/** Options that let tests/local runs vary the seed's provider wiring. */
export interface SeedOptions {
  /**
   * The resource's `provider_type` + channel `provider_type`. Defaults to
   * `openai`; the acceptance e2e overrides it to a stubbed adapter so no network
   * is required.
   */
  readonly providerType?: string;
}

/** Everything a caller (a test, or the CLI) needs after seeding. */
export interface SeedResult {
  readonly tenantId: string;
  readonly accountId: string;
  readonly adminEmail: string;
  readonly resourceId: string;
  /** The well-known `default` route group's id (分组; Track 3). */
  readonly defaultGroupId: string;
  /**
   * The freshly-minted API key plaintext, or `null` when the tenant already had
   * keys (the plaintext is unrecoverable, so the seed does not mint another).
   */
  readonly apiKey: string | null;
}

/** Find the seed tenant by its well-known name, or `undefined`. */
async function findSeedTenant(db: Database): Promise<{ id: string } | undefined> {
  const { rows: tenants } = await listTenants(db, { limit: 200 });
  return tenants.find((t) => t.name === SEED_TENANT_NAME);
}

/**
 * Idempotently create all seed fixtures and return their ids + the (one-time)
 * API key plaintext. Safe to re-run; only-missing entities are created.
 */
export async function seedAll(db: Database, options: SeedOptions = {}): Promise<SeedResult> {
  const providerType = options.providerType ?? SEED_PROVIDER_TYPE;

  // 1. tenant
  const existingTenant = await findSeedTenant(db);
  const tenantId = existingTenant?.id ?? (await createTenant(db, { name: SEED_TENANT_NAME })).id;

  // 2. admin user (email is unique) — a unified `user` row with role=admin and
  //    a verified email (Phase 9). The admin guard gates on `role==='admin'`.
  //    Per §B.1 this single operator admin (`role='admin'`) is the self-deploy
  //    super-admin; a self-deployed instance seeds exactly ONE such admin. Every
  //    OTHER principal is a customer-side user (`role='user'`) provisioned via
  //    `/auth/register` — never through the seed. The find-then-create guard
  //    below (on the unique email) ensures re-running the seed never mints a
  //    second admin.
  if ((await findUserByEmail(db, SEED_ADMIN_EMAIL)) === undefined) {
    await createUser(db, {
      email: SEED_ADMIN_EMAIL,
      passwordHash: hashPassword(SEED_ADMIN_PASSWORD),
      role: 'admin',
      emailVerified: true,
    });
  }

  // 3. account — created with a 0 opening balance, then topped up to 100 credits
  //    via the ledger-writing `topUp` so a `topup` row exists.
  const existingAccount = await getAccountByTenant(db, tenantId);
  const accountId = existingAccount?.id ?? (await createAccount(db, { tenantId })).id;
  if (existingAccount === undefined) {
    await topUp(db, accountId, tenantId, creditsToMicro(SEED_OPENING_CREDITS));
  }

  // 4. resource (+ io_schema), pricebook, channel
  if ((await getResource(db, SEED_RESOURCE_ID)) === undefined) {
    await createResource(db, {
      id: SEED_RESOURCE_ID,
      tenantId,
      kind: 'model',
      modality: 'text',
      providerType,
      execModes: ['blocking'],
      ioSchema: SEED_IO_SCHEMA,
      version: 1,
    });
    await createPricebookEntry(db, {
      resourceId: SEED_RESOURCE_ID,
      resourceVersion: 1,
      version: 1,
      method: 'unit',
      timing: 'post',
      spec: { method: 'unit', dimensions: { tokens: { rate: 1 } } },
      active: true,
    });
    // The channel credential is an env secret ref: a `secret_ref` row locating
    // the env var that holds the provider key (the resolver materializes it at
    // run time; the secret itself is never stored).
    const secret = await createSecretRef(db, { provider: 'env', locator: SEED_CREDENTIAL_REF });
    await createUpstreamChannel(db, {
      resourceId: SEED_RESOURCE_ID,
      providerType,
      credentialRef: secret.id,
      weight: 1,
      status: 'active',
    });
  }

  // 5. API key — minted only when the tenant has none (plaintext is one-time).
  const { rows: existingKeys } = await listApiKeys(db, tenantId, { limit: 1 });
  let apiKey: string | null = null;
  if (existingKeys.length === 0) {
    const created = await createApiKey(db, { tenantId });
    apiKey = created.plaintext;
  }

  // 6. Track 3: the well-known `default` route group (ratio 10000), the seeded
  //    key bound to it, and the seeded chat channels joined to it (priority 0,
  //    weight 1). Additive only — nothing routes/prices by the group yet (Track
  //    4/5); the group merely exists so the wiring is in place + manageable.
  const defaultGroupId = await seedDefaultRouteGroup(db, tenantId);

  return {
    tenantId,
    accountId,
    adminEmail: SEED_ADMIN_EMAIL,
    resourceId: SEED_RESOURCE_ID,
    defaultGroupId,
    apiKey,
  };
}

/**
 * Idempotently establish the Track-3 `default` route group and its wiring:
 *
 *  - create the `default` group (ratio 10000) if absent (its partial-unique name
 *    means a re-run finds the existing live row instead of inserting a dup);
 *  - bind EVERY live key of the seed tenant that has no group to `default`
 *    (`setApiKeyGroup` writes the same value on re-runs → idempotent);
 *  - add the channels of the given chat resources to `default` with priority 0 /
 *    weight 1 (`addChannelToGroup` upserts on the `(group, channel)` PK → no
 *    dup). `listChannels` returns `[]` for an absent resource, so a resource that
 *    is not seeded yet (e.g. the runtime-provisioned codex channel) is simply
 *    skipped until it exists.
 *
 * Returns the `default` group's id. Network-free; safe to re-run.
 */
async function seedDefaultRouteGroup(
  db: Database,
  tenantId: string,
  chatResourceIds: readonly string[] = [SEED_RESOURCE_ID],
): Promise<string> {
  const existing = await getRouteGroupByName(db, SEED_DEFAULT_GROUP_NAME);
  const group =
    existing ??
    (await createRouteGroup(db, {
      name: SEED_DEFAULT_GROUP_NAME,
      groupRatioBps: 10000,
      description: 'Well-known default group (1.0×); the fallback group for unbound keys.',
    }));

  // Bind every unbound live key of the seed tenant to the default group.
  const { rows: keys } = await listApiKeys(db, tenantId, { limit: 200 });
  for (const key of keys) {
    if (key.routeGroupId === null) {
      await setApiKeyGroup(db, key.id, group.id);
    }
  }

  // Add the seeded chat channels to the default group (priority 0, weight 1).
  for (const resourceId of chatResourceIds) {
    const channels = await listChannels(db, resourceId);
    for (const channel of channels) {
      await addChannelToGroup(db, { groupId: group.id, channelId: channel.id });
    }
  }

  return group.id;
}

/**
 * CLI entrypoint: connect to `DATABASE_URL` (default the local dev pg on 5433),
 * run the seed, and print the API key + a sample `curl`. The printed plaintext
 * key is the ONLY secret written to stdout (and only on a fresh seed).
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? 'postgres://actionow:actionow@localhost:5433/actionow';
  const db = createDb(url);

  const result = await seedAll(db);
  // Register the real-provider catalog (resources + channels + pricebooks) as
  // DATA. Idempotent + network-free; the channels' credentials/proxies resolve
  // from env at run time.
  await seedProviders(db, { tenantId: result.tenantId });
  // Track 2: a small DRAFT official-price catalog (cost basis; verify before
  // billing). Idempotent + network-free.
  await seedOfficialPrices(db);

  const log = console.log.bind(console);
  log('seed complete');
  log(`  tenant_id : ${result.tenantId}`);
  log(`  account_id: ${result.accountId}`);
  log(`  admin     : ${result.adminEmail} (password: ${SEED_ADMIN_PASSWORD})`);
  log(`  resource  : ${result.resourceId}`);
  log(`  providers : ${PROVIDER_SEED_IDS.join(', ')}`);
  log(`  prices(draft): ${OFFICIAL_PRICE_SEED_KEYS.join(', ')}`);

  if (result.apiKey === null) {
    log('  api_key   : (already provisioned; the plaintext is unrecoverable)');
  } else {
    log(`  api_key   : ${result.apiKey}`);
    log('');
    log('sample request:');
    log(
      [
        `  curl -sS -X POST 'http://localhost:3000/v1/run/${result.resourceId}' \\`,
        `    -H 'authorization: Bearer ${result.apiKey}' \\`,
        `    -H 'content-type: application/json' \\`,
        `    -d '{"inputs":{"prompt":"hello"},"estimated_usage":{"tokens":1000}}'`,
      ].join('\n'),
    );
  }
}

// Run only when invoked directly (`tsx src/seed/seed.ts`), not when imported by
// the acceptance e2e (which calls `seedAll` against its testcontainer db).
const invokedPath = process.argv[1] ?? '';
if (import.meta.url === `file://${invokedPath}` || invokedPath.endsWith('seed.ts')) {
  main()
    .then(() => {
      // The postgres pool keeps the event loop alive; exit explicitly so the
      // CLI returns promptly after seeding.
      process.exit(0);
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
