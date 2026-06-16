import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AdminGuard } from '../admin/auth/admin.guard.js';
import { Roles } from '../admin/auth/roles.decorator.js';
import type { PaymentIntentView } from './payments.service.js';
import { PaymentsService } from './payments.service.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Clamp a `limit` query param to `[1, MAX_LIMIT]`, defaulting when absent/NaN. */
function parseLimit(limit: string | undefined): number {
  const parsed = limit === undefined ? DEFAULT_LIMIT : Number.parseInt(limit, 10);
  return Number.isNaN(parsed) ? DEFAULT_LIMIT : Math.min(Math.max(1, parsed), MAX_LIMIT);
}

/**
 * Admin view of payment intents (Phase 10). Guarded by the admin JWT + `admin`
 * role, mirroring the rest of the `/admin` surface. Lists a tenant's intents
 * newest-first; money serializes as decimal strings (never a float).
 */
@ApiTags('admin')
@ApiBearerAuth('jwt')
@UseGuards(AdminGuard)
@Roles('admin')
@Controller('admin/payments')
export class AdminPaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  @ApiOperation({ summary: 'List a tenant’s payment intents' })
  async list(
    @Query('tenantId') tenantId: string,
    @Query('limit') limit?: string,
  ): Promise<{ intents: PaymentIntentView[] }> {
    const intents = await this.payments.listIntents(tenantId, parseLimit(limit));
    return { intents };
  }
}
