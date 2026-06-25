import {
  type ConsoleApiKeyView,
  consoleApiKeyViewSchema,
  type ConsoleBalanceView,
  consoleBalanceViewSchema,
  type ConsoleCreateUserBody,
  consoleCreateUserSchema,
  type ConsoleFileView,
  consoleFileViewSchema,
  type ConsoleJobView,
  consoleJobViewSchema,
  type ConsoleLedgerView,
  consoleLedgerViewSchema,
  type ConsoleLimitStatusView,
  consoleLimitStatusViewSchema,
  type ConsoleMeView,
  consoleMeViewSchema,
  type ConsoleModelView,
  consoleModelViewSchema,
  type ConsolePaymentView,
  consolePaymentViewSchema,
  type ConsoleUpdateUserBody,
  consoleUpdateUserSchema,
  type ConsoleUsageLogView,
  consoleUsageLogViewSchema,
  type ConsoleUsageRollupView,
  consoleUsageRollupViewSchema,
  type ConsoleUserView,
  consoleUserViewSchema,
  type CreateSubAccountBody,
  createSubAccountSchema,
  type CreateSubjectBody,
  createSubjectSchema,
  type LimitPlanView,
  limitPlanViewSchema,
  type LimitRuleStatusView,
  limitRuleStatusViewSchema,
  type LimitRuleView,
  limitRuleViewSchema,
  type SubAccountView,
  subAccountViewSchema,
  type SubjectView,
  subjectViewSchema,
  type TopupSubAccountBody,
  topupSubAccountSchema,
  type TransferCreditsBody,
  transferCreditsSchema,
  type UpdateSubjectBody,
  updateSubjectSchema,
} from '@actionow/contracts';
import type {
  ApiKeyRow,
  FileObject,
  Job,
  LedgerRow,
  LimitPlanRow,
  LimitRuleRow,
  PaymentIntentRow,
  SubAccountRow,
  SubjectRow,
  UsageLogRow,
  UsageRollupRow,
  UserRecord,
} from '@actionow/db';
import type { AppEnv } from '@actionow/infra';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Audit } from '../audit/audit.decorator.js';
import { AuditInterceptor } from '../audit/audit.interceptor.js';
import { engineInvalidInput, engineUnauthorized } from '../common/errors.js';
import { mapPageEnvelope, type PageEnvelope, toPageParams } from '../common/pagination.js';
import { ENV } from '../common/tokens.js';
import { ZodBody } from '../common/zod.pipe.js';
import { type PresignUploadDto, presignUploadSchema } from '../files/dto/files.dto.js';
import type { FileView as FilesFileView, PresignUploadResult } from '../files/files.service.js';
import { FilesService } from '../files/files.service.js';
import { type ConsoleContext, ConsoleGuard, type ConsoleRequest } from './console.guard.js';
import type { ConsoleCreateIntentResponse } from './console.service.js';
import { ConsoleService } from './console.service.js';
import {
  type ConsoleAnalyticsUsageDto,
  consoleAnalyticsUsageSchema,
  type ConsoleChangePasswordDto,
  consoleChangePasswordSchema,
  type ConsoleCreateApiKeyDto,
  consoleCreateApiKeySchema,
  type ConsoleCreateIntentDto,
  consoleCreateIntentSchema,
  type ConsoleCreateLimitPlanDto,
  type ConsoleSetLimitPlanDto,
  type ConsoleUpdateLimitPlanDto,
  createLimitPlanRequestSchema,
  setLimitPlanRequestSchema,
  updateLimitPlanRequestSchema,
} from './dto/console.dto.js';
import type { ModelView } from './models.port.js';
import { TenantAdminGuard } from './tenant-admin.guard.js';

/** Read the guard-populated console context, or fail closed with `unauthorized`. */
function ctxOf(req: ConsoleRequest): ConsoleContext {
  if (req.console === undefined) throw engineUnauthorized('request is not authenticated');
  return req.console;
}

interface ApiKeyCreatedView {
  id: string;
  plaintext: string;
}

// The console wire views (ApiKey/Job/Ledger/Model/UsageRollup/UsageLog/Payment/
// Me/Balance) now live in @actionow/contracts (console-views + ops-views) — the
// single source of truth shared with the frontend. The mappers below `.parse()`
// against the schemas. Local aliases keep the route signatures terse and the
// `Console*` naming explicit at the call sites.
type ApiKeyView = ConsoleApiKeyView;
type JobView = ConsoleJobView;
type LedgerView = ConsoleLedgerView;
type ModelListItem = ConsoleModelView;
type UsageLogView = ConsoleUsageLogView;
type PaymentIntentView = ConsolePaymentView;
type MeView = ConsoleMeView;
type BalanceView = ConsoleBalanceView;
type FileView = ConsoleFileView;

/** Project a tenant api-key row to its console view (no hash; `subject_id` for the bound end-user). */
function toApiKeyView(r: Omit<ApiKeyRow, 'hash'>): ApiKeyView {
  return consoleApiKeyViewSchema.parse({
    id: r.id,
    resource_allowlist: r.resourceAllowlist,
    rate_limit: r.rateLimit,
    status: r.status,
    subject_id: r.subjectId,
    created_at: r.createdAt.toISOString(),
  });
}

