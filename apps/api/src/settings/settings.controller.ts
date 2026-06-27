import {
  platformSettingKeySchema,
  type PlatformSettingView,
  type UpdatePlatformSettingRequest,
  updatePlatformSettingRequestSchema,
} from '@actionow/contracts';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AdminGuard, type AdminRequest } from '../admin/auth/admin.guard.js';
import { Roles } from '../admin/auth/roles.decorator.js';
import { Audit } from '../audit/audit.decorator.js';
import { AuditInterceptor } from '../audit/audit.interceptor.js';
import { engineInvalidInput } from '../common/errors.js';
import { ZodBody } from '../common/zod.pipe.js';
import { SettingsService } from './settings.service.js';

/**
 * `/admin/settings` — operator dynamic-config (动态配置). Lists the effective
 * value + source of each tunable setting, and overrides/resets them at runtime
 * (effective within ~10s across replicas; immediate in the writing replica).
 * Admin-only; writes are audited. Bootstrap/secret env is NOT exposed here.
 */
@ApiTags('admin')
@ApiBearerAuth('jwt')
@UseGuards(AdminGuard)
@Roles('admin')
@UseInterceptors(AuditInterceptor)
@Controller('admin/settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @ApiOperation({ summary: 'List effective platform settings (动态配置) with source + defaults' })
  list(): Promise<PlatformSettingView[]> {
    return this.settings.list();
  }

  @Put(':key')
  @Audit({
    action: 'platform_setting.update',
    target: 'platform_setting',
    resolve: ({ params, body }) => ({
      targetId: params.key,
      meta: { value: (body as { value?: unknown }).value },
    }),
  })
  @ApiOperation({ summary: 'Override one platform setting' })
  set(
    @Param('key') key: string,
    @Body(new ZodBody(updatePlatformSettingRequestSchema)) dto: UpdatePlatformSettingRequest,
    @Req() req: AdminRequest,
  ): Promise<PlatformSettingView> {
    const parsed = platformSettingKeySchema.safeParse(key);
    if (!parsed.success) throw engineInvalidInput(`unknown setting key: ${key}`);
    return this.settings.set(parsed.data, dto.value, req.admin?.adminId ?? null);
  }

  @Delete(':key')
  @Audit({
    action: 'platform_setting.reset',
    target: 'platform_setting',
    resolve: ({ params }) => ({ targetId: params.key }),
  })
  @ApiOperation({ summary: 'Reset one platform setting to its env/code default' })
  reset(@Param('key') key: string): Promise<PlatformSettingView> {
    const parsed = platformSettingKeySchema.safeParse(key);
    if (!parsed.success) throw engineInvalidInput(`unknown setting key: ${key}`);
    return this.settings.reset(parsed.data);
  }
}
