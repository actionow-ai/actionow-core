/**
 * Demo seed — adds extra tenants/accounts/api-keys so the admin console has
 * realistic data to browse. Idempotent by tenant NAME (re-running skips tenants
 * that already exist). Network-free; defaults to the local dev pg on :5433.
 *
 * Run: pnpm --filter @actionow/api exec tsx src/seed/seed-demo.ts
 */
import {
  createAccount,
  createApiKey,
  createDb,
  createTenant,
  getAccountByTenant,
  listTenants,
  topUp,
} from '@actionow/db';
import { creditsToMicro } from '@actionow/domain';

/** Extra tenants with varied balances (incl. zero/low) for realistic admin views. */
const DEMO_TENANTS: readonly { name: string; credits: number }[] = [
  { name: 'Acme AI', credits: 5000 },
  { name: 'Globex Labs', credits: 1800 },
  { name: 'Initech', credits: 750 },
  { name: 'Umbrella Studio', credits: 12000 },
  { name: 'Hooli', credits: 300 },
  { name: 'Stark Industries', credits: 25000 },
  { name: 'Wayne Enterprises', credits: 0 },
  { name: 'Cyberdyne Systems', credits: 60 },
  { name: 'Soylent Co', credits: 4200 },
  { name: 'Tyrell Corp', credits: 999 },
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? 'postgres://actionow:actionow@localhost:5433/actionow';
  const db = createDb(url);

  const { rows } = await listTenants(db, { limit: 500 });
  const existing = new Set(rows.map((t) => t.name));

  let created = 0;
  let skipped = 0;
  for (const spec of DEMO_TENANTS) {
    if (existing.has(spec.name)) {
      skipped++;
      continue;
    }
    const tenant = await createTenant(db, { name: spec.name });
    const account =
      (await getAccountByTenant(db, tenant.id)) ??
      (await createAccount(db, { tenantId: tenant.id }));
    if (spec.credits > 0) {
      await topUp(db, account.id, tenant.id, creditsToMicro(spec.credits));
    }
    await createApiKey(db, { tenantId: tenant.id });
    created += 1;
    console.log(`  + ${spec.name}  (account ${account.id}, ${String(spec.credits)} credits)`);
  }

  console.log(
    `demo seed: created ${String(created)} tenant(s), skipped ${String(skipped)} already-present.`,
  );
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