/** Project a subject sub-wallet row to its console view (money as µcredit decimal strings). */
function toSubAccountView(row: SubAccountRow): SubAccountView {
  return subAccountViewSchema.parse({
    id: row.id,
    tenant_id: row.tenantId,
    subject_id: row.subjectId,
    credit_balance: row.creditBalance.toString(),
    credit_held: row.creditHeld.toString(),
    status: row.status,
    created_at: row.createdAt.toISOString(),
  });
}

/** Project a job row to the console job view (money as decimal strings). */
function toConsoleJobView(j: Job): JobView {
  return consoleJobViewSchema.parse({
    job_id: j.id,
    subject_id: j.subjectId,
    resource_id: j.resourceId,
    status: j.status,
    exec_mode: j.execMode,
    cost: j.costCredits === null ? null : j.costCredits.toString(),
    created_at: j.createdAt.toISOString(),
  });
}

/** Project a ledger row to the console ledger view (money as decimal strings). */
function toConsoleLedgerView(l: LedgerRow): LedgerView {
  return consoleLedgerViewSchema.parse({
    id: l.id,
    subject_id: l.subjectId,
    type: l.type,
    credits_delta: l.creditsDelta.toString(),
    balance_after: l.balanceAfter.toString(),
    job_id: l.jobId,
    created_at: l.createdAt.toISOString(),
  });
}

/**
 * Project a usage rollup row to the TENANT view. Deliberately omits
 * `provider_cost`/`margin` (operator-only — they reveal the platform's markup);
 * the console schema strips them even if passed, but we never read them here.
 */
function toConsoleUsageRollupView(row: UsageRollupRow): ConsoleUsageRollupView {
  return consoleUsageRollupViewSchema.parse({
    bucket: row.bucket,
    requests: row.requests,
    input_tokens: row.inputTokens.toString(),
    output_tokens: row.outputTokens.toString(),
    cost: row.cost.toString(),
    errors: row.errors,
    avg_latency_ms: row.avgLatencyMs,
    p95_latency_ms: row.p95LatencyMs,
  });
}

/** Project a usage-log row to the console view (tenant implicit; cost decimal string). */
function toUsageLogView(row: UsageLogRow): UsageLogView {
  return consoleUsageLogViewSchema.parse({
    id: row.id,
    subject_id: row.subjectId,
    model: row.model,
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    cost: row.cost.toString(),
    latency_ms: row.latencyMs,
    status: row.status,
    created_at: row.createdAt.toISOString(),
  });
}

/** Project a payment-intent row to the tenant's topup-history view (money as decimal strings). */
function toPaymentIntentView(row: PaymentIntentRow): PaymentIntentView {
  return consolePaymentViewSchema.parse({
    id: row.id,
    provider: row.provider,
    purpose: row.purpose,
    amount_minor: row.amountMinor.toString(),
    currency: row.currency,
    credit_amount: row.creditAmount === null ? null : row.creditAmount.toString(),
    status: row.status,
    created_at: row.createdAt.toISOString(),
  });
}

/**
 * Project a `file_object` row to the tenant's gallery view. `url` is a directly-
 * viewable link built from the storage public base + the object key, or `null`
 * when no public base is configured (the asset isn't web-served).
 */
function toConsoleFileView(row: FileObject, publicBase: string | undefined): FileView {
  return consoleFileViewSchema.parse({
    id: row.id,
    status: row.status,
    content_type: row.contentType,
    size: row.size,
    url: publicBase !== undefined ? `${publicBase}/${row.key}` : null,
    created_at: row.createdAt.toISOString(),
  });
}

/** Project the caller's user record to its profile view (never the password hash). */
function toMeView(u: UserRecord): MeView {
  return consoleMeViewSchema.parse({
    id: u.id,
    email: u.email,
    email_verified: u.emailVerified,
    role: u.role,
    status: u.status,
    tenant_id: u.tenantId,
    tenant_role: u.tenantRole,
  });
}

/**
 * Project a tenant sub-user row to its console view (RBAC list/update). `tenant_role`
 * falls back to `'member'` for the (post-backfill impossible) null case; never the
 * password hash.
 */
function toConsoleUserView(u: UserRecord): ConsoleUserView {
  return consoleUserViewSchema.parse({
    id: u.id,
    email: u.email,
    status: u.status,
    tenant_role: u.tenantRole ?? 'member',
    created_at: u.createdAt.toISOString(),
  });
}

/** Project a subject (end-user) row to its console view (NEVER the password hash). */
function toSubjectView(row: SubjectRow): SubjectView {
  return subjectViewSchema.parse({
    id: row.id,
    tenant_id: row.tenantId,
    external_id: row.externalId,
    email: row.email,
    display_name: row.displayName,
    limit_plan_id: row.limitPlanId,
    status: row.status,
    created_at: row.createdAt.toISOString(),
  });
}

/** Project a limit-rule row to its view (cap as a decimal µUSD/count string). */
function toLimitRuleView(row: LimitRuleRow): LimitRuleView {
  return limitRuleViewSchema.parse({
    id: row.id,
    dimension: row.dimension,
    period: row.period,
    cap: row.cap.toString(),
    model_scope: row.modelScope,
    alert_pct: row.alertPct,
    enforce: row.enforce,
  });
}

