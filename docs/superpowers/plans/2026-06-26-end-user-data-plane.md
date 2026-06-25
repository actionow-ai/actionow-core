# 端用户数据平面 (End-User Data Plane) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give tenant-admins self-service management of their own app's end-users (subjects + scoped keys + sub-wallets + tenant-owned limit plans) on `/console`/`/app`, and give end-users read-only self-service (`/member/*` + `/portal`).

**Architecture:** Part A mirrors the existing `/admin` subject/sub-wallet/limit-plan surface down to the `/console` plane behind `@TenantAdmin`, forcing every query to the caller's `tenantId`. Part B adds a new `MemberGuard` (member JWT `typ:'subject'`) and read-only `/member/*` endpoints scoped to the token's `subjectId`. Plans become tenant-ownable via `limit_plan.tenant_id`.

**Tech Stack:** NestJS (apps/api), drizzle/postgres (packages/db), zod contracts (packages/contracts), Vite/React (apps/web), vitest; db/api e2e use `@testcontainers/postgresql`.

**Spec:** `docs/superpowers/specs/2026-06-26-end-user-data-plane-design.md`. Branch: `feat/end-user-data-plane` (spec committed). Phases are reordered vs the spec so backend (1–3) is contiguous before frontend (4–5), matching a backend-then-frontend workflow split.

**Conventions (follow exactly):**

