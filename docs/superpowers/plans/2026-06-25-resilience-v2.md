# 弹性 2.0 (Resilience v2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the binary channel cooldown with a stateful circuit breaker (Closed→Open→HalfOpen) keyed per `(channel, model)`, and add cross-group failover via `route_group.fallback_group_id`.

**Architecture:** A `BreakerStore` (interface in `packages/engine`, Redis window+trial impl in `packages/infra`, PG state in `packages/db`) is injected into the engine's routing deps. Routing excludes Open `(channel,model)` and trial-gates HalfOpen; each upstream outcome drives the FSM; transitions persist to a new `channel_breaker` table + emit an `audit_log`. `candidatesFor` expands a `fallback_group_id` chain into lower-priority tiers, reusing the existing `routeWithFailover` machinery.

**Tech Stack:** NestJS (apps/api), drizzle/postgres (packages/db), Redis/ioredis Lua (packages/infra), zod contracts (packages/contracts), Vite/React (apps/web), vitest; db + infra int tests use `@testcontainers/postgresql` / a real Redis.

**Spec:** `docs/superpowers/specs/2026-06-25-resilience-v2-design.md`. Branch: `feat/resilience-v2` (spec already committed there).

**Conventions (follow exactly):**

- commitlint: lowercase imperative subject after `type(scope):`. Commit body ends with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Do NOT push / open PRs (phase 6 is the controller's).
- DB schema edit → `pnpm --filter @actionow/db db:generate` then hand-edit the generated `packages/db/drizzle/00NN_*.sql` if a drop/backfill is needed → `pnpm --filter @actionow/db db:migrate`. Schema barrel: add `export * from './X.js'` to `packages/db/src/schema/index.ts`; repo barrel: `packages/db/src/repositories/index.ts`.
- Contracts change → `pnpm --filter @actionow/contracts build && pnpm --filter @actionow/contracts gen:openapi && pnpm --filter @actionow/sdk gen && pnpm --filter @actionow/sdk build && pnpm --filter @actionow/contracts test`.
- Admin/console routes not in the SDK path set are consumed in web via `rawClient` (see `apps/web/src/lib/api/admin.ts`).
- GROUND TRUTH OVER PLAN: if a referenced helper/import/path differs from the real code, adapt and note it. The breaker only optimizes — it must NEVER fail a request that could have succeeded (fail-open on any store error).

---

## Phase 1 — Data model (migration 0047 + repos + contracts)

### Task 1: schema — `channel_breaker`, `fault_policy` breaker columns, `route_group.fallback_group_id`, drop `channel_health`

**Files:**

- Create: `packages/db/src/schema/channel-breaker.ts`
- Modify: `packages/db/src/schema/fault-policy.ts`, `packages/db/src/schema/route-group.ts`, `packages/db/src/schema/catalog.ts` (remove `channelHealth`), `packages/db/src/schema/index.ts`
- Generate/edit: `packages/db/drizzle/0047_*.sql` (+ meta)
- Test: `packages/db/test/schema-constraints.test.ts`

- [ ] **Step 1: Create the `channel_breaker` schema.** `packages/db/src/schema/channel-breaker.ts`:

```ts
import { sql } from 'drizzle-orm';
import { check, integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { upstreamChannel } from './catalog.js';

/**
 * Per-(channel, model) circuit-breaker state (弹性2.0). The runtime FSM:
 * closed (normal) → open (tripped, excluded from routing) → half_open (trial).
 * `model` is the resolved model name, or `'*'` for model-less resources.
 */
export const channelBreaker = pgTable(
  'channel_breaker',
  {
    channelId: uuid('channel_id')
      .notNull()
      .references(() => upstreamChannel.id),
    model: text('model').notNull(),
    state: text('state').notNull().default('closed'),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    cooldownUntil: timestamp('cooldown_until', { withTimezone: true }),
    tripCount: integer('trip_count').notNull().default(0),
    halfOpenSuccesses: integer('half_open_successes').notNull().default(0),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
    lastTransitionAt: timestamp('last_transition_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.model] }),
    check('channel_breaker_state_allowed', sql`${t.state} IN ('closed','open','half_open')`),
  ],
);
```

- [ ] **Step 2: Add breaker columns to `fault_policy`.** In `packages/db/src/schema/fault-policy.ts`, inside the `faultPolicy` columns (after the timeout/retry columns), add:

```ts
breakerEnabled: boolean('breaker_enabled').notNull().default(true),
breakerWindowMs: integer('breaker_window_ms'),
breakerMinVolume: integer('breaker_min_volume'),
breakerFailureRatePct: integer('breaker_failure_rate_pct'),
breakerHalfOpenTrial: integer('breaker_half_open_trial'),
breakerHalfOpenSuccesses: integer('breaker_half_open_successes'),
breakerOpenCooldownMs: integer('breaker_open_cooldown_ms'),
breakerOpenCooldownCapMs: integer('breaker_open_cooldown_cap_ms'),
```

(Ensure `boolean`/`integer` are imported from `drizzle-orm/pg-core` in that file.)

- [ ] **Step 3: Add `route_group.fallback_group_id` (self-ref FK).** In `packages/db/src/schema/route-group.ts`, add `AnyPgColumn` to the `drizzle-orm/pg-core` import, and add to the `routeGroup` columns:

```ts
/** Cross-group failover (弹性2.0): when this group's channels are exhausted, cascade to this group. Self-ref; resolver walks the chain with cycle+depth guards. */
fallbackGroupId: uuid('fallback_group_id').references((): AnyPgColumn => routeGroup.id),
```

- [ ] **Step 4: Remove `channel_health`.** In `packages/db/src/schema/catalog.ts` delete the `channelHealth` pgTable export (lines ~136–146). Search the repo for remaining references (`grep -rn channelHealth packages/db/src`) — they'll be fixed in Task 2.

- [ ] **Step 5: Barrel.** In `packages/db/src/schema/index.ts` add `export * from './channel-breaker.js';`.

- [ ] **Step 6: Generate the migration.** Run: `pnpm --filter @actionow/db db:generate`. Expected: `packages/db/drizzle/0047_*.sql` creating `channel_breaker`, altering `fault_policy` (+8 columns), adding `route_group.fallback_group_id`, and DROPPING `channel_health`. Verify the `DROP TABLE` for `channel_health` is present (drizzle drops removed tables).

- [ ] **Step 7: Add the failing constraint test** in `packages/db/test/schema-constraints.test.ts` (a `describe('channel_breaker (弹性2.0)')` block; reuse the file's `db` harness):

```ts
it('rejects an invalid breaker state', async () => {
  const ch = await makeChannel(); // reuse the file's channel helper, or insert a minimal upstream_channel
  await expect(
    db.insert(schema.channelBreaker).values({ channelId: ch, model: 'gpt-x', state: 'bogus' }),
  ).rejects.toThrow();
});
it('accepts the three valid states + composite PK', async () => {
  const ch = await makeChannel();
  for (const state of ['closed', 'open', 'half_open']) {
    await db.insert(schema.channelBreaker).values({ channelId: ch, model: `m-${state}`, state });
  }
  const rows = await db
    .select()
    .from(schema.channelBreaker)
    .where(eq(schema.channelBreaker.channelId, ch));
  expect(rows).toHaveLength(3);
});
```

(If the test file has no channel helper, insert a minimal `upstream_channel` row inline — check an existing catalog test for the required NOT NULL columns.)

- [ ] **Step 8: Run + migrate.** `pnpm --filter @actionow/db exec vitest run test/schema-constraints.test.ts` (expect FAIL: table missing) → `pnpm --filter @actionow/db db:migrate` → re-run (expect PASS). Also `pnpm --filter @actionow/db build`.

- [ ] **Step 9: Commit.**

```bash
git add packages/db/src/schema/ packages/db/drizzle/ packages/db/test/schema-constraints.test.ts
git commit -m "feat(db): channel_breaker + fault_policy breaker cols + route_group.fallback_group_id; drop channel_health (resilience v2)"
```

### Task 2: breaker PG repo + repoint `channel_health` consumers

**Files:**

- Create: `packages/db/src/repositories/channel-breaker.ts`
- Modify: `packages/db/src/repositories/catalog.ts` (remove `recordChannelFailure`/`listCooledDownChannelIds`; repoint `listAllChannelsWithHealth`), `packages/db/src/repositories/index.ts`
- Modify callers: `packages/engine/src/channel-routing.ts` import (temporarily — fully wired in Phase 3), any test referencing the removed funcs
- Test: `packages/db/test/channel-breaker.int.test.ts`

- [ ] **Step 1: Failing repo test** (`packages/db/test/channel-breaker.int.test.ts`): insert a breaker row, `getBreakerRows(db, channelIds, model)` returns it; `upsertBreaker(db, {channelId, model, ...})` inserts then updates (composite PK); `resetBreaker(db, channelId, model)` deletes/clears it.

- [ ] **Step 2: Run, expect FAIL** (`pnpm --filter @actionow/db exec vitest run test/channel-breaker.int.test.ts`).

- [ ] **Step 3: Implement `channel-breaker.ts` repo:**

```ts
import { and, eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../client.js';
import { channelBreaker } from '../schema/channel-breaker.js';

export interface BreakerRow {
  readonly channelId: string;
  readonly model: string;
  readonly state: 'closed' | 'open' | 'half_open';
  readonly openedAt: Date | null;
  readonly cooldownUntil: Date | null;
  readonly tripCount: number;
  readonly halfOpenSuccesses: number;
}

const COLS = {
  channelId: channelBreaker.channelId,
  model: channelBreaker.model,
  state: channelBreaker.state,
  openedAt: channelBreaker.openedAt,
  cooldownUntil: channelBreaker.cooldownUntil,
  tripCount: channelBreaker.tripCount,
  halfOpenSuccesses: channelBreaker.halfOpenSuccesses,
};

/** Breaker rows for a set of channels at one model (closed = no row). */
export async function getBreakerRows(
  db: DbOrTx,
  channelIds: string[],
  model: string,
): Promise<BreakerRow[]> {
  if (channelIds.length === 0) return [];
  return db
    .select(COLS)
    .from(channelBreaker)
    .where(
      and(inArray(channelBreaker.channelId, channelIds), eq(channelBreaker.model, model)),
    ) as Promise<BreakerRow[]>;
}

/** Upsert the FSM state for one (channel, model). */
export async function upsertBreaker(
  db: DbOrTx,
  row: {
    channelId: string;
    model: string;
    state: 'closed' | 'open' | 'half_open';
    openedAt?: Date | null;
    cooldownUntil?: Date | null;
    tripCount: number;
    halfOpenSuccesses: number;
    now: Date;
  },
): Promise<void> {
  const values = {
    channelId: row.channelId,
    model: row.model,
    state: row.state,
    openedAt: row.openedAt ?? null,
    cooldownUntil: row.cooldownUntil ?? null,
    tripCount: row.tripCount,
    halfOpenSuccesses: row.halfOpenSuccesses,
    lastTransitionAt: row.now,
    updatedAt: row.now,
  };
  await db
    .insert(channelBreaker)
    .values(values)
    .onConflictDoUpdate({ target: [channelBreaker.channelId, channelBreaker.model], set: values });
}

/** Clear a breaker back to closed (ops un-stick). */
export async function resetBreaker(db: DbOrTx, channelId: string, model: string): Promise<void> {
  await db
    .delete(channelBreaker)
    .where(and(eq(channelBreaker.channelId, channelId), eq(channelBreaker.model, model)));
}

/** All breaker rows joined for the admin status surface. */
export async function listBreakers(db: DbOrTx): Promise<BreakerRow[]> {
  return db.select(COLS).from(channelBreaker) as Promise<BreakerRow[]>;
}
```

(Confirm `DbOrTx` import path matches sibling repos, e.g. `../client.js`.)

- [ ] **Step 4: Remove the dead `channel_health` repo funcs + repoint the ops view.** In `packages/db/src/repositories/catalog.ts` delete `recordChannelFailure` and `listCooledDownChannelIds`. For `listAllChannelsWithHealth` (the ops view), change it to LEFT JOIN `channel_breaker` and return a per-channel rollup (e.g. `degraded: boolean` = any row state != 'closed', plus `breakerState` worst-of). Keep its return shape additive where consumers (admin.service) read it; update the admin view mapping in Task 12 if columns change. If simplest, have it return `{ ...channelRow, degraded: boolean }`.

- [ ] **Step 5: Export** `getBreakerRows`, `upsertBreaker`, `resetBreaker`, `listBreakers`, `BreakerRow` from `packages/db/src/repositories/index.ts`; remove the `recordChannelFailure`/`listCooledDownChannelIds` exports.

- [ ] **Step 6: Fix the temporary engine import.** `packages/engine/src/channel-routing.ts` imports `listCooledDownChannelIds, recordChannelFailure` (now gone) — to keep the build green until Phase 3, temporarily make `availableChannels` return `[...channels]` and `routeBlocking` skip the cooldown write (remove the two imports). Add a `// TODO(resilience-v2 Phase 3): breaker wiring` note. (Phase 3 replaces this fully.)

- [ ] **Step 7: Run tests + build.** `pnpm --filter @actionow/db exec vitest run test/channel-breaker.int.test.ts` (PASS), `pnpm --filter @actionow/db build`, `pnpm --filter @actionow/engine build`, and fix any test that referenced the removed funcs (`grep -rn "recordChannelFailure\|listCooledDownChannelIds\|channelHealth" packages apps`).

- [ ] **Step 8: Commit.**

```bash
git add packages/db/src/repositories/ packages/engine/src/channel-routing.ts
git commit -m "feat(db): channel_breaker repo + drop channel_health cooldown funcs (resilience v2)"
```

### Task 3: contracts — fault_policy breaker fields + route_group fallback

**Files:**

- Modify: the fault-policy contract module (`grep -rn "faultPolicyView\|faultPolicy" packages/contracts/src` to locate, likely `packages/contracts/src/fault-policy.ts`), the route-group contract module
- Modify: `apps/api/src/admin/admin.controller.ts` + `admin.service.ts` (map the new fields through create/update — see Task 10/11; here just the contract + view mapping so the build stays green)
- Test: the contracts test files for those modules

- [ ] **Step 1: Extend the fault-policy view + request schemas.** Add the 8 breaker fields: in the view, `breaker_enabled: z.boolean()`, the rest `z.number().nullable()`; in create/update requests, `breakerEnabled: z.boolean().optional()`, the rest `z.number().int().nonnegative().optional()` (`breakerFailureRatePct` `.min(0).max(100)`). Update the view fixture in the contracts test.

- [ ] **Step 2: Extend the route-group view + request.** Add `fallback_group_id: z.string().nullable()` to the view and `fallbackGroupId: z.string().uuid().nullable().optional()` to create/update. Update fixtures.

- [ ] **Step 3: Map fields in the admin view builders.** Wherever `toFaultPolicyView`/`toRouteGroupView` live (admin.service or controller), map the new columns (snake_case wire ← camel DB). Pass the new request fields into the repo create/update calls (the repo update funcs may need the new columns added — add them following the existing column list in the fault-policy/route-group repos).

- [ ] **Step 4: Build chain + tests.** `pnpm --filter @actionow/contracts build && pnpm --filter @actionow/contracts gen:openapi && pnpm --filter @actionow/sdk gen && pnpm --filter @actionow/sdk build && pnpm --filter @actionow/contracts test && pnpm --filter @actionow/api typecheck`.

- [ ] **Step 5: Commit.**

```bash
git add packages/contracts/ packages/sdk/src/generated/openapi.ts apps/api/src/admin/ packages/db/src/repositories/
git commit -m "feat(contracts): fault_policy breaker fields + route_group fallback_group_id (resilience v2)"
```

---

## Phase 2 — BreakerStore (FSM + Redis + PG)

### Task 4: FSM core (pure functions) + global defaults

**Files:**

- Create: `packages/engine/src/breaker.ts` (types, defaults, pure FSM)
- Test: `packages/engine/test/breaker.test.ts`

- [ ] **Step 1: Failing FSM test** (`packages/engine/test/breaker.test.ts`) — test the pure transition functions:

```ts
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BREAKER_CONFIG,
  cooldownMs,
  onFailureTransition,
  onSuccessTransition,
  openEligibleAt,
} from '../src/breaker.js';

const cfg = DEFAULT_BREAKER_CONFIG;
const t0 = new Date('2026-06-25T00:00:00Z');
const closed = {
  state: 'closed' as const,
  openedAt: null,
  cooldownUntil: null,
  tripCount: 0,
  halfOpenSuccesses: 0,
};

it('cooldown backs off exponentially with a cap', () => {
  expect(cooldownMs(cfg, 0)).toBe(5000);
  expect(cooldownMs(cfg, 1)).toBe(10000);
  expect(cooldownMs(cfg, 6)).toBe(300000); // capped
});
it('trips closed→open only at/above min_volume AND failure_rate', () => {
  expect(onFailureTransition(closed, cfg, { total: 10, fail: 9 }, t0)).toBeNull(); // below min_volume
  const next = onFailureTransition(closed, cfg, { total: 20, fail: 10 }, t0); // 50% >= 50%
  expect(next?.state).toBe('open');
  expect(next?.tripCount).toBe(1);
  expect(next?.cooldownUntil?.getTime()).toBe(t0.getTime() + 5000);
});
it('half_open: a success short of threshold stays half_open; reaching it closes', () => {
  const ho = {
    state: 'half_open' as const,
    openedAt: t0,
    cooldownUntil: t0,
    tripCount: 2,
    halfOpenSuccesses: 0,
  };
  const s1 = onSuccessTransition(ho, cfg, t0);
  expect(s1?.state).toBe('half_open');
  expect(s1?.halfOpenSuccesses).toBe(1);
  const s2 = onSuccessTransition({ ...ho, halfOpenSuccesses: 1 }, cfg, t0);
  expect(s2?.state).toBe('closed');
  expect(s2?.tripCount).toBe(0);
});
it('half_open: any failure reopens with doubled cooldown', () => {
  const ho = {
    state: 'half_open' as const,
    openedAt: t0,
    cooldownUntil: t0,
    tripCount: 1,
    halfOpenSuccesses: 1,
  };
  const next = onFailureTransition(ho, cfg, { total: 1, fail: 1 }, t0);
  expect(next?.state).toBe('open');
  expect(next?.tripCount).toBe(2);
  expect(next?.cooldownUntil?.getTime()).toBe(t0.getTime() + cooldownMs(cfg, 1));
});
it('openEligibleAt: an open row past cooldown is half_open-eligible', () => {
  const open = {
    state: 'open' as const,
    openedAt: t0,
    cooldownUntil: new Date(t0.getTime() + 5000),
    tripCount: 1,
    halfOpenSuccesses: 0,
  };
  expect(openEligibleAt(open, new Date(t0.getTime() + 4000))).toBe(false);
  expect(openEligibleAt(open, new Date(t0.getTime() + 6000))).toBe(true);
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement `packages/engine/src/breaker.ts`:**

```ts
export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerConfig {
  enabled: boolean;
  windowMs: number;
  minVolume: number;
  failureRatePct: number;
  halfOpenTrial: number;
  halfOpenSuccesses: number;
  openCooldownMs: number;
  openCooldownCapMs: number;
}

export const DEFAULT_BREAKER_CONFIG: BreakerConfig = {
  enabled: true,
  windowMs: 60_000,
  minVolume: 20,
  failureRatePct: 50,
  halfOpenTrial: 3,
  halfOpenSuccesses: 2,
  openCooldownMs: 5_000,
  openCooldownCapMs: 300_000,
};

export interface BreakerSnapshot {
  state: BreakerState;
  openedAt: Date | null;
  cooldownUntil: Date | null;
  tripCount: number;
  halfOpenSuccesses: number;
}

export interface WindowStats {
  total: number;
  fail: number;
}

/** Exponential backoff for the n-th trip, capped. */
export function cooldownMs(cfg: BreakerConfig, tripCount: number): number {
  return Math.min(cfg.openCooldownMs * 2 ** Math.max(0, tripCount), cfg.openCooldownCapMs);
}

function open(cfg: BreakerConfig, prevTrip: number, now: Date): BreakerSnapshot {
  const tripCount = prevTrip + 1;
  return {
    state: 'open',
    openedAt: now,
    cooldownUntil: new Date(now.getTime() + cooldownMs(cfg, tripCount - 1)),
    tripCount,
    halfOpenSuccesses: 0,
  };
}

/** Next state after a FAILURE, or null if no transition. */
export function onFailureTransition(
  cur: BreakerSnapshot,
  cfg: BreakerConfig,
  win: WindowStats,
  now: Date,
): BreakerSnapshot | null {
  if (!cfg.enabled) return null;
  if (cur.state === 'half_open') return open(cfg, cur.tripCount, now);
  if (cur.state === 'open') return null; // already open
  // closed: trip iff volume + failure-rate thresholds met
  const ratePct = win.total > 0 ? (win.fail / win.total) * 100 : 0;
  if (win.total >= cfg.minVolume && ratePct >= cfg.failureRatePct)
    return open(cfg, cur.tripCount, now);
  return null;
}

/** Next state after a SUCCESS, or null if no transition. */
export function onSuccessTransition(
  cur: BreakerSnapshot,
  cfg: BreakerConfig,
  now: Date,
): BreakerSnapshot | null {
  if (cur.state !== 'half_open') return null;
  const successes = cur.halfOpenSuccesses + 1;
  if (successes >= cfg.halfOpenSuccesses) {
    return {
      state: 'closed',
      openedAt: null,
      cooldownUntil: null,
      tripCount: 0,
      halfOpenSuccesses: 0,
    };
  }
  return { ...cur, state: 'half_open', halfOpenSuccesses: successes };
}

/** An open breaker whose cooldown has elapsed is eligible to probe (half-open). */
export function openEligibleAt(cur: BreakerSnapshot, now: Date): boolean {
  return (
    cur.state === 'open' &&
    cur.cooldownUntil !== null &&
    now.getTime() >= cur.cooldownUntil.getTime()
  );
}

/** Merge a fault_policy's nullable breaker fields over the global defaults. */
export function resolveBreakerConfig(policy?: {
  breakerEnabled?: boolean | null;
  breakerWindowMs?: number | null;
  breakerMinVolume?: number | null;
  breakerFailureRatePct?: number | null;
  breakerHalfOpenTrial?: number | null;
  breakerHalfOpenSuccesses?: number | null;
  breakerOpenCooldownMs?: number | null;
  breakerOpenCooldownCapMs?: number | null;
}): BreakerConfig {
  const d = DEFAULT_BREAKER_CONFIG;
  if (!policy) return d;
  return {
    enabled: policy.breakerEnabled ?? d.enabled,
    windowMs: policy.breakerWindowMs ?? d.windowMs,
    minVolume: policy.breakerMinVolume ?? d.minVolume,
    failureRatePct: policy.breakerFailureRatePct ?? d.failureRatePct,
    halfOpenTrial: policy.breakerHalfOpenTrial ?? d.halfOpenTrial,
    halfOpenSuccesses: policy.breakerHalfOpenSuccesses ?? d.halfOpenSuccesses,
    openCooldownMs: policy.breakerOpenCooldownMs ?? d.openCooldownMs,
    openCooldownCapMs: policy.breakerOpenCooldownCapMs ?? d.openCooldownCapMs,
  };
}
```

- [ ] **Step 4: Run, expect PASS** (`pnpm --filter @actionow/engine exec vitest run test/breaker.test.ts`), then `pnpm --filter @actionow/engine build`.

- [ ] **Step 5: Commit.**

```bash
git add packages/engine/src/breaker.ts packages/engine/test/breaker.test.ts
git commit -m "feat(engine): breaker FSM core + config resolution (resilience v2)"
```

### Task 5: Redis window + trial gate (infra)

**Files:**

- Create: `packages/infra/src/breaker-redis.ts` (`BreakerRedis` iface, `LuaBreakerRedis`, `FakeBreakerRedis`)
- Modify: `packages/infra/src/index.ts` (export)
- Test: `packages/infra/test/breaker-redis.test.ts`

- [ ] **Step 1: Failing test** mirroring `rate-limit` tests, using `FakeBreakerRedis`: `recordOutcome(key, windowMs, isFail)` increments total (and fail when isFail), returns `{total, fail}` over current+previous bucket; `tryTrial(key, max, ttlMs)` returns true up to `max` then false; `clearWindow(key)` resets.

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement `breaker-redis.ts`.** Model the Lua on `INCR_WINDOW_LUA`/`CONC_INCR_LUA` from `packages/infra/src/rate-limit.ts`. Window uses two hash fields `total`/`fail` keyed `breaker:win:{base}:{epoch}` where `epoch = floor(now/windowMs)`; `recordOutcome` reads current+previous epoch and sums (sliding approximation). `tryTrial` mirrors `CONC_INCR_LUA` (INCR with cap + TTL). Provide `EvalCapableRedis`-based `LuaBreakerRedis` and a deterministic `FakeBreakerRedis` (Map-based, `Date.now()` for epoch) for tests.

```ts
export interface BreakerRedis {
  recordOutcome(
    base: string,
    windowMs: number,
    isFail: boolean,
    now: number,
  ): Promise<{ total: number; fail: number }>;
  tryTrial(base: string, max: number, ttlMs: number): Promise<boolean>;
  clearWindow(base: string, windowMs: number, now: number): Promise<void>;
}
```

(Implement `LuaBreakerRedis` with a Lua script that, for the window, INCRs `total` and conditionally `fail` on the current epoch hash with a 2×windowMs PEXPIRE, then HGETs current+previous epochs and returns summed totals. `tryTrial` reuses the concurrency INCR-with-cap pattern. Keep `clearWindow` deleting the current+previous epoch keys.)

- [ ] **Step 4: Run, expect PASS.** `pnpm --filter @actionow/infra exec vitest run test/breaker-redis.test.ts`; `pnpm --filter @actionow/infra build`.

- [ ] **Step 5: Commit.**

```bash
git add packages/infra/src/breaker-redis.ts packages/infra/src/index.ts packages/infra/test/breaker-redis.test.ts
git commit -m "feat(infra): redis breaker window + trial gate (resilience v2)"
```

### Task 6: `BreakerStore` (engine interface + concrete store) tying Redis + PG + FSM

**Files:**

- Modify: `packages/engine/src/breaker.ts` (add the `BreakerStore` interface + a `DefaultBreakerStore`)
- Test: `packages/engine/test/breaker-store.test.ts`

- [ ] **Step 1: Failing test** with `FakeBreakerRedis` + an in-memory PG stub + a fake audit sink: a closed (channel,model) that crosses the failure-rate threshold transitions to open (persisted + audited); `filterAvailable` excludes an open-not-elapsed row, admits a half-open row that wins a trial slot, excludes one that doesn't; a store/Redis throw → `filterAvailable` returns all (fail-open).

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement the `BreakerStore` interface + `DefaultBreakerStore` in `breaker.ts`** (or a new `breaker-store.ts`):

```ts
export interface RoutableChannelRef {
  id: string;
}

export interface BreakerStore {
  /** The subset of channels routable now for `model` (excludes open; trial-gates half_open). Fail-open on error. */
  filterAvailable<C extends RoutableChannelRef>(
    channels: readonly C[],
    model: string,
    now: Date,
  ): Promise<C[]>;
  onSuccess(channelId: string, model: string, now: Date): Promise<void>;
  onFailure(channelId: string, model: string, now: Date, retryAfterMs?: number): Promise<void>;
}

export interface BreakerPersistence {
  getRows(
    channelIds: string[],
    model: string,
  ): Promise<
    (BreakerSnapshot & { channelId: string }[]) | Array<{ channelId: string } & BreakerSnapshot>
  >;
  upsert(channelId: string, model: string, snap: BreakerSnapshot, now: Date): Promise<void>;
}

export interface BreakerDeps {
  redis: import('@actionow/infra').BreakerRedis;
  persistence: BreakerPersistence; // wraps getBreakerRows/upsertBreaker (Task 2)
  configFor: (channelId: string) => Promise<BreakerConfig>; // resolves fault_policy → resolveBreakerConfig; defaults if none
  onTransition?: (
    channelId: string,
    model: string,
    from: BreakerState,
    to: BreakerState,
    meta: Record<string, unknown>,
  ) => void; // audit hook
}
```

`DefaultBreakerStore` implements:

- `filterAvailable`: `getRows` for the channel ids + model; build a map. For each channel: no row or `state==='closed'` → include; `open` & not `openEligibleAt(now)` → exclude; `open` & elapsed → persist transition to `half_open` (reset successes), then `redis.tryTrial(key, cfg.halfOpenTrial, cooldown)` → include iff acquired; `half_open` → `tryTrial` → include iff acquired. Wrap the whole body in try/catch → on any error return `[...channels]`.
- `onFailure`: `redis.recordOutcome(key, cfg.windowMs, true, now)`; load current row (or closed default); `onFailureTransition(...)`; if non-null persist + fire `onTransition`. Best-effort try/catch (swallow).
- `onSuccess`: `redis.recordOutcome(key, cfg.windowMs, false, now)`; load row; `onSuccessTransition(...)`; if non-null persist + fire `onTransition` (+ `clearWindow` on →closed). Best-effort.
- key = `${channelId}:${model}`.

- [ ] **Step 4: Run, expect PASS** (`pnpm --filter @actionow/engine exec vitest run test/breaker-store.test.ts`), `pnpm --filter @actionow/engine build`.

- [ ] **Step 5: Commit.**

```bash
git add packages/engine/src/breaker*.ts packages/engine/test/breaker-store.test.ts
git commit -m "feat(engine): BreakerStore (redis window + pg state + fsm + fail-open) (resilience v2)"
```

---

## Phase 3 — Engine wiring (read + write)

### Task 7: wire BreakerStore into routing (`channel-routing.ts`)

**Files:**

- Modify: `packages/engine/src/channel-routing.ts`
- Test: `packages/engine/test/channel-routing.test.ts` (extend/locate existing)

- [ ] **Step 1: Failing test** — `routeBlocking` with an injected fake `BreakerStore`: a (channel,model) the store excludes is not attempted; a success calls `store.onSuccess`, a retryable failure calls `store.onFailure`; with no store (undefined) behavior is unchanged (all channels available, no recording).

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.** Add `breaker?: BreakerStore` to `ChannelRouterDeps` and a `model: string` parameter to `availableChannels` and `routeBlocking`:

```ts
export interface ChannelRouterDeps {
  db: DbOrTx;
  now: () => Date;
  rng: () => number;
  breaker?: BreakerStore;
}

export async function availableChannels<C extends RoutableChannel>(
  deps: ChannelRouterDeps,
  channels: readonly C[],
  model: string,
): Promise<C[]> {
  if (channels.length <= 1) return [...channels];
  if (!deps.breaker) return [...channels];
  return deps.breaker.filterAvailable(channels, model, deps.now()); // fail-open inside the store
}

export async function routeBlocking<C extends RoutableChannel, R>(
  deps: ChannelRouterDeps,
  channels: readonly C[],
  model: string,
  attempt: (channel: C) => Promise<R>,
): Promise<R> {
  const available = await availableChannels(deps, channels, model);
  const weighted = available.map((c) => ({
    id: c.id,
    weight: c.weight,
    priority: c.priority,
    value: c,
  }));
  return routeWithFailover(
    weighted,
    deps.rng,
    async (value, channel) => {
      try {
        const r = await attempt(value);
        if (deps.breaker) void deps.breaker.onSuccess(channel.id, model, deps.now());
        return r;
      } catch (err) {
        if (isFailoverRetryable(err) && deps.breaker) {
          void deps.breaker.onFailure(channel.id, model, deps.now());
        }
        throw err;
      }
    },
    isFailoverRetryable,
  );
}
```

(Import `BreakerStore` from `./breaker.js` / `./breaker-store.js`. Remove the temporary Task-2 stub. `void` the breaker writes so they never block/throw on the hot path — the store already swallows.)

- [ ] **Step 4: Run, expect PASS**, `pnpm --filter @actionow/engine build`.

- [ ] **Step 5: Commit.**

```bash
git add packages/engine/src/channel-routing.ts packages/engine/test/channel-routing.test.ts
git commit -m "feat(engine): route via BreakerStore filter + outcome hooks (resilience v2)"
```

### Task 8: construct + inject BreakerStore in API + worker; thread model

**Files:**

- Modify: `packages/engine/src/execution-service.ts` (pass `model` into `routeBlocking`; add `breaker` to deps), its `ExecutionServiceDeps`
- Modify: `apps/api` ExecutionService construction (where deps incl. db/adapters/http are assembled) + `apps/worker/src/runtime.ts`
- Create: `packages/db`-backed `BreakerPersistence` adapter + `configFor` (resolve a channel's fault_policy) — small helper, likely in `apps/api`/`apps/worker` shared or `packages/engine` consuming injected repo fns
- Test: an execution-service unit/integration that a relay threads the model + uses the breaker (extend existing execution-service tests)

- [ ] **Step 1: Thread `model`.** In `execution-service.ts` `runBlocking`, pass the resolved model (`req.usageLogModel ?? req.resource?.model ?? '*'`) as the new `routeBlocking(deps, channels, model, attempt)` arg. Add `breaker?: BreakerStore` to the routing deps object it builds.

- [ ] **Step 2: Build the store at the app layer.** In the API's engine/execution wiring (where `createRedis`, `db`, adapters are available) construct `new DefaultBreakerStore({ redis: new LuaBreakerRedis(redisClient), persistence: pgPersistence(db), configFor: (id) => resolveChannelBreakerConfig(db, id), onTransition: (…) => auditService.record({ actorType:'system', action:`breaker.${to}`, targetType:'channel', targetId: channelId, meta }) })`. `pgPersistence(db)` wraps `getBreakerRows`/`upsertBreaker` (Task 2). `resolveChannelBreakerConfig` reads `upstream_channel.fault_policy_id` → fault_policy row → `resolveBreakerConfig`. Do the same in `apps/worker/src/runtime.ts`.

- [ ] **Step 3: Audit dependency.** `onTransition` calls the records-system `AuditService.record(...)` ([[records-system-v1]]); confirm its signature in `apps/api/src/audit/audit.service.ts`. In the worker (no Nest DI), call the audit repo `appendAuditLog` directly.

- [ ] **Step 4: Typecheck + build + tests.** `pnpm --filter @actionow/engine build && pnpm --filter @actionow/api typecheck && pnpm --filter @actionow/api build`. Run the execution-service tests.

- [ ] **Step 5: Commit.**

```bash
git add packages/engine/src/execution-service.ts apps/api apps/worker
git commit -m "feat(api,worker): construct + inject BreakerStore; thread model into routing (resilience v2)"
```

---

## Phase 4 — Cross-group failover

### Task 9: `fallback_group_id` chain → appended lower-tier candidates

**Files:**

- Create/Modify: `packages/db/src/repositories/route-group.ts` (`listCandidateChannelsWithFallback`)
- Modify: `apps/api/src/common/channel-routing.service.ts` (`candidatesFor` uses it), the worker candidate path
- Test: `packages/db/test/route-group.int.test.ts` + an api e2e

- [ ] **Step 1: Failing repo test** (`route-group.int.test.ts`): group A (channels a1,a2) with `fallback_group_id`=B (channel b1); `listCandidateChannelsWithFallback(db, resourceId, A)` returns a1,a2 at their tiers and b1 at a strictly lower tier (priority offset). A cycle A→B→A stops at depth/cycle guard (no infinite loop, B's channels appear once). Depth >5 truncates.

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement `listCandidateChannelsWithFallback`:**

```ts
const FALLBACK_TIER_OFFSET = 1_000_000;

export async function listCandidateChannelsWithFallback(
  db: DbOrTx,
  resourceId: string,
  groupId: string,
): Promise<GroupChannelForResource[]> {
  const out: GroupChannelForResource[] = [];
  const seen = new Set<string>();
  let current: string | null = groupId;
  for (let hop = 0; hop < 5 && current !== null && !seen.has(current); hop++) {
    seen.add(current);
    const rows = await listGroupChannelsForResource(db, resourceId, current);
    for (const r of rows) out.push({ ...r, priority: r.priority - hop * FALLBACK_TIER_OFFSET });
    const grp = await getRouteGroupById(db, current); // returns row incl. fallbackGroupId
    current = grp?.fallbackGroupId ?? null;
  }
  return out;
}
```

(Confirm `getRouteGroupById` exists and returns `fallbackGroupId`; if not, add it / extend the select. `GroupChannelForResource` already carries `priority`/`weight`.)

- [ ] **Step 4: Wire `candidatesFor`.** In `apps/api/src/common/channel-routing.service.ts`, replace the `listGroupChannelsForResource(db, resourceId, groupId)` call with `listCandidateChannelsWithFallback(...)`. Keep the existing model-link demotion (`UNLINKED_PRIORITY_OFFSET`) composed on top. Mirror in the worker candidate path if it has its own builder.

- [ ] **Step 5: e2e** (`apps/api/test/`): seed group A (one channel that always 500s) → fallback group B (one channel that succeeds); a relay through a key bound to A succeeds via B. (Use the existing relay e2e harness + a stub upstream.)

- [ ] **Step 6: Run tests + build + typecheck.** `pnpm --filter @actionow/db exec vitest run test/route-group.int.test.ts`, the api e2e, `pnpm --filter @actionow/api typecheck`.

- [ ] **Step 7: Commit.**

```bash
git add packages/db/src/repositories/route-group.ts apps/api apps/worker packages/db/test apps/api/test
git commit -m "feat(api): cross-group failover via fallback_group_id chain (resilience v2)"
```

---

## Phase 5 — Admin / ops surface

### Task 10: fault_policy breaker fields in the 容错策略 page

**Files:**

- Modify: the web fault-policy page (`grep -rn "faultPolic" apps/web/src/features` to locate), its api helper/types
- (Contracts + admin create/update already accept the fields from Task 3.)

- [ ] **Step 1:** Add the 8 breaker fields to the fault-policy editor form (a collapsible "熔断" section) + show key ones (enabled, failure rate %, window) in the table/detail. Use the existing field components + the `ConsoleCreate/UpdateFaultPolicy` types. **Step 2:** i18n keys (zh-CN + en) for the breaker fields. **Step 3:** `pnpm --filter @actionow/web typecheck && pnpm --filter @actionow/web test`. **Step 4:** Commit `feat(web): fault_policy breaker fields in 容错策略 page (resilience v2)`.

### Task 11: route-group fallback selector + server validation

**Files:**

- Modify: the route-group editor page (web) + the admin create/update route-group handler (cycle/depth validation)
- Test: an admin unit/e2e for the cycle guard

- [ ] **Step 1: Failing test** — `POST/PATCH /admin/route-groups` rejecting a `fallbackGroupId` that would form a cycle (A→B, B→A) with a 400. **Step 2:** Implement server-side cycle/depth validation in the admin service (walk the proposed chain ≤5, reject on revisit) → `engineInvalidInput`. **Step 3:** Web: add a `fallback_group_id` `<select>` (other live groups) to the route-group editor. **Step 4:** i18n. **Step 5:** `pnpm --filter @actionow/api exec vitest run <the test>`, `pnpm --filter @actionow/web typecheck && test`. **Step 6:** Commit `feat(api,web): route_group fallback selector + cycle guard (resilience v2)`.

### Task 12: breaker status surface (`GET /admin/breakers` + reset + UI)

**Files:**

- Modify: `apps/api/src/admin/admin.controller.ts` + `admin.service.ts` (list + reset), contracts (a `breakerView`)
- Create: a web 熔断 panel (or a section on the health/status page) + api helper
- Test: admin unit + a web render test

- [ ] **Step 1: Failing test** — `GET /admin/breakers` returns rows (channel name, model, state, cooldown_until, trip_count); `POST /admin/breakers/:channelId/:model/reset` clears one (calls `resetBreaker`). **Step 2:** Implement: service uses `listBreakers` (join channel name) + `resetBreaker`; controller routes (admin-guarded, `@Audit('breaker.reset')` on reset); a `breakerViewSchema` in contracts + SDK regen. **Step 3:** Web: a DataTable of breakers with a reset row-action (rawClient, like audit-log/limit-plans), reachable from the ops/health area + nav; i18n. **Step 4:** `pnpm --filter @actionow/contracts test`, `pnpm --filter @actionow/api exec vitest run <test>`, `pnpm --filter @actionow/web typecheck && test`. **Step 5:** Commit `feat(api,web): breaker status surface + reset (resilience v2)`.

---

## Phase 6 — Gate

### Task 13: full gate, live-verify, memory, PR

- [ ] **Step 1: Full suites.** `pnpm --filter @actionow/contracts test`, `pnpm --filter @actionow/db test`, `pnpm --filter @actionow/infra test`, `pnpm --filter @actionow/engine test`, `pnpm --filter @actionow/api test`, `pnpm --filter @actionow/web test` — all green. Full typecheck + lint clean. Confirm no lingering `channel_health`/`recordChannelFailure`/`listCooledDownChannelIds` references (`grep -rn`).
- [ ] **Step 2: Live-verify.** Rebuild + restart the API (`HTTP_EGRESS=curl node --env-file=.env --import tsx apps/api/dist/main.js`, port 3000) against the dev DB (apply mig 0047). Drive a channel to ≥`min_volume` failures → confirm a `channel_breaker` row goes `open` + an `audit_log` `breaker.open` row appears + the channel is excluded from routing; after cooldown a probe flows (half_open) and successes close it; configure group A→B fallback and confirm failover. `GET /admin/breakers` shows state; reset clears it.
- [ ] **Step 3:** Commit any fixes.
- [ ] **Step 4: Memory.** Add `memory/resilience-v2.md` + a MEMORY.md index line; update [[billing-routing-governance]] (④ → SHIPPED) + [[tokenhub-gap-analysis]] (熔断2.0 done).
- [ ] **Step 5: PR.** Push `feat/resilience-v2`; open PR → `main`; squash-merge (pre-authorized). Commit footer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`; PR body footer `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

## Self-review notes (addressed)

- **Spec coverage:** §② architecture→T4-7; §③ data model→T1; §④ engine integration→T6-8 (BreakerStore, read/write paths, model threading, audit); cross-group→T9; admin/ops→T10-12; testing throughout; phasing = the 6 phases.
- **`channel_health` drop:** T1 drops the table; T2 removes its repo funcs + repoints `listAllChannelsWithHealth`; T2 Step 6 + T13 Step 1 guard against stragglers.
- **Fail-open invariant:** stated in the header, enforced in T6 (`filterAvailable` try/catch → all) and T7 (`void` breaker writes).
- **Naming consistency:** `BreakerStore`/`DefaultBreakerStore`, `channelBreaker`/`channel_breaker`, `getBreakerRows`/`upsertBreaker`/`resetBreaker`/`listBreakers`, `resolveBreakerConfig`, `onSuccess`/`onFailure`/`filterAvailable`, `listCandidateChannelsWithFallback`, `fallbackGroupId`/`fallback_group_id` — used consistently across tasks.
- **Open items flagged for implementer judgment (ground-truth):** exact contract module paths for fault-policy/route-group; the web page file names; `AuditService.record` signature; whether the worker has its own candidate builder.