/**
 * Project a tenant-owned limit plan (+ rules + binding counts) to its view.
 * Mirrors the admin `toLimitPlanView`; `tenant_id` is always the caller's tenant
 * (a console plan is never platform-owned).
 */
function toLimitPlanView(p: {
  plan: LimitPlanRow;
  rules: LimitRuleRow[];
  bindings: { keys: number; tenants: number };
}): LimitPlanView {
  return limitPlanViewSchema.parse({
    id: p.plan.id,
    name: p.plan.name,
    description: p.plan.description,
    status: p.plan.status,
    tenant_id: p.plan.tenantId,
    rules: p.rules.map(toLimitRuleView),
    key_count: p.bindings.keys,
    tenant_count: p.bindings.tenants,
    created_at: p.plan.createdAt.toISOString(),
    updated_at: p.plan.updatedAt.toISOString(),
  });
}

/**
 * Validate the tenant analytics query (query params bypass `ZodBody`); a bad
 * value throws `invalid_input` → the global filter renders the 400 envelope.
 */
function parseConsoleAnalyticsUsage(raw: Record<string, string>): ConsoleAnalyticsUsageDto {
  const result = consoleAnalyticsUsageSchema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path.join('.') ?? '';
    const detail = first === undefined ? 'invalid query' : `${path}: ${first.message}`;
    throw engineInvalidInput(detail);
  }
  return result.data;
}

/**
 * The tenant self-service console (`/console`, Track B capstone). Every route is
 * gated by the {@link ConsoleGuard} (USER JWT → `{userId, tenantId, accountId}`)
 * and scoped to the caller's OWN tenant — the tenant is supplied by the guard,
 * never read from a body or query. This closes the audited gap: a self-registered
 * user can mint its own tenant API key and then call the `/v1` data plane with it.
 * Money is serialized as decimal µcredit strings so JSON never coerces through a
 * float.
 */
@ApiTags('console')
@ApiBearerAuth('jwt')
@UseGuards(ConsoleGuard)
// 记录系统: `@Audit(...)` member mutations emit an audit_log row (actor = req.console member).
@UseInterceptors(AuditInterceptor)
@Controller('console')
export class ConsoleController {
  constructor(
    private readonly console: ConsoleService,
    private readonly filesService: FilesService,
    @Inject(ENV) private readonly env: AppEnv,
  ) {}

  @Post('api-keys')
  @HttpCode(201)
  @UseGuards(TenantAdminGuard)
  @ApiOperation({ summary: 'Mint an API key for your tenant (plaintext returned once)' })
  @Audit({
    action: 'api_key.create',
    target: 'api_key',
    // NEVER record the plaintext — only the id + the bound subject (if any).
    resolve: ({ result, body }) => ({
      targetId: (result as { id?: string }).id ?? null,
      subjectId: (body as { subjectId?: string }).subjectId ?? null,
    }),
  })
  async createApiKey(
    @Body(new ZodBody(consoleCreateApiKeySchema)) dto: ConsoleCreateApiKeyDto,
    @Req() req: ConsoleRequest,
  ): Promise<ApiKeyCreatedView> {
    const ctx = ctxOf(req);
    const created = await this.console.createApiKey(dto, ctx.tenantId);
    return { id: created.id, plaintext: created.plaintext };
  }

