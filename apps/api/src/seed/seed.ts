import type { Database } from '@actionow/db';
import {
  createAccount,
  createApiKey,
  createDb,
  createRouteGroup,
  createSubject,
  createTenant,
  createUser,
  findUserByEmail,
  getAccountByTenant,
  getRouteGroupByName,
  listApiKeys,
  listSubjectsByTenant,
  listTenants,
  setApiKeyGroup,
  topUp,
} from '@actionow/db';
import { creditsToMicro } from '@actionow/domain';
import { hashPassword } from '@actionow/infra';

import { importCatalog } from './seed-catalog.js';
import { seedIcons } from './seed-icons.js';
import { OFFICIAL_PRICE_SEED_KEYS, seedOfficialPrices } from './seed-official-prices.js';

/**
 * Dev seed. 批次6 D3 (旧世界删除): the resource three-layer fixtures
 * (`openai-gpt` resource + pricebook + upstream channel + provider catalog
 * seeding via seed-providers) died with their tables. What the seed now
 * provisions is the identity/billing skeleton + the REFERENCE layer
 * (目录 + 方言包 — the official catalog data; dialect packs are code,
 * registered in the gateway dialect registry at boot):
 *
 *  - 1 tenant (`SEED_TENANT_NAME`)
 *  - 1 admin user (`admin@actionow.local`, dev password) — argon-equivalent
 *    scrypt hash via `hashPassword`; the plaintext is never persisted.
 *  - 1 account topped up to 100 credits (stored as 100_000_000 µcredits)
 *  - 1 API key (the plaintext is returned ONCE and printed to stdout)
 *  - the well-known `default` route group + key binding
 *  - the official model catalog (`model_spec` + `official_model_price`)
 *
 * SUPPLY WIRING is an operator action in the NEW world: providers/channels/
 * credentials/models/offerings are onboarded through `/admin/supply/*`
 * (discovery + batch offering + golden probe), never seeded as demo rows.
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
export const SEED_OPENING_CREDITS = 100;
/**
 * The well-known `default` route group (分组; Track 3). Always exists after a
 * seed, at ratio 10000 (1.0×); a key with no `route_group_id` falls back to it
 * at routing time. The seeded key is bound to it.
 */
export const SEED_DEFAULT_GROUP_NAME = 'default';

/** Options that let tests/local runs vary the seed's provisioning. */
export interface SeedOptions {
  /**
   * 批次6 D3: INERT. The old resource/channel fixtures this switched are
   * deleted; the option is kept so existing callers/tests keep compiling.
   */
  readonly providerType?: string;
  /**
   * Whether to provision the operator admin user. Default `true`. The CLI sets
   * this `false` in production unless an operator explicitly opts in — so running
   * the dev seed against a prod DB can NEVER create a published-credential admin.
   */
  readonly seedAdmin?: boolean;
  /**
   * Password for the seeded admin (hashed; plaintext never persisted). Defaults
   * to the well-known dev constant {@link SEED_ADMIN_PASSWORD}; the CLI overrides
   * it with an operator-supplied `SEED_ADMIN_PASSWORD` in production.
   */
  readonly adminPassword?: string;
  /**
   * Whether to provision the DEV-ONLY demo fixtures that are pure sample data:
   *   - the 100-credit opening top-up (a spendable phantom balance + a `topup`
   *     ledger row that never corresponds to a real payment), and
   *   - the two demo end-user subjects (`demo-user-1` / `demo-user-2`).
   * Default `true` (dev + tests need a spendable tenant). The CLI sets this
   * `false` in production (unless `SEED_ALLOW_PRODUCTION=true`) so a prod DB is
   * never seeded with phantom credits or mock end-users — keeping the
   * append-only ledger (the P0 moat) clean.
   */
  readonly seedDemoData?: boolean;
}

/** Everything a caller (a test, or the CLI) needs after seeding. */
export interface SeedResult {
  readonly tenantId: string;
  readonly accountId: string;
  readonly adminEmail: string;
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
  // Dev-only sample fixtures (phantom balance + mock subjects). ON by default
  // (dev/tests); the CLI turns it OFF for a prod DB.
  const seedDemoData = options.seedDemoData ?? true;

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
  const seedAdmin = options.seedAdmin ?? true;
  const adminPassword = options.adminPassword ?? SEED_ADMIN_PASSWORD;
  if (seedAdmin && (await findUserByEmail(db, SEED_ADMIN_EMAIL)) === undefined) {
    await createUser(db, {
      email: SEED_ADMIN_EMAIL,
      passwordHash: hashPassword(adminPassword),
      role: 'admin',
      emailVerified: true,
    });
  }

  // 3. account — created with a 0 opening balance. In dev/tests it is topped up
  //    to 100 credits via the ledger-writing `topUp` (so a `topup` row exists and
  //    the tenant can exercise `/v1/run`). In production (`seedDemoData=false`)
  //    the account stays at 0: a real operator tops up via the admin console, so
  //    the append-only ledger is never seeded with a phantom, payment-less credit.
  const existingAccount = await getAccountByTenant(db, tenantId);
  const accountId = existingAccount?.id ?? (await createAccount(db, { tenantId })).id;
  if (existingAccount === undefined && seedDemoData) {
    await topUp(db, accountId, tenantId, creditsToMicro(SEED_OPENING_CREDITS));
  }

  // 4. 批次6 D3: the demo resource + pricebook + upstream channel fixtures are
  //    GONE with the resource three-layer. Supply wiring is an operator action
  //    (/admin/supply/* onboarding), never seeded.

  // 5. API key — minted only when the tenant has none (plaintext is one-time).
  const { rows: existingKeys } = await listApiKeys(db, tenantId, { limit: 1 });
  let apiKey: string | null = null;
  if (existingKeys.length === 0) {
    const created = await createApiKey(db, { tenantId });
    apiKey = created.plaintext;
  }

