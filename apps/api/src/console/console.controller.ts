import {
  type ConsoleApiKeyView,
  consoleApiKeyViewSchema,
  type ConsoleBalanceView,
  consoleBalanceViewSchema,
  type ConsoleFileView,
  consoleFileViewSchema,
  type ConsoleJobView,
  consoleJobViewSchema,
  type ConsoleLedgerView,
  consoleLedgerViewSchema,
  type ConsoleMeView,
  consoleMeViewSchema,
  type ConsoleModelView,
  consoleModelViewSchema,
  type ConsolePaymentView,
  consolePaymentViewSchema,
  type ConsoleUsageLogView,
  consoleUsageLogViewSchema,
  type ConsoleUsageRollupView,
  consoleUsageRollupViewSchema,
} from '@actionow/contracts';
import type {
  ApiKeyRow,
  FileObject,
  Job,
  LedgerRow,
  PaymentIntentRow,
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
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { engineInvalidInput, engineUnauthorized } from '../common/errors.js';
import { mapPageEnvelope, type PageEnvelope, toPageParams } from '../common/pagination.js';
import { ENV } from '../common/tokens.js';
import { ZodBody } from '../common/zod.pipe.js';
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
} from './dto/console.dto.js';
import type { ModelView } from './models.port.js';

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

/** Project a tenant api-key row to its console view (no hash). */
function toApiKeyView(r: Omit<ApiKeyRow, 'hash'>): ApiKeyView {
  return consoleApiKeyViewSchema.parse({
    id: r.id,
    resource_allowlist: r.resourceAllowlist,
    rate_limit: r.rateLimit,
    status: r.status,
    created_at: r.createdAt.toISOString(),
  });
}

/** Project a job row to the console job view (money as decimal strings). */
function toConsoleJobView(j: Job): JobView {
  return consoleJobViewSchema.parse({
    job_id: j.id,
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
  });
}

/** Project a usage-log row to the console view (tenant implicit; cost decimal string). */
function toUsageLogView(row: UsageLogRow): UsageLogView {
  return consoleUsageLogViewSchema.parse({
    id: row.id,
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
@Controller('console')
export class ConsoleController {
  constructor(
    private readonly console: ConsoleService,
    @Inject(ENV) private readonly env: AppEnv,
  ) {}

  @Post('api-keys')
  @HttpCode(201)
  @ApiOperation({ summary: 'Mint an API key for your tenant (plaintext returned once)' })
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
  @ApiOperation({ summary: 'Rotate an API key (new plaintext; old key disabled)' })
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
  @ApiOperation({ summary: 'Disable one of your API keys' })
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
        }),
      ),
      next_cursor: null,
      has_more: false,
    };
  }

  @Post('payments/intents')
  @HttpCode(201)
  @ApiOperation({ summary: 'Top up your tenant (returns a checkout handle)' })
  async topup(
    @Body(new ZodBody(consoleCreateIntentSchema)) dto: ConsoleCreateIntentDto,
    @Req() req: ConsoleRequest,
  ): Promise<ConsoleCreateIntentResponse> {
    const ctx = ctxOf(req);
    return this.console.selfTopup(dto, ctx.tenantId);
  }

  @Get('me')
  @ApiOperation({ summary: 'Your own profile (no password hash)' })
  async me(@Req() req: ConsoleRequest): Promise<MeView> {
    const ctx = ctxOf(req);
    return toMeView(await this.console.me(ctx.userId));
  }

  @Patch('settings')
  @ApiOperation({ summary: 'Change your password (verifies the current one)' })
  async changePassword(
    @Body(new ZodBody(consoleChangePasswordSchema)) dto: ConsoleChangePasswordDto,
    @Req() req: ConsoleRequest,
  ): Promise<{ ok: true }> {
    const ctx = ctxOf(req);
    await this.console.changePassword(ctx.userId, dto);
    return { ok: true };
  }
}
