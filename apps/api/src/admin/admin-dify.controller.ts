import {
  type DifyBindingView,
  difyBindingViewSchema,
  type DifyImportView,
  difyImportViewSchema,
} from '@actionow/contracts';
import type { DifyBindingRow } from '@actionow/db';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { IdempotencyInterceptor } from '../common/idempotency.interceptor.js';
import { Idempotent } from '../common/idempotent.decorator.js';
import { mapPageEnvelope, type PageEnvelope, toPageParams } from '../common/pagination.js';
import { ZodBody } from '../common/zod.pipe.js';
import { AdminDifyService } from './admin-dify.service.js';
import { AdminGuard } from './auth/admin.guard.js';
import { Roles } from './auth/roles.decorator.js';
import {
  type DifyImportDto,
  difyImportSchema,
  type UpdateDifyDto,
  updateDifySchema,
} from './dto/admin.dto.js';

// DifyImportView now lives in @actionow/contracts (ops-views) — single source
// of truth shared with the frontend; on the wire `io_schema`/`compat_report`
// are free-form JSON (the contract types them `unknown`). The import() mapper
// below `.parse()`s its concrete payload against the schema.

// DifyBindingView (admin list/patch view; EXCLUDES the dsl/compat-report blobs)
// now lives in @actionow/contracts (catalog-views) — single source of truth with
// the frontend. The mapper `.parse()`s against the schema.
function toDifyBindingView(row: DifyBindingRow): DifyBindingView {
  return difyBindingViewSchema.parse({
    resource_id: row.resourceId,
    resource_version: row.resourceVersion,
    mode: row.mode,
    endpoint: row.difyAppEndpoint,
    service_key_ref: row.difyServiceKeyRef,
    pricing_model: row.pricingModel,
    provision_mode: row.provisionMode,
    created_at: row.createdAt.toISOString(),
  });
}

/**
 * `POST /admin/dify/import` (Phase 5, Task 4): register a BYO Dify workflow via
 * the engine's `DifyRegistrationService`. BYO + metered → 400 `invalid_input`
 * (`metered_not_allowed`); a blocked workflow without `allowBlockers` → 422
 * `content_filtered`. Both mappings live in {@link AdminDifyService}.
 */
@ApiTags('admin')
@ApiBearerAuth('jwt')
@UseGuards(AdminGuard)
@Roles('admin')
// Track D5: `Idempotency-Key` replay for the `@Idempotent()` import POST.
@UseInterceptors(IdempotencyInterceptor)
@Controller('admin/dify')
export class AdminDifyController {
  constructor(private readonly dify: AdminDifyService) {}

  @Post('import')
  @HttpCode(200)
  @Idempotent()
  @ApiOperation({ summary: 'Register a BYO Dify workflow → returns io_schema' })
  async import(@Body(new ZodBody(difyImportSchema)) dto: DifyImportDto): Promise<DifyImportView> {
    const result = await this.dify.import(dto);
    return difyImportViewSchema.parse({
      resource_id: result.resourceId,
      version: result.version,
      io_schema: {
        inputs: [...result.ioSchema.inputs],
        outputs: [...result.ioSchema.outputs],
      },
      compat_report: {
        items: [...result.compatReport.items],
        has_blockers: result.compatReport.hasBlockers,
      },
    });
  }

  @Get()
  @ApiOperation({ summary: 'List dify bindings (paginated)' })
  async list(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageEnvelope<DifyBindingView>> {
    const result = await this.dify.list(toPageParams({ cursor, limit }));
    return mapPageEnvelope(result, (r) => r.resourceId, toDifyBindingView);
  }

  @Patch(':resourceId')
  @ApiOperation({ summary: 'Update a dify binding (endpoint/serviceKeyRef/pricingModel)' })
  async update(
    @Param('resourceId') resourceId: string,
    @Body(new ZodBody(updateDifySchema)) dto: UpdateDifyDto,
  ): Promise<DifyBindingView> {
    return toDifyBindingView(await this.dify.update(resourceId, dto));
  }

  @Delete(':resourceId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Soft-delete a dify binding' })
  async delete(@Param('resourceId') resourceId: string): Promise<void> {
    await this.dify.delete(resourceId);
  }
}
