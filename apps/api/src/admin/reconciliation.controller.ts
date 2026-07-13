// apps/api/src/admin/reconciliation.controller.ts
//
// model-supply-greenfield 批次4 slice6 — the §9.2 reconciliation REPORT face
// (对账降级 · 判据 2.6 「报表可出即达标」): a read-only admin endpoint that
// aggregates GATEWAY settles per (UTC day, tenant, channel, offering) with
// BOTH billing sides (sale = charged µcredits, cost = the offering cost
// card's independent computation stamped at settle) and the gross margin.
//
// Usage: 中转渠道 monthly report = GET ?from=2026-07-01&to=2026-08-01 (人工
// 核对); the day granularity of the rows is ALSO the feed the 批次5 官方渠道
// daily auto-reconciliation comparer consumes (threshold: dynamic-config key
// RECONCILIATION_DEVIATION_PCT). Read-only — no @Audit (no state change), no
// idempotency (GET).
import type { ReconciliationReport, ReconciliationRow } from '@actionow/contracts';
import type { Database, ReconciliationAggregateRow } from '@actionow/db';
import { aggregateGatewayReconciliation } from '@actionow/db';
import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { engineInvalidInput } from '../common/errors.js';
import { DB } from '../common/tokens.js';
import { AdminGuard } from './auth/admin.guard.js';
import { Roles } from './auth/roles.decorator.js';

/** The db read this controller performs, injectable for unit tests. */
export interface ReconciliationQueries {
  aggregateGatewayReconciliation: typeof aggregateGatewayReconciliation;
}

@ApiTags('admin')
@ApiBearerAuth('jwt')
@UseGuards(AdminGuard)
@Roles('admin')
@Controller('admin')
export class ReconciliationController {
  private readonly queries: ReconciliationQueries = { aggregateGatewayReconciliation };

  constructor(@Inject(DB) private readonly db: Database) {}

  @Get('reconciliation/report')
  @ApiOperation({
    summary:
      'Usage-side reconciliation report (§9.2): gateway settles per (day, tenant, channel, offering) with sale/cost/margin µcredits',
  })
  async report(
    @Query('from') fromRaw?: string,
    @Query('to') toRaw?: string,
    @Query('tenant_id') tenantId?: string,
  ): Promise<ReconciliationReport> {
    const from = parseInstant(fromRaw, 'from');
    const to = parseInstant(toRaw, 'to');
    if (from.getTime() >= to.getTime()) {
      throw engineInvalidInput("'from' must be strictly before 'to'");
    }
    const rows = await this.queries.aggregateGatewayReconciliation(this.db, {
      from,
      to,
      tenantId,
    });
    return renderReport(from, to, rows);
  }
}

/** Parse `YYYY-MM-DD` / ISO instants; anything unparseable is a 400. */
function parseInstant(raw: string | undefined, name: string): Date {
  if (raw === undefined || raw.length === 0) {
    throw engineInvalidInput(`query parameter '${name}' is required (YYYY-MM-DD or ISO instant)`);
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw engineInvalidInput(`query parameter '${name}' is not a valid date: '${raw}'`);
  }
  return parsed;
}

/** Aggregate rows → the wire report (µcredit strings + totals). Exported for the unit test. */
export function renderReport(
  from: Date,
  to: Date,
  rows: ReconciliationAggregateRow[],
): ReconciliationReport {
  let settleCount = 0;
  let estimatedCount = 0;
  let costMissingCount = 0;
  let sale = 0n;
  let cost = 0n;
  const wireRows: ReconciliationRow[] = rows.map((r) => {
    settleCount += r.settleCount;
    estimatedCount += r.estimatedCount;
    costMissingCount += r.costMissingCount;
    sale += r.saleSideCredits;
    cost += r.costSideCredits;
    return {
      day: r.day,
      tenant_id: r.tenantId,
      offering_id: r.offeringId,
      channel_id: r.channelId,
      channel_name: r.channelName,
      provider: r.providerSlug,
      model: r.modelName,
      settle_count: r.settleCount,
      estimated_count: r.estimatedCount,
      cost_missing_count: r.costMissingCount,
      sale_side_credits: r.saleSideCredits.toString(),
      cost_side_credits: r.costSideCredits.toString(),
      gross_margin_credits: (r.saleSideCredits - r.costSideCredits).toString(),
    };
  });
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    rows: wireRows,
    totals: {
      settle_count: settleCount,
      estimated_count: estimatedCount,
      cost_missing_count: costMissingCount,
      sale_side_credits: sale.toString(),
      cost_side_credits: cost.toString(),
      gross_margin_credits: (sale - cost).toString(),
    },
  };
}