  @Get('api-keys')
  @ApiOperation({ summary: 'List your tenant API keys (no hashes, paginated)' })
  async listApiKeys(
    @Req() req: ConsoleRequest,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageEnvelope<ApiKeyView>> {
    const ctx = ctxOf(req);
    const result = await this.console.listApiKeys(ctx.tenantId, toPageParams({ cursor, limit }));
    return mapPageEnvelope(result, (r) => r.id, toApiKeyView);
  }

  @Post('api-keys/:id/rotate')
  @HttpCode(201)
  @UseGuards(TenantAdminGuard)
  @ApiOperation({ summary: 'Rotate an API key (new plaintext; old key disabled)' })
  @Audit({
    action: 'api_key.rotate',
    target: 'api_key',
    resolve: ({ params, result }) => ({
      targetId: params.id ?? null,
      meta: { newKeyId: (result as { id?: string }).id },
    }),
  })
  async rotateApiKey(
    @Param('id') id: string,
    @Req() req: ConsoleRequest,
  ): Promise<ApiKeyCreatedView> {
    const ctx = ctxOf(req);
    const created = await this.console.rotateApiKey(id, ctx.tenantId);
    return { id: created.id, plaintext: created.plaintext };
  }

  @Delete('api-keys/:id')
  @HttpCode(200)
  @UseGuards(TenantAdminGuard)
  @ApiOperation({ summary: 'Disable one of your API keys' })
  @Audit({
    action: 'api_key.disable',
    target: 'api_key',
    resolve: ({ params }) => ({ targetId: params.id ?? null }),
  })
  async disableApiKey(
    @Param('id') id: string,
    @Req() req: ConsoleRequest,
  ): Promise<{ id: string; status: 'disabled' }> {
    const ctx = ctxOf(req);
    await this.console.disableApiKey(id, ctx.tenantId);
    return { id, status: 'disabled' };
  }

  /**
   * Your tenant's jobs AND ledger in ONE response. Since the two are independent
   * keysets, each gets its OWN envelope under `jobs`/`ledger`, paged by its own
   * cursor query param (`jobs_cursor` / `ledger_cursor`) with a shared `limit`.
   * A single shared cursor cannot drive two distinct keysets, so they are split.
   */
  @Get('usage')
  @ApiOperation({ summary: 'Your tenant jobs + ledger (two keyset envelopes)' })
  async usage(
    @Req() req: ConsoleRequest,
    @Query('jobs_cursor') jobsCursor?: string,
    @Query('ledger_cursor') ledgerCursor?: string,
    @Query('limit') limit?: string,
  ): Promise<{ jobs: PageEnvelope<JobView>; ledger: PageEnvelope<LedgerView> }> {
    const ctx = ctxOf(req);
    const jobs = await this.console.listJobs(
      ctx.tenantId,
      toPageParams({ cursor: jobsCursor, limit }),
    );
    const ledger = await this.console.listLedger(
      ctx.tenantId,
      toPageParams({ cursor: ledgerCursor, limit }),
    );
    return {
      jobs: mapPageEnvelope(jobs, (j) => j.id, toConsoleJobView),
      ledger: mapPageEnvelope(ledger, (l) => l.id, toConsoleLedgerView),
    };
  }

  @Get('analytics/usage')
  @ApiOperation({ summary: 'Your tenant usage rollups (by day/model/channel/api-key)' })
  async analyticsUsage(
    @Req() req: ConsoleRequest,
    @Query() raw: Record<string, string>,
  ): Promise<ConsoleUsageRollupView[]> {
    const ctx = ctxOf(req);
    const q = parseConsoleAnalyticsUsage(raw);
    const rows = await this.console.analyticsUsage(ctx.tenantId, q);
    return rows.map(toConsoleUsageRollupView);
  }

  @Get('usage-log')
  @ApiOperation({ summary: 'Your tenant per-call usage log (keyset, newest-first)' })
  async usageLog(
    @Req() req: ConsoleRequest,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageEnvelope<UsageLogView>> {
    const ctx = ctxOf(req);
    const result = await this.console.listUsageLog(ctx.tenantId, toPageParams({ cursor, limit }));
    return mapPageEnvelope(result, (r) => r.id, toUsageLogView);
  }

  @Get('files')
  @ApiOperation({
    summary: 'Your tenant media files (asset gallery; ready files only, keyset, newest-first)',
  })
  async files(
    @Req() req: ConsoleRequest,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('kind') kind?: string,
  ): Promise<PageEnvelope<FileView>> {
    const ctx = ctxOf(req);
    const filter: { kind?: 'image' | 'video' | 'audio' } = {};
    if (kind === 'image' || kind === 'video' || kind === 'audio') filter.kind = kind;
    const result = await this.console.listFiles(
      ctx.tenantId,
      filter,
      toPageParams({ cursor, limit }),
    );
    const base = this.env.STORAGE_PUBLIC_BASE_URL;
    return mapPageEnvelope(
      result,
      (r) => r.id,
      (r) => toConsoleFileView(r, base),
    );
  }

  /**
   * Presign a tenant upload (gallery → upload assets). Reuses the data-plane
   * {@link FilesService} with a tenant context derived from the JWT, so the
   * tenant scope is the guard's, never a body field.
   */
  @Post('files/presign-upload')
  @HttpCode(200)
  @UseGuards(TenantAdminGuard)
  @ApiOperation({ summary: 'Presign a file upload for your tenant (returns a PUT URL + file_id)' })
  async presignUpload(
    @Body(new ZodBody(presignUploadSchema)) dto: PresignUploadDto,
    @Req() req: ConsoleRequest,
  ): Promise<PresignUploadResult> {
    const ctx = ctxOf(req);
    return this.filesService.presignUpload(dto, {
      tenantId: ctx.tenantId,
      accountId: ctx.accountId,
    });
  }

  @Post('files/:id/confirm')
  @HttpCode(200)
  @UseGuards(TenantAdminGuard)
  @ApiOperation({ summary: 'Confirm an uploaded file (head → ready)' })
  async confirmFile(@Param('id') id: string, @Req() req: ConsoleRequest): Promise<FilesFileView> {
    const ctx = ctxOf(req);
    return this.filesService.confirm(id, { tenantId: ctx.tenantId, accountId: ctx.accountId });
  }

  @Get('balance')
  @ApiOperation({ summary: 'Your tenant credit balance + held (µcredit decimal strings)' })
  async balance(@Req() req: ConsoleRequest): Promise<BalanceView> {
    const ctx = ctxOf(req);
    const account = await this.console.balance(ctx.accountId);
    return consoleBalanceViewSchema.parse({
      balance: account.creditBalance.toString(),
      held: account.creditHeld.toString(),
    });
  }

  @Get('payments')
  @ApiOperation({ summary: 'Your tenant payment-intent (topup) history (keyset, newest-first)' })
  async payments(
    @Req() req: ConsoleRequest,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageEnvelope<PaymentIntentView>> {
    const ctx = ctxOf(req);
    const result = await this.console.listPayments(ctx.tenantId, toPageParams({ cursor, limit }));
    return mapPageEnvelope(result, (r) => r.id, toPaymentIntentView);
  }

  @Get('payments/intents/:id')
  @ApiOperation({ summary: 'Status of one of your payment intents (poll after a topup)' })
  async paymentIntent(
    @Param('id') id: string,
    @Req() req: ConsoleRequest,
  ): Promise<PaymentIntentView> {
    const ctx = ctxOf(req);
    return toPaymentIntentView(await this.console.getPaymentIntent(ctx.tenantId, id));
  }

  /**
   * Models visible to your tenant, in the uniform envelope. The visible-models
   * port returns the full visibility-filtered set (small, public + granted), so
   * this is a single non-cursored page: `has_more` is always `false` and
   * `next_cursor` is always `null` (the set is bounded by the catalog size).
   */
  @Get('models')
  @ApiOperation({ summary: 'Models visible to your tenant (single-page envelope)' })
  async models(@Req() req: ConsoleRequest): Promise<PageEnvelope<ModelListItem>> {
    const ctx = ctxOf(req);
    const rows: ModelView[] = await this.console.listModels(ctx.tenantId);
    return {
      data: rows.map((m) =>
        consoleModelViewSchema.parse({
          name: m.name,
          display: m.display,
          modality: m.modality,
          capabilities: m.capabilities,
          visibility: m.visibility,
          tags: m.tags,
          maker: m.maker,
          context_length: m.contextLength,
          reasoning: m.reasoning,
        }),
      ),
      next_cursor: null,
      has_more: false,
    };
  }

  @Post('payments/intents')
  @HttpCode(201)
  @UseGuards(TenantAdminGuard)
  @ApiOperation({ summary: 'Top up your tenant (returns a checkout handle)' })
  @Audit({
    action: 'payment.intent_create',
    target: 'payment',
    resolve: ({ result, body }) => {
      const b = body as { amount_minor?: string; currency?: string; provider?: string };
      return {
        targetId: (result as { intent_id?: string }).intent_id ?? null,
        meta: { amount_minor: b.amount_minor, currency: b.currency, provider: b.provider },
      };
    },
  })
  async topup(
    @Body(new ZodBody(consoleCreateIntentSchema)) dto: ConsoleCreateIntentDto,
    @Req() req: ConsoleRequest,
  ): Promise<ConsoleCreateIntentResponse> {
    const ctx = ctxOf(req);
    return this.console.selfTopup(dto, ctx.tenantId);
  }

  @Get('limits')
  @ApiOperation({
    summary: 'Your tenant governance status: bound plan, usage-vs-cap, recent alerts',
  })
  async limits(@Req() req: ConsoleRequest): Promise<ConsoleLimitStatusView> {
    const ctx = ctxOf(req);
    const status = await this.console.limitStatus(ctx.tenantId);
    return consoleLimitStatusViewSchema.parse({
      plan: status.plan,
      rules: status.rules.map((r) => ({
        dimension: r.dimension,
        period: r.period,
        cap: r.cap.toString(),
        used: r.used.toString(),
        model_scope: r.modelScope,
        alert_pct: r.alertPct,
        enforce: r.enforce,
      })),
      alerts: status.alerts.map((a) => ({
        dimension: a.dimension,
        period_key: a.periodKey,
        used: a.used.toString(),
        cap: a.cap.toString(),
        pct: a.pct,
        created_at: a.createdAt.toISOString(),
      })),
    });
  }

  @Get('me')
  @ApiOperation({ summary: 'Your own profile (no password hash)' })
  async me(@Req() req: ConsoleRequest): Promise<MeView> {
    const ctx = ctxOf(req);
    return toMeView(await this.console.me(ctx.userId));
  }

  @Patch('settings')
  @ApiOperation({ summary: 'Change your password (verifies the current one)' })
  // Records the ACTION only — never the password (no resolver meta).
  @Audit({ action: 'user.change_password', target: 'user' })
  async changePassword(
    @Body(new ZodBody(consoleChangePasswordSchema)) dto: ConsoleChangePasswordDto,
    @Req() req: ConsoleRequest,
  ): Promise<{ ok: true }> {
    const ctx = ctxOf(req);
    await this.console.changePassword(ctx.userId, dto);
    return { ok: true };
  }

  // ----- tenant subjects (end-users; unified tenancy G-A, console plane) -----

  /**
   * Create an end-user (subject) under YOUR tenant. The tenant is the guard's,
   * never a body field — a console admin can only ever add end-users to its own
   * app. Mirrors `POST /admin/tenants/:id/users`, tenant-admin-gated + scoped.
   */
  @Post('subjects')
  @HttpCode(201)
  @UseGuards(TenantAdminGuard)
  @ApiOperation({ summary: 'Create an end-user (subject) under your tenant' })
  @Audit({
    action: 'subject.create',
    target: 'subject',
    resolve: ({ result }) => {
      const r = result as { id?: string };
      return { subjectId: r.id ?? null, targetId: r.id ?? null };
    },
  })
  async createSubject(
    @Body(new ZodBody(createSubjectSchema)) dto: CreateSubjectBody,
    @Req() req: ConsoleRequest,
  ): Promise<SubjectView> {
    const ctx = ctxOf(req);
    return toSubjectView(await this.console.createSubject(ctx.tenantId, dto));
  }

  @Get('subjects')
  @UseGuards(TenantAdminGuard)
  @ApiOperation({ summary: "List your tenant's end-users (subjects; keyset, newest-first)" })
  async listSubjects(
    @Req() req: ConsoleRequest,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageEnvelope<SubjectView>> {
    const ctx = ctxOf(req);
    const result = await this.console.listSubjects(ctx.tenantId, toPageParams({ cursor, limit }));
    return mapPageEnvelope(result, (r) => r.id, toSubjectView);
  }

  @Get('subjects/:id')
  @UseGuards(TenantAdminGuard)
  @ApiOperation({ summary: 'Get one of your end-users by id (tenant-scoped) or 404' })
  async getSubject(@Param('id') id: string, @Req() req: ConsoleRequest): Promise<SubjectView> {
    const ctx = ctxOf(req);
    return toSubjectView(await this.console.getSubject(ctx.tenantId, id));
  }

  @Patch('subjects/:id')
  @UseGuards(TenantAdminGuard)
  @ApiOperation({ summary: 'Update an end-user (display name / status / plan / email)' })
  @Audit({
    action: 'subject.update',
    target: 'subject',
    resolve: ({ params, body }) => ({
      subjectId: params.id ?? null,
      targetId: params.id ?? null,
      meta: { ...(body as Record<string, unknown>) },
    }),
  })
  async patchSubject(
    @Param('id') id: string,
    @Body(new ZodBody(updateSubjectSchema)) dto: UpdateSubjectBody,
    @Req() req: ConsoleRequest,
  ): Promise<SubjectView> {
    const ctx = ctxOf(req);
    return toSubjectView(await this.console.updateSubject(ctx.tenantId, id, dto));
  }

  /**
   * Soft-delete an end-user (frees its external_id/email) + cascade: sweep its
   * sub-wallet back to the tenant pool, disable its subject-scoped keys
   * ([[records-system-v1]] R3). Scoped to your tenant (a cross-tenant id → 404).
   */
  @Delete('subjects/:id')
  @HttpCode(200)
  @UseGuards(TenantAdminGuard)
  @ApiOperation({ summary: 'Soft-delete an end-user (cascade: sweep sub-wallet, disable keys)' })
  @Audit({
    action: 'subject.delete',
    target: 'subject',
    resolve: ({ params, req }) => ({
      subjectId: params.id ?? null,
      targetId: params.id ?? null,
      meta: (req as { auditMeta?: Record<string, unknown> }).auditMeta,
    }),
  })
  async deleteSubject(
    @Param('id') id: string,
    @Req() req: ConsoleRequest,
  ): Promise<{ id: string; status: 'deleted' }> {
    const ctx = ctxOf(req);
    const cascade = await this.console.deleteSubject(ctx.tenantId, id);
    // Stash the cascade summary so the audit interceptor records it as meta.
    (req as ConsoleRequest & { auditMeta?: Record<string, unknown> }).auditMeta = {
      sweptMicro: cascade.sweptMicro.toString(),
      disabledKeys: cascade.disabledKeys,
    };
    return { id, status: 'deleted' };
  }

  // ----- subject sub-wallets (HARD mode; console plane, tenant-admin-only) -----

  /**
   * Open a HARD sub-wallet for one of YOUR tenant's subjects (optional opening
   * balance in credits). The subject is validated to belong to your tenant first
   * (a cross-tenant id → 404). Mirrors the `/admin` open handler, tenant-scoped.
   */
  @Post('subjects/:id/sub-account/open')
  @HttpCode(201)
  @UseGuards(TenantAdminGuard)
  @ApiOperation({
    summary: 'Open a HARD sub-wallet for one of your subjects (optional opening balance)',
  })
  @Audit({
    action: 'sub_account.open',
    target: 'sub_account',
    resolve: ({ params, result, body }) => {
      const r = result as { id?: string };
      return {
        subjectId: params.id ?? null,
        targetId: r.id ?? null,
        meta: { ...(body as Record<string, unknown>) },
      };
    },
  })
  async openSubAccount(
    @Param('id') id: string,
    @Body(new ZodBody(createSubAccountSchema)) dto: CreateSubAccountBody,
    @Req() req: ConsoleRequest,
  ): Promise<SubAccountView> {
    const ctx = ctxOf(req);
    return toSubAccountView(await this.console.createSubAccount(ctx.tenantId, id, dto));
  }

  @Get('subjects/:id/sub-account')
  @UseGuards(TenantAdminGuard)
  @ApiOperation({ summary: "Get one of your subjects' sub-wallet (balance/held) or 404" })
  async getSubAccount(
    @Param('id') id: string,
    @Req() req: ConsoleRequest,
  ): Promise<SubAccountView> {
    const ctx = ctxOf(req);
    return toSubAccountView(await this.console.getSubAccount(ctx.tenantId, id));
  }

  /**
   * Credit a subject's sub-wallet — an INTERNAL allocation to the subject's HARD
   * wallet (credits → µcredits), not a payment. Tenant-scoped (cross-tenant → 404).
   */
  @Post('subjects/:id/sub-account/topup')
  @HttpCode(200)
  @UseGuards(TenantAdminGuard)
  @ApiOperation({ summary: "Credit one of your subjects' sub-wallet (internal allocation)" })
  @Audit({
    action: 'sub_account.topup',
    target: 'sub_account',
    resolve: ({ params, body }) => ({
      subjectId: params.id ?? null,
      targetId: params.id ?? null,
      meta: { ...(body as Record<string, unknown>) },
    }),
  })
  async topupSubAccount(
    @Param('id') id: string,
    @Body(new ZodBody(topupSubAccountSchema)) dto: TopupSubAccountBody,
    @Req() req: ConsoleRequest,
  ): Promise<SubAccountView> {
    const ctx = ctxOf(req);
    await this.console.topupSubAccount(ctx.tenantId, id, dto);
    return toSubAccountView(await this.console.getSubAccount(ctx.tenantId, id));
  }

  /**
   * Transfer credits between your tenant pool and a subject's sub-wallet
   * (`to_subject`/`to_tenant`). Tenant-scoped (cross-tenant → 404).
   */
  @Post('subjects/:id/sub-account/transfer')
  @HttpCode(200)
  @UseGuards(TenantAdminGuard)
  @ApiOperation({ summary: 'Transfer credits between your tenant pool and a subject sub-wallet' })
  @Audit({
    action: 'sub_account.transfer',
    target: 'sub_account',
    resolve: ({ params, body }) => ({
      subjectId: params.id ?? null,
      targetId: params.id ?? null,
      meta: { ...(body as Record<string, unknown>) },
    }),
  })
  async transferSubAccount(
    @Param('id') id: string,
    @Body(new ZodBody(transferCreditsSchema)) dto: TransferCreditsBody,
    @Req() req: ConsoleRequest,
  ): Promise<SubAccountView> {
    const ctx = ctxOf(req);
    await this.console.transferCredits(ctx.tenantId, id, dto);
    return toSubAccountView(await this.console.getSubAccount(ctx.tenantId, id));
  }

  // ----- tenant-owned limit plans (额度套餐; end-user data plane) -----

  /**
   * List YOUR tenant's own 额度套餐 (plans) — never platform plans, never another
   * tenant's. Each carries its rules + binding counts. Admin-only at the route.
   */
  @Get('limit-plans')
  @UseGuards(TenantAdminGuard)
  @ApiOperation({
    summary: "List your tenant's limit plans (额度套餐) with rules + binding counts",
  })
  async listLimitPlans(@Req() req: ConsoleRequest): Promise<LimitPlanView[]> {
    const ctx = ctxOf(req);
    return (await this.console.listLimitPlans(ctx.tenantId)).map(toLimitPlanView);
  }

  /**
   * Create a tenant-owned plan (+ rules). The `tenant_id` is FORCED to your tenant
   * by the service — never a body field. Mirrors `POST /admin/limit-plans`,
   * tenant-admin-gated + tenant-scoped.
   */
  @Post('limit-plans')
  @HttpCode(201)
  @UseGuards(TenantAdminGuard)
  @ApiOperation({ summary: 'Create a limit plan (额度套餐) for your tenant (+ rules)' })
  @Audit({
    action: 'limit_plan.create',
    target: 'limit_plan',
    resolve: ({ result }) => {
      const r = result as { id?: string; name?: string };
      return { targetId: r.id ?? null, meta: { name: r.name } };
    },
  })
  async createLimitPlan(
    @Body(new ZodBody(createLimitPlanRequestSchema)) dto: ConsoleCreateLimitPlanDto,
    @Req() req: ConsoleRequest,
  ): Promise<LimitPlanView> {
    const ctx = ctxOf(req);
    return toLimitPlanView(await this.console.createLimitPlan(ctx.tenantId, dto));
  }

  @Get('limit-plans/:id')
  @UseGuards(TenantAdminGuard)
  @ApiOperation({ summary: 'Get one of your tenant limit plans (+ rules) by id or 404' })
  async getLimitPlan(@Param('id') id: string, @Req() req: ConsoleRequest): Promise<LimitPlanView> {
    const ctx = ctxOf(req);
    return toLimitPlanView(await this.console.getLimitPlan(ctx.tenantId, id));
  }

  @Patch('limit-plans/:id')
  @UseGuards(TenantAdminGuard)
  @ApiOperation({ summary: 'Update a tenant limit plan; a present `rules` REPLACES the rule set' })
  @Audit({
    action: 'limit_plan.update',
    target: 'limit_plan',
    resolve: ({ params, body }) => {
      const b = body as { name?: string; status?: string; rules?: unknown[] };
      return {
        targetId: params.id ?? null,
        meta: { name: b.name, status: b.status, ruleCount: b.rules?.length },
      };
    },
  })
  async updateLimitPlan(
    @Param('id') id: string,
    @Body(new ZodBody(updateLimitPlanRequestSchema)) dto: ConsoleUpdateLimitPlanDto,
    @Req() req: ConsoleRequest,
  ): Promise<LimitPlanView> {
    const ctx = ctxOf(req);
    return toLimitPlanView(await this.console.updateLimitPlan(ctx.tenantId, id, dto));
  }

  @Delete('limit-plans/:id')
  @HttpCode(204)
  @UseGuards(TenantAdminGuard)
  @ApiOperation({ summary: 'Soft-delete one of your tenant limit plans (cross-tenant id → 404)' })
  @Audit({
    action: 'limit_plan.delete',
    target: 'limit_plan',
    resolve: ({ params }) => ({ targetId: params.id ?? null }),
  })
  async deleteLimitPlan(@Param('id') id: string, @Req() req: ConsoleRequest): Promise<void> {
    const ctx = ctxOf(req);
    await this.console.deleteLimitPlan(ctx.tenantId, id);
  }

  /**
   * Bind/unbind one of YOUR subjects to one of YOUR plans (`planId` null clears).
   * Both the subject AND the plan are intersected with your tenant scope first —
   * a cross-tenant subject OR a plan you don't own (incl. a platform plan) → 404.
   */
  @Post('subjects/:id/limit-plan')
  @HttpCode(200)
  @UseGuards(TenantAdminGuard)
  @ApiOperation({ summary: "Bind/unbind a subject's limit plan (planId null = clear)" })
  @Audit({
    action: 'subject.limit_plan_bind',
    target: 'subject',
    resolve: ({ params, body }) => ({
      subjectId: params.id ?? null,
      targetId: params.id ?? null,
      meta: { planId: (body as { planId?: string | null }).planId },
    }),
  })
  async setSubjectLimitPlan(
    @Param('id') id: string,
    @Body(new ZodBody(setLimitPlanRequestSchema)) dto: ConsoleSetLimitPlanDto,
    @Req() req: ConsoleRequest,
  ): Promise<{ ok: true }> {
    const ctx = ctxOf(req);
    await this.console.setSubjectLimitPlan(ctx.tenantId, id, dto.planId);
    return { ok: true };
  }

  @Get('subjects/:id/limit-status')
  @UseGuards(TenantAdminGuard)
  @ApiOperation({
    summary: "An end-user's effective rules paired with current usage (usage-vs-cap bars)",
  })
  async subjectLimitStatus(
    @Param('id') id: string,
    @Req() req: ConsoleRequest,
  ): Promise<LimitRuleStatusView[]> {
    const ctx = ctxOf(req);
    const rows = await this.console.subjectLimitStatus(ctx.tenantId, id);
    return rows.map((r) =>
      limitRuleStatusViewSchema.parse({
        dimension: r.dimension,
        period: r.period,
        cap: r.cap.toString(),
        used: r.used.toString(),
        model_scope: r.modelScope,
        alert_pct: r.alertPct,
        enforce: r.enforce,
      }),
    );
  }

  // ----- sub-users (rbac, tenant-admin-only) -----

  @Post('users')
  @HttpCode(201)
  @UseGuards(TenantAdminGuard)
  @ApiOperation({ summary: 'Create a sub-user (tenant member) under your tenant' })
  @Audit({
    action: 'user.create',
    target: 'user',
    // NEVER record the password — only the new user id + email.
    resolve: ({ result, body }) => ({
      targetId: (result as { id?: string }).id ?? null,
      meta: { email: (body as { email?: string }).email },
    }),
  })
  async createUser(
    @Body(new ZodBody(consoleCreateUserSchema)) dto: ConsoleCreateUserBody,
    @Req() req: ConsoleRequest,
  ): Promise<{ id: string; email: string }> {
    const ctx = ctxOf(req);
    const u = await this.console.inviteSubUser(ctx.tenantId, dto.email, dto.password);
    return { id: u.id, email: u.email };
  }

  @Get('users')
  @UseGuards(TenantAdminGuard)
  @ApiOperation({ summary: 'List your tenant users (admin only)' })
  async listUsers(
    @Req() req: ConsoleRequest,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageEnvelope<ConsoleUserView>> {
    const ctx = ctxOf(req);
    const result = await this.console.listUsers(ctx.tenantId, toPageParams({ cursor, limit }));
    return mapPageEnvelope(result, (r) => r.id, toConsoleUserView);
  }

  @Patch('users/:id')
  @UseGuards(TenantAdminGuard)
  @ApiOperation({ summary: 'Update a sub-user (status / tenant role)' })
  @Audit({
    action: 'user.update',
    target: 'user',
    resolve: ({ params, body }) => ({
      targetId: params.id ?? null,
      meta: body as Record<string, unknown>,
    }),
  })
  async updateUser(
    @Param('id') id: string,
    @Body(new ZodBody(consoleUpdateUserSchema)) dto: ConsoleUpdateUserBody,
    @Req() req: ConsoleRequest,
  ): Promise<ConsoleUserView> {
    const ctx = ctxOf(req);
    return toConsoleUserView(await this.console.updateSubUser(ctx.tenantId, id, dto));
  }

  @Delete('users/:id')
  @HttpCode(200)
  @UseGuards(TenantAdminGuard)
  @ApiOperation({ summary: 'Disable a sub-user' })
  @Audit({
    action: 'user.disable',
    target: 'user',
    resolve: ({ params }) => ({ targetId: params.id ?? null }),
  })
  async disableUser(
    @Param('id') id: string,
    @Req() req: ConsoleRequest,
  ): Promise<{ id: string; status: 'disabled' }> {
    const ctx = ctxOf(req);
    await this.console.updateSubUser(ctx.tenantId, id, { status: 'disabled' });
    return { id, status: 'disabled' };
  }
}
