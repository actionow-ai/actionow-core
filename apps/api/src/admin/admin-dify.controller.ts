import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ZodBody } from '../common/zod.pipe.js';
import { AdminDifyService } from './admin-dify.service.js';
import { AdminGuard } from './auth/admin.guard.js';
import { Roles } from './auth/roles.decorator.js';
import { type DifyImportDto, difyImportSchema } from './dto/admin.dto.js';

/** The `POST /admin/dify/import` response: the registered resource's schema. */
interface DifyImportView {
  resource_id: string;
  version: number;
  io_schema: { inputs: unknown[]; outputs: unknown[] };
  compat_report: { items: unknown[]; has_blockers: boolean };
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
@Controller('admin/dify')
export class AdminDifyController {
  constructor(private readonly dify: AdminDifyService) {}

  @Post('import')
  @HttpCode(200)
  @ApiOperation({ summary: 'Register a BYO Dify workflow → returns io_schema' })
  async import(@Body(new ZodBody(difyImportSchema)) dto: DifyImportDto): Promise<DifyImportView> {
    const result = await this.dify.import(dto);
    return {
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
    };
  }
}