  // 6a. Demo subjects (end-users; unified tenancy G-A) — DEV-ONLY sample identity
  //     rows so the operator end-user hub has seed data. Gated behind
  //     `seedDemoData` so a production DB is never seeded with mock end-users that
  //     would pollute the real subject roster + governance/attribution views.
  if (seedDemoData) {
    const { rows: existingSubjects } = await listSubjectsByTenant(db, tenantId, { limit: 1 });
    if (existingSubjects.length === 0) {
      await createSubject(db, {
        tenantId,
        externalId: 'demo-user-1',
        displayName: 'Demo User One',
      });
      await createSubject(db, {
        tenantId,
        externalId: 'demo-user-2',
        displayName: 'Demo User Two',
      });
    }
  }

  // 6. Track 3: the well-known `default` route group (ratio 10000) + the seeded
  //    key bound to it. 批次6 D3: the old chat-channel memberships died with
  //    `upstream_channel`; the group survives as the pricing/access tier entity.
  const defaultGroupId = await seedDefaultRouteGroup(db, tenantId);

  // 7. 接入与供给: import the OFFICIAL normalized model catalog (model_spec for
  //    every model + the firstparty cost basis into official_model_price).
  //    Idempotent + network-free. Wrapped so a missing JSON / import error only
  //    LOGS — it must NEVER fail the seed (e.g. the Docker migrate+seed step).
  try {
    const counts = await importCatalog(db);
    if (counts.modelSpecs > 0) {
      console.log(
        `  catalog   : ${String(counts.modelSpecs)} model_spec, ${String(counts.officialPrices)} official_price (trustworthy)`,
      );
    }
  } catch (err: unknown) {
    console.warn('[seed] importCatalog failed (non-fatal):', err);
  }

  return {
    tenantId,
    accountId,
    adminEmail: SEED_ADMIN_EMAIL,
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
 *    (`setApiKeyGroup` writes the same value on re-runs → idempotent).
 *
 * Returns the `default` group's id. Network-free; safe to re-run.
 */
async function seedDefaultRouteGroup(db: Database, tenantId: string): Promise<string> {
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

  // Production safety: NEVER provision the published default-credential admin
  // against a prod DB. Require an explicit opt-in (SEED_ALLOW_PRODUCTION=true)
  // AND an operator-supplied SEED_ADMIN_PASSWORD; otherwise skip the admin
  // entirely. Outside production an operator may still override the password.
  const isProd = process.env.NODE_ENV === 'production';
  const envAdminPassword = process.env.SEED_ADMIN_PASSWORD;
  const hasEnvPassword = envAdminPassword !== undefined && envAdminPassword !== '';
  const allowProd = process.env.SEED_ALLOW_PRODUCTION === 'true';
  let seedAdmin = true;
  let adminPassword = SEED_ADMIN_PASSWORD;
  if (isProd) {
    if (allowProd && hasEnvPassword) {
      adminPassword = envAdminPassword;
    } else {
      seedAdmin = false;
    }
  } else if (hasEnvPassword) {
    adminPassword = envAdminPassword;
  }

  // Dev-only sample data (phantom balance + mock subjects + active demo channel)
  // is provisioned outside production by default. In production it seeds ONLY when
  // the operator EXPLICITLY opts in via SEED_DEMO_DATA=true — a gate INDEPENDENT of
  // the admin one (SEED_ALLOW_PRODUCTION), so an operator can provision a real prod
  // admin WITHOUT also injecting phantom credits + mock end-users into the
  // append-only ledger (the P0 moat) and the subject roster.
  const seedDemoData = !isProd || process.env.SEED_DEMO_DATA === 'true';
  const result = await seedAll(db, { seedAdmin, adminPassword, seedDemoData });
  // Track 2: the official-price catalog (cost basis, 目录参考层). Idempotent.
  // 批次6 D3: seed-providers (the old resource/channel/pricebook demo catalog)
  // is deleted — supply wiring happens via /admin/supply/* onboarding.
  await seedOfficialPrices(db);
  await seedIcons(db);

  const log = console.log.bind(console);
  log('seed complete');
  log(`  tenant_id : ${result.tenantId}`);
  log(`  account_id: ${result.accountId}`);
  if (!seedAdmin) {
    log(
      '  admin     : (skipped in production — set SEED_ALLOW_PRODUCTION=true and SEED_ADMIN_PASSWORD to provision one)',
    );
  } else if (adminPassword === SEED_ADMIN_PASSWORD) {
    log(`  admin     : ${result.adminEmail} (password: ${SEED_ADMIN_PASSWORD})`);
  } else {
    // Operator-supplied password: never echo it to stdout.
    log(`  admin     : ${result.adminEmail} (password: <operator-supplied>)`);
  }
  log(`  prices(draft): ${OFFICIAL_PRICE_SEED_KEYS.join(', ')}`);
  log('  supply    : (none seeded — onboard providers/channels/offerings via /admin/supply/*)');
  log('  dialects  : (code, registered in the gateway dialect registry at boot)');

  if (result.apiKey === null) {
    log('  api_key   : (already provisioned; the plaintext is unrecoverable)');
  } else {
    log(`  api_key   : ${result.apiKey}`);
    log('');
    log('sample request (after supply onboarding):');
    log(
      [
        `  curl -sS -X POST 'http://localhost:3000/v1/chat/completions' \\`,
        `    -H 'authorization: Bearer ${result.apiKey}' \\`,
        `    -H 'content-type: application/json' \\`,
        `    -d '{"model":"<supply_model name>","messages":[{"role":"user","content":"hello"}]}'`,
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
