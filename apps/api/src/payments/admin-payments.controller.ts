import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AdminGuard } from '../admin/auth/admin.guard.js';
import { Roles } from '../admin/auth/roles.decorator.js';
import { type PageEnvelope, toPageParams } from '../common/pagination.js';
import type { PaymentIntentView } from './payments.service.js';
import { PaymentsService } from './payments.service.js';

/**
 * Admin view of payment intents (Phase 10). Guarded by the admin JWT + `admin`
 * role, mirroring the rest of the `/admin` surface. Lists a tenant's intents
 * newest-first in the uniform pagination envelope; money serializes as decimal
 * strings (never a float).
 */
@ApiTags('admin')
@ApiBearerAuth('jwt')
@UseGuards(AdminGuard)
@Roles('admin')
@Controller('admin/payments')
export class AdminPaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  @ApiOperation({ summary: 'List a tenant’s payment intents (paginated)' })
  async list(
    @Query('tenantId') tenantId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageEnvelope<PaymentIntentView>> {
    return this.payments.listIntents(tenantId, toPageParams({ cursor, limit }));
  }
}
