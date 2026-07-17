// apps/api/src/admin/reconciliation.controller.ts
//
// model-supply-greenfield 批次4 slice6 — the §9.2 reconciliation REPORT face
// (对账降级 · 判据 2.6 「报表可出即达标」): a read-only admin endpoint that
// aggregates GATEWAY settles per (UTC day, tenant, channel, offering) with
// BOTH billing sides (sale = charged µcredits, cost = the offering cost
// card's independent computation stamped at settle) and the gross margin.
//
// Usage: 中转渠道 monthly report = GET ?from=2026-07-01&to=2026-08-01 (人工
// 核对); 官方渠道日比对 = GET /admin/reconciliation/daily?date=YYYY-MM-DD
// (批次5 slice4 — the engine reconcileDaily comparer, threshold from
// dynamic-config key RECONCILIATION_DEVIATION_PCT via SettingsService).
// Read-only — no @Audit (no state change), no idempotency (GET).
import type {
  DailyReconcileOfferingRowView,
  DailyReconcileReport,
  ReconciliationReport,
  ReconciliationRow,
} from '@actionow/contracts';
import type { Database, ReconciliationAggregateRow } from '@actionow/db';
import { aggregateGatewayReconciliation } from '@actionow/db';
import { DomainError } from '@actionow/domain';
import type { DailyReconcileResult } from '@actionow/engine';
import { reconcileDaily } from '@actionow/engine';
import { Controller, Get, Inject, Optional, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { engineInvalidInput } from '../common/errors.js';
import { DB } from '../common/tokens.js';
import { SettingsService } from '../settings/settings.service.js';
import { AdminGuard } from './auth/admin.guard.js';
import { Roles } from './auth/roles.decorator.js';

/** The db read this controller performs, injectable for unit tests. */
export interface ReconciliationQueries {
  aggregateGatewayReconciliation: typeof aggregateGatewayReconciliation;
  reconcileDaily: typeof reconcileDaily;
}

@ApiTags('admin')
@ApiBearerAuth('jwt')
@UseGuards(AdminGuard)
@Roles('admin')
@Controller('admin')
export class ReconciliationController {
  private readonly queries: ReconciliationQueries = {
    aggregateGatewayReconciliation,
    reconcileDaily,
  };

  constructor(
    @Inject(DB) private readonly db: Database,
    // 动态配置 threshold read (@Optional: partial test modules fall back to the
    // engine default — the global SettingsModule provides it in production).
    @Optional() private readonly settings?: SettingsService,
  ) {}

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

  @Get('reconciliation/daily')
  @ApiOperation({
    summary:
      'Daily official-channel reconciliation (§9.2 批次5): official-baseline recompute vs booked cost per offering, with deviation/alert flags; 中转渠道 stays monthly-report scope',
  })
  async daily(
    @Query('date') dateRaw?: string,
    @Query('threshold_pct') thresholdRaw?: string,
  ): Promise<DailyReconcileReport> {
    if (dateRaw === undefined || dateRaw.length === 0) {
      throw engineInvalidInput("query parameter 'date' is required (YYYY-MM-DD)");
    }
    let thresholdPct: number | undefined;
    if (thresholdRaw !== undefined && thresholdRaw.length > 0) {
      thresholdPct = Number(thresholdRaw);
      if (!Number.isFinite(thresholdPct) || thresholdPct <= 0) {
        throw engineInvalidInput(
          `query parameter 'threshold_pct' must be a positive number: '${thresholdRaw}'`,
        );
      }
    }
    try {
      const result = await this.queries.reconcileDaily(
        { db: this.db, settings: this.settings },
        { date: dateRaw, thresholdPct },
      );
      return renderDailyReport(result);
    } catch (err) {
      // The engine rejects malformed / non-existent calendar days with a
      // DomainError('invalid_input') — surface it as the admin 400 envelope.
      if (err instanceof DomainError && err.code === 'invalid_input') {
        throw engineInvalidInput(err.message);
      }
      throw err;
    }
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

/** Engine daily result → the wire report (µcredit strings). Exported for the unit test. */
export function renderDailyReport(result: DailyReconcileResult): DailyReconcileReport {
  const rows: DailyReconcileOfferingRowView[] = result.perOffering.map((r) => ({
    offering_id: r.offeringId,
    provider: r.providerSlug,
    model: r.modelName,
    channel_name: r.channelName,
    scope: r.scope,
    settle_count: r.settleCount,
    estimated_count: r.estimatedCount,
    cost_missing_count: r.costMissingCount,
    sale_credits: r.saleCredits.toString(),
    cost_credits: r.costCredits.toString(),
    compared_settle_count: r.comparedSettleCount,
    compared_cost_credits: r.comparedCostCredits.toString(),
    expected_cost_credits: r.expectedCostCredits?.toString() ?? null,
    deviation_pct: r.deviationPct,
    alerted: r.alerted,
    ...(r.note !== undefined ? { note: r.note } : {}),
  }));
  return {
    date: result.date,
    threshold_pct: result.thresholdPct,
    rows,
    official_count: result.officialCount,
    relay_count: result.relayCount,
    unknown_count: result.unknownCount,
    alerts_count: result.alertsCount,
  };
}