- **GIT IS GATED on the Xcode license:** prefix EVERY git command with `DEVELOPER_DIR=/Library/Developer/CommandLineTools`. The pre-commit hook works under it. NEVER run sudo / `xcodebuild -license`.
- commitlint: lowercase imperative subject, header ≤100 chars; commit body ends with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Do NOT push / open PRs (phase 6 is the controller's).
- DB schema edit → `pnpm --filter @actionow/db db:generate` → hand-edit the generated SQL if needed → `pnpm --filter @actionow/db db:migrate`.
- Contracts change → `pnpm --filter @actionow/contracts build && gen:openapi && pnpm --filter @actionow/sdk gen && build && pnpm --filter @actionow/contracts test`, COMMIT regenerated files.
- `/console` + `/member` routes are NOT in the SDK path set → web consumes via `rawClient` (see `apps/web/src/lib/api/admin.ts` + the limit-plan/sub-wallet precedents).
- i18n: new user-facing strings in BOTH `apps/web/src/i18n/locales/zh-CN` and `/en`.
- **LOAD-BEARING ISOLATION INVARIANT:** every Part-A query is scoped to `req.console.tenantId`; every Part-B query to `req.member.subjectId`. NEVER trust an id from the body/path without intersecting it with that scope (cross-tenant subjectId → 404; member only reads own subject). Reuse the existing tenant-scoped admin repos.
- GROUND TRUTH OVER PLAN: mirror the named `/admin` precedents; adapt to real repo/function names; note deviations.

---

## Phase 1 — Data + repos + contracts

### Task 1: `limit_plan.tenant_id` + tenant-scoped plan repos

**Files:**

- Modify: `packages/db/src/schema/limit.ts`, `packages/db/src/repositories/limit.ts`
- Generate/edit: `packages/db/drizzle/0050_*.sql`
- Test: `packages/db/test/limit.int.test.ts` (extend) + `packages/db/test/schema-constraints.test.ts`

- [ ] **Step 1: Add `tenant_id` + per-`(tenant_id,name)` unique index.** In `packages/db/src/schema/limit.ts`, import `tenant` from `./identity.js` and add to the `limitPlan` columns + replace the name unique index:

```ts
// in columns, after description:
tenantId: uuid('tenant_id').references(() => tenant.id),
```

```ts
// replace the limit_plan_name_idx uniqueIndex with a per-tenant one. NULLS NOT
// DISTINCT so platform plans (tenant_id NULL) still enforce name-uniqueness
// among themselves (Postgres 15+).
uniqueIndex('limit_plan_tenant_name_idx')
  .on(t.tenantId, t.name)
  .where(sql`deleted_at IS NULL`),
```

(If drizzle-kit doesn't emit `NULLS NOT DISTINCT`, hand-edit the generated SQL to add it to the unique index: `CREATE UNIQUE INDEX "limit_plan_tenant_name_idx" ON "limit_plan" ("tenant_id","name") NULLS NOT DISTINCT WHERE "deleted_at" IS NULL;`.)

- [ ] **Step 2: Generate + apply.** `pnpm --filter @actionow/db db:generate` → confirm `0050_*.sql` adds `tenant_id` + drops the old `limit_plan_name_idx` + creates the new one (existing rows keep `tenant_id` NULL = platform plans). Hand-edit for `NULLS NOT DISTINCT` if missing. `pnpm --filter @actionow/db db:migrate`.

- [ ] **Step 3: Failing repo test** (`packages/db/test/limit.int.test.ts`): `createLimitPlan(db, {name, tenantId})` persists tenant_id; `listLimitPlansByTenant(db, tenantId)` returns only that tenant's plans (not platform NULL ones, not other tenants'); two tenants may both have a plan named `'pro'`; `getLimitPlanForTenant(db, id, tenantId)` returns undefined for another tenant's plan id.

- [ ] **Step 4: Run, expect FAIL** (`pnpm --filter @actionow/db exec vitest run test/limit.int.test.ts`).

- [ ] **Step 5: Implement repo.** In `packages/db/src/repositories/limit.ts`: add `tenantId?: string` to `CreateLimitPlanInput` + persist it; add `LimitPlanRow.tenantId`; add tenant-scoped functions:

```ts
/** A tenant's own plans (tenant_id = tenantId), newest-first. */
export function listLimitPlansByTenant(db: DbOrTx, tenantId: string): Promise<LimitPlanRow[]> {
  return db
    .select(LIMIT_PLAN_COLUMNS)
    .from(limitPlan)
    .where(and(eq(limitPlan.tenantId, tenantId), isNull(limitPlan.deletedAt)))
    .orderBy(desc(limitPlan.createdAt)) as Promise<LimitPlanRow[]>;
}
/** A plan by id, only if it belongs to tenantId (else undefined). */
export async function getLimitPlanForTenant(
  db: DbOrTx,
  id: string,
  tenantId: string,
): Promise<LimitPlanRow | undefined> {
  const rows = await db
    .select(LIMIT_PLAN_COLUMNS)
    .from(limitPlan)
    .where(and(eq(limitPlan.id, id), eq(limitPlan.tenantId, tenantId), isNull(limitPlan.deletedAt)))
    .limit(1);
  return rows[0] as LimitPlanRow | undefined;
}
```

(Add `tenantId` to `LIMIT_PLAN_COLUMNS`. Reuse existing `updateLimitPlan`/`softDeleteLimitPlan` but the console service will pre-check ownership via `getLimitPlanForTenant`. Ensure `and`/`eq`/`isNull`/`desc` imported.)

- [ ] **Step 6: Run tests + build.** `pnpm --filter @actionow/db exec vitest run test/limit.int.test.ts test/schema-constraints.test.ts` (PASS); `pnpm --filter @actionow/db build`.

- [ ] **Step 7: Commit.**

```bash
DEVELOPER_DIR=/Library/Developer/CommandLineTools git add packages/db/src/schema/limit.ts packages/db/src/repositories/limit.ts packages/db/drizzle/ packages/db/test/
DEVELOPER_DIR=/Library/Developer/CommandLineTools git commit -m "feat(db): limit_plan.tenant_id + tenant-scoped plan repos (end-user data plane)"
```

### Task 2: contracts — `limitPlanView.tenant_id` + member view schemas

**Files:**

- Modify: `packages/contracts/src/limit.ts` (`limitPlanViewSchema` + create body `tenantId` mapping is server-set, not client), member/console view modules
- Create/Modify: a `packages/contracts/src/member-views.ts` (member self-service views)
- Test: the contracts test fixtures

- [ ] **Step 1: Add fields.** `limitPlanViewSchema` + `tenant_id: z.string().nullable()`. New `member-views.ts`: `memberMeViewSchema` ({id, status, tenant_id, external_id, email, display_name}), `memberUsageRowSchema`/list, `memberBalanceViewSchema` ({mode: 'shared'|'hard', balance, held} — strings µUSD), `memberKeyViewSchema` ({id, name, status, created_at, last4}), `memberLimitsViewSchema` (rules + used/cap). Export from the contracts index.

- [ ] **Step 2: Fixtures** in the contracts tests for `limitPlanView.tenant_id` + each member view. **Step 3:** build chain + regen + test (`pnpm --filter @actionow/contracts build && gen:openapi && pnpm --filter @actionow/sdk gen && build && pnpm --filter @actionow/contracts test`). **Step 4:** Commit `feat(contracts): limit_plan tenant_id + member self-service views (end-user data plane)`.

---

## Phase 2 — Part A backend (`/console` tenant-admin subject plane)

### Task 3: `/console/subjects` CRUD (tenant-scoped, `@TenantAdmin`)

**Files:**

- Modify: `apps/api/src/console/console.controller.ts`, `console.service.ts`, `console.module.ts`
- Test: `apps/api/test/console-subjects.e2e.test.ts`

- [ ] **Step 1: Failing e2e** — a tenant-admin JWT can `POST /console/subjects` (201), `GET /console/subjects` (lists own), `PATCH`/`DELETE`; a subject created under tenant A is **404 from tenant B's admin** (`GET /console/subjects/:id`); a member JWT → **403** on `POST /console/subjects`. Seed two tenants + tenant-admins (operator JWTs `{sub, role:'user'}`).

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.** Mirror the `/admin/tenants/:id/users*` subject endpoints onto `/console/subjects`, but with the tenant taken from `req.console.tenantId` (NOT a path param), each route `@UseGuards(TenantAdminGuard)`:

```ts
@Post('subjects')
@HttpCode(201)
@UseGuards(TenantAdminGuard)
@Audit('subject.create', 'subject')
async createSubject(@Body(new ZodBody(createSubjectSchema)) dto, @Req() req: ConsoleRequest) {
  const ctx = ctxOf(req);
  return toSubjectView(await this.console.createSubject(ctx.tenantId, dto));
}
@Get('subjects')
@UseGuards(TenantAdminGuard)
async listSubjects(@Req() req, @Query('cursor') cursor?, @Query('limit') limit?) { /* listSubjectsByTenant(ctx.tenantId, page) */ }
@Get('subjects/:id') @UseGuards(TenantAdminGuard) async getSubject(...) { /* getSubjectForTenant(id, ctx.tenantId) → 404 */ }
@Patch('subjects/:id') @UseGuards(TenantAdminGuard) @Audit('subject.update','subject') async patchSubject(...) {}
@Delete('subjects/:id') @HttpCode(200) @UseGuards(TenantAdminGuard) @Audit('subject.delete','subject') async deleteSubject(...) { /* the existing soft-delete cascade, scoped */ }
```

`console.service` methods call the existing subject repos (the ones backing `/admin`), always passing `ctx.tenantId`; `getSubjectForTenant`/update/delete return `engineNotFound` when the row's tenant ≠ ctx.tenantId. Reuse the subject soft-delete cascade ([[records-system-v1]] R3). Register nothing new in the module (TenantAdminGuard already provided from RBAC).

- [ ] **Step 4: Run e2e, expect PASS**, `pnpm --filter @actionow/api typecheck`. **Step 5: Commit** `feat(api): /console/subjects crud, tenant-scoped (end-user data plane)`.

### Task 4: `/console` subject-scoped keys + sub-wallet

**Files:** `apps/api/src/console/console.controller.ts` + `console.service.ts`; Test: `apps/api/test/console-subjects.e2e.test.ts` (extend)

- [ ] **Step 1: Failing e2e** — `POST /console/api-keys { name, subjectId }` mints a key bound to a tenant subject (and rejects a subjectId from another tenant → 400/404); `GET /console/subjects/:id/sub-account` → balance; `POST /console/subjects/:id/sub-account/open` then `/topup { amount }` moves credit from the tenant account pool to the subject's hard wallet; `/transfer` moves back.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Extend the existing `POST /console/api-keys` (RBAC) to accept optional `subjectId` (validate `getSubjectForTenant(subjectId, ctx.tenantId)` exists). Add sub-wallet routes mirroring the `/admin` sub-wallet handlers (the `getSubAccount`/`createSubAccount`/`topupSubAccount`/`transferSubAccount` repos), all `@TenantAdmin` + scoped to `ctx.tenantId`/`ctx.accountId`. Audit each.
- [ ] **Step 4: PASS + typecheck. Step 5: Commit** `feat(api): /console subject-scoped keys + sub-wallet, tenant-scoped (end-user data plane)`.

### Task 5: `/console/limit-plans` (tenant-owned) + bind to subject

**Files:** `apps/api/src/console/console.controller.ts` + `console.service.ts`; Test: `apps/api/test/console-limit-plans.e2e.test.ts`

- [ ] **Step 1: Failing e2e** — tenant-admin `POST /console/limit-plans` creates a plan with `tenant_id = ctx.tenantId`; `GET /console/limit-plans` lists only own (not platform NULL, not other tenants'); `PATCH`/`DELETE` reject another tenant's plan id (404); `POST /console/subjects/:id/limit-plan { planId }` binds (and **rejects a planId not owned by the tenant** → 400); a member → 403.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** CRUD via `createLimitPlan({...dto, tenantId: ctx.tenantId})` / `listLimitPlansByTenant(ctx.tenantId)` / `getLimitPlanForTenant(id, ctx.tenantId)` (update/delete pre-check ownership → `engineNotFound`). Bind: validate both the subject (`getSubjectForTenant`) and the plan (`getLimitPlanForTenant`) belong to the tenant, then set `subject.limit_plan_id`. All `@TenantAdmin`, audited.
- [ ] **Step 4: PASS + typecheck. Step 5: Commit** `feat(api): /console tenant-owned limit-plans + subject binding (end-user data plane)`.

---

## Phase 3 — Part B backend (`/member` end-user plane)

### Task 6: `MemberGuard` + `MemberModule`

**Files:**

- Create: `apps/api/src/member/member.guard.ts`, `apps/api/src/member/member.module.ts`
- Test: `apps/api/test/member.guard.test.ts`

- [ ] **Step 1: Failing unit test** (mirror `console.guard.test.ts`): a member JWT (`{sub, tenant_id, typ:'subject'}`) → `req.member = {subjectId, tenantId}` when the subject is active; an operator JWT (`{sub, role}`) → throws (rejected); a disabled/missing subject → throws; a bad/expired token → throws.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `member.guard.ts` mirroring `ConsoleGuard` but inverted on `typ`:

```ts
export interface MemberContext {
  readonly subjectId: string;
  readonly tenantId: string;
}
export interface MemberRequest extends Request {
  member?: MemberContext;
}

@Injectable()
export class MemberGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: AppEnv,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<MemberRequest>();
    const token = bearerToken(req);
    if (token === undefined) throw engineUnauthorized('missing member token');
    let claims: { sub: string; tenant_id?: string; typ?: string };
    try {
      claims = await this.jwt.verifyAsync(token, { secret: this.env.ADMIN_JWT_SECRET });
    } catch {
      throw engineUnauthorized('invalid or expired member token');
    }
    if (claims.typ !== 'subject' || typeof claims.tenant_id !== 'string') {
      throw engineUnauthorized('not a member token');
    }
    const subject = await findSubjectById(this.db, claims.sub);
    if (subject?.status !== 'active' || subject.tenantId !== claims.tenant_id) {
      throw engineUnauthorized('member subject not active');
    }
    req.member = { subjectId: subject.id, tenantId: subject.tenantId };
    return true;
  }
}
```

(Reuse/confirm `findSubjectById` from `@actionow/db`; `bearerToken` can be copied from console.guard or shared. `MemberModule` provides the guard + the member controller; imports DbModule + JwtModule like ConsoleModule.)

- [ ] **Step 4: Run, expect PASS** (`pnpm --filter @actionow/api exec vitest run test/member.guard.test.ts`). **Step 5: Commit** `feat(api): MemberGuard for the end-user plane (end-user data plane)`.

### Task 7: `/member/*` read-only endpoints

**Files:**

- Create: `apps/api/src/member/member.controller.ts`, `member.service.ts`
- Modify: `apps/api/src/app.module.ts` (register MemberModule)
- Test: `apps/api/test/member.e2e.test.ts`

- [ ] **Step 1: Failing e2e** — with a member JWT: `GET /member/me` → own identity; `/member/usage` → only own usage_log rows; `/member/balance` → own sub_account (or `mode:'shared'`); `/member/api-keys` → own keys (no plaintext, no other subject's); `/member/limits` → own effective plan + usage. Critically: a member for subject A **cannot** see subject B's data; an **operator JWT → 401** on `/member/me`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Each route `@UseGuards(MemberGuard)`, scoped to `req.member.subjectId`:

```ts
@Controller('member')
@UseGuards(MemberGuard)
export class MemberController {
  @Get('me') me(@Req() req: MemberRequest) {
    return this.member.me(req.member!.subjectId);
  }
  @Get('usage') usage(@Req() req, @Query('cursor') c?, @Query('limit') l?) {
    return this.member.usage(req.member!.subjectId, toPageParams({ cursor: c, limit: l }));
  }
  @Get('balance') balance(@Req() req) {
    return this.member.balance(req.member!.subjectId);
  }
  @Get('api-keys') keys(@Req() req) {
    return this.member.keys(req.member!.subjectId);
  }
  @Get('limits') limits(@Req() req) {
    return this.member.limits(req.member!.subjectId);
  }
}
```

`member.service` reads own data: `listUsageLogBySubject(subjectId)`, `getSubAccountBySubject(subjectId)`, `listApiKeysBySubject(subjectId)` (masked), and the limit-status computation for the subject's effective plan. Add any missing subject-scoped repo reads (mirror existing tenant-scoped readers). Never return plaintext keys.

- [ ] **Step 4: Run e2e, expect PASS**, `pnpm --filter @actionow/api typecheck && build`. **Step 5: Commit** `feat(api): /member read-only self-service endpoints (end-user data plane)`.

---

## Phase 4 — Part A web (`/app`)

### Task 8: 端用户 (Subjects) page + detail drawer + key subject selector

**Files:** `apps/web/src/features/app/AppSubjects.tsx` (new) + a detail drawer mirroring `apps/web/src/features/console/SubjectDetailPanel.tsx`; `apps/web/src/lib/api/consoleApi.ts` (subject + sub-wallet + plan helpers via rawClient); `routes.tsx`, `app-nav.ts`; `AppKeys.tsx` (subject selector on mint)

- [ ] **Step 1:** Add `consoleApi` rawClient helpers for `/console/subjects*`, `/console/subjects/:id/sub-account*`, `/console/subjects/:id/limit-plan`. **Step 2:** Build `AppSubjects` (DataTable + create modal + detail drawer mirroring `SubjectDetailPanel`: sub-wallet topup/transfer, plan binding, usage bars, scoped keys). **Step 3:** Add subject selector to the AppKeys mint form (mirror admin ApiKeysPage). **Step 4:** Route `/app/subjects` + tenant-admin-only nav item; i18n (zh-CN+en). **Step 5:** `pnpm --filter @actionow/web typecheck && test`. **Step 6: Commit** `feat(web): /app subjects page + detail drawer + key subject selector (end-user data plane)`.

### Task 9: 额度套餐 (limit plans) page on `/app`

**Files:** `apps/web/src/features/app/AppLimitPlans.tsx` (mirror `LimitPlansPage`, tenant-scoped via `/console/limit-plans`); `consoleApi.ts`; `routes.tsx`, `app-nav.ts`

- [ ] **Step 1:** `consoleApi` helpers for `/console/limit-plans*`. **Step 2:** `AppLimitPlans` page (DataTable + rule editor drawer, mirror `LimitPlansPage`). **Step 3:** route + nav (tenant-admin only) + i18n. **Step 4:** `pnpm --filter @actionow/web typecheck && test`. **Step 5: Commit** `feat(web): /app tenant limit-plans page (end-user data plane)`.

---

## Phase 5 — Part B web (`/portal`)

### Task 10: MemberPortal self-service views

**Files:** `apps/web/src/features/app/MemberPortal.tsx` (replace placeholder); a member rawClient (member token) + `/member/*` helpers; Test: `MemberPortal.test.tsx`

- [ ] **Step 1: Failing component test** — `MemberPortal` (mocked member api) renders the member's usage / balance / keys / limits. **Step 2:** Add a member-token api module (`apps/web/src/lib/api/memberApi.ts`) using the member JWT (the `/member/login` flow already stores it) calling `/member/me|usage|balance|api-keys|limits`. **Step 3:** Replace the `MemberPortal` placeholder with real read-only sections (identity, balance card, usage table, keys list, limit usage bars) — reuse `UsageBar`/`BalanceCard`/`DataTable`. **Step 4:** i18n. **Step 5:** `pnpm --filter @actionow/web typecheck && test`. **Step 6: Commit** `feat(web): member /portal self-service views (end-user data plane)`.

---

## Phase 6 — Gate

### Task 11: full gate, live-verify, memory, PR

- [ ] **Step 1: Full suites** (run testcontainer suites separately to avoid the known parallel-load flake): `pnpm --filter @actionow/contracts test`, `pnpm --filter @actionow/db test`, `pnpm --filter @actionow/api exec vitest run`, `pnpm --filter @actionow/web test` — all green; full typecheck + lint clean.
- [ ] **Step 2: Live-verify** (rebuild + restart API; apply mig 0050): as a tenant-admin (self-register) create a subject + mint a subject-scoped key + topup its sub-wallet + create a tenant plan + bind it; confirm a second tenant can't see it (cross-tenant 404). Register a member (`/member/login`), call `/member/usage|balance|keys|limits` → own data only; confirm an operator token → 401 on `/member/*`. Screenshot the `/app` subjects page + the `/portal` self-service.
- [ ] **Step 3:** Commit fixes (DEVELOPER_DIR git).
- [ ] **Step 4: Memory.** Add `memory/end-user-data-plane.md` + index line; update [[unified-tenancy-ab-design]] (member data plane → SHIPPED) + [[billing-routing-governance]] (the deferred member plane → done) + [[product-positioning]] (multi-app self-serve now real).
- [ ] **Step 5: PR.** Push `feat/end-user-data-plane` (DEVELOPER_DIR git); open PR → `main`; squash-merge (pre-authorized). Footers: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` (commit) + `🤖 Generated with [Claude Code](https://claude.com/claude-code)` (PR body).

---

## Self-review notes (addressed)

- **Spec coverage:** §① three planes → T3-5 (A) + T6-7 (B); §② data model → T1; §③ Part A → T3-5 (subjects/keys/sub-wallet/plans/bind) + T8-9 (web); §④ Part B → T6-7 (MemberGuard + /member/\*) + T10 (portal); §⑤ contracts → T2; §⑥ testing throughout; §⑦ phasing = these 6 phases (backend-first reorder noted).
- **Isolation invariant** stated in the header + enforced in every A task (scope to `ctx.tenantId`, cross-tenant → 404) and B task (scope to `req.member.subjectId`; operator token → 401).
- **`NULLS NOT DISTINCT`** flagged in T1 so platform-plan name uniqueness still holds.
- **Naming consistency:** `MemberGuard`/`MemberContext`/`req.member`, `listLimitPlansByTenant`/`getLimitPlanForTenant`, `getSubjectForTenant`, `/console/subjects`, `/member/*` — used consistently across tasks.
- **Reuse:** mirrors named precedents (`/admin` subject + sub-wallet + limit-plan repos, `SubjectDetailPanel`, `LimitPlansPage`, `ConsoleGuard`) rather than reinventing.
