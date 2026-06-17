import type { ApiKeyRow, Job, LedgerRow } from '@actionow/db';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { engineUnauthorized } from '../common/errors.js';
import { mapPageEnvelope, type PageEnvelope, toPageParams } from '../common/pagination.js';
import { ZodBody } from '../common/zod.pipe.js';
import { type ConsoleContext, ConsoleGuard, type ConsoleRequest } from './console.guard.js';
import type { ConsoleCreateIntentResponse } from './console.service.js';
import { ConsoleService } from './console.service.js';
import {
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
interface ApiKeyView {
  id: string;
  resource_allowlist: string[];
  rate_limit: number | null;
  status: string;
  created_at: string;
}
interface JobView {
  job_id: string;
  resource_id: string;
  status: string;
  exec_mode: string;
  cost: string | null;
  created_at: string;
}
interface LedgerView {
  id: string;
  type: string;
  credits_delta: string;
  balance_after: string;
  job_id: string | null;
  created_at: string;
}
interface ModelListItem {
  name: string;
  display: string;
  modality: string;
  capabilities: unknown;
  visibility: string;
}

/** Project a tenant api-key row to its console view (no hash). */
function toApiKeyView(r: Omit<ApiKeyRow, 'hash'>): ApiKeyView {
  return {
    id: r.id,
    resource_allowlist: r.resourceAllowlist,
    rate_limit: r.rateLimit,
    status: r.status,
    created_at: r.createdAt.toISOString(),
  };
}

/** Project a job row to the console job view (money as decimal strings). */
function toConsoleJobView(j: Job): JobView {
  return {
    job_id: j.id,
    resource_id: j.resourceId,
    status: j.status,
    exec_mode: j.execMode,
    cost: j.costCredits === null ? null : j.costCredits.toString(),
    created_at: j.createdAt.toISOString(),
  };
}

/** Project a ledger row to the console ledger view (money as decimal strings). */
function toConsoleLedgerView(l: LedgerRow): LedgerView {
  return {
    id: l.id,
    type: l.type,
    credits_delta: l.creditsDelta.toString(),
    balance_after: l.balanceAfter.toString(),
    job_id: l.jobId,
    created_at: l.createdAt.toISOString(),
  };
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
  constructor(private readonly console: ConsoleService) {}

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
      data: rows.map((m) => ({
        name: m.name,
        display: m.display,
        modality: m.modality,
        capabilities: m.capabilities,
        visibility: m.visibility,
      })),
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
}
