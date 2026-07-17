// apps/api/src/admin/offering-lifecycle.service.ts
//
// model-supply-greenfield 批次5 slice1 — the offering LIFECYCLE seam (§2.5
// draft → probing → enabled → disabled): the NestJS orchestration around the
// engine's two enable doors:
//
//   - golden probe (engine gateway/golden-probe.ts — REAL upstream, §10):
//     `POST /admin/supply/offerings/:id/probe` runs it standalone (pure
//     diagnosis — NO status transition; the enable path owns transitions);
//   - the enable gate (engine gateway/enable-gate.ts — the batch-3 CONFIG-TIME
//     invariants + needs_pricing): `POST /admin/supply/offerings/:id/enable`
//     runs the cheap pure gates FIRST (a misconfigured offering never spends
//     probe budget), then draft/disabled → probing → the golden probe →
//     enabled on a passing verdict.
//
// Status discipline (§2.5 + hard principle #4): `enabled` is the ONLY state
// routing consumes, and THIS service is the only writer of it — the plain
// PATCH rejects `status: 'enabled'` (supply.service.ts). A failed probe
// leaves the offering at `probing` (honest: probed, not passed — retry via
// enable); a budget-REJECTED probe reverts to the pre-enable status (the
// probe never ran). `disabled` stays a plain PATCH (不收新请求 is immediate:
// the routing queries filter on `enabled`; in-flight tasks run to completion
// via the task center, which drives rows by task identity, never by offering
// status).
import type {
  EnableGateViolation,
  EnableSupplyOfferingResponse,
  GoldenProbeResult,
  HttpClient,
  ProbeSupplyOfferingResponse,
} from '@actionow/contracts';
import type { Database, SupplyChannelRow, SupplyModelRow, SupplyOfferingRow } from '@actionow/db';
import {
  getSupplyChannelById,
  getSupplyModelById,
  getSupplyOfferingById,
  getSupplyPriceCardById,
  getSupplyProviderById,
  updateSupplyOffering,
} from '@actionow/db';
import type { GoldenProbeOutcome, ResolveDialectProvider } from '@actionow/engine';
import { goldenProbe, InMemoryProbeBudget, validateEnableGates } from '@actionow/engine';
import type { AppEnv } from '@actionow/infra';
import { createHttpClient } from '@actionow/infra';
import type { DialectRegistry } from '@actionow/spi';
import { createBuiltinDialectRegistry } from '@actionow/spi';
import { Inject, Injectable, Optional } from '@nestjs/common';

import { engineNotFound } from '../common/errors.js';
import { SecretResolver } from '../common/secret-resolver.js';
import { DB, ENV } from '../common/tokens.js';
import { SettingsService } from '../settings/settings.service.js';
import { PROBE_DIALECTS, PROBE_HTTP } from './supply.tokens.js';

/** R5 code defaults when the @Global SettingsModule is absent (partial test modules). */
const FALLBACK_PROBE_DAILY_BUDGET_USD = 5;
const FALLBACK_PROBE_MIN_INTERVAL_SEC = 60;

/** The full subject rows (probe needs the routing facts; the enable gate needs pricing/contract facts). */
interface OfferingSubject {
  offering: SupplyOfferingRow;
  model: SupplyModelRow;
  channel: SupplyChannelRow;
  provider?: ResolveDialectProvider | undefined;
}

@Injectable()
export class OfferingLifecycleService {
  private readonly registry: DialectRegistry;
  private readonly http: HttpClient;
  /** In-process R5 gate (per-replica bound — see InMemoryProbeBudget). */
  private readonly probeBudget = new InMemoryProbeBudget();

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: AppEnv,
    private readonly secrets: SecretResolver,
    @Optional() private readonly settings?: SettingsService,
    // Overridable in tests; production factories default below (the probe gets
    // its OWN HttpClient — independent of request traffic, §R5 deps).
    @Optional() @Inject(PROBE_DIALECTS) registry?: DialectRegistry,
    @Optional() @Inject(PROBE_HTTP) http?: HttpClient,
  ) {
    this.registry = registry ?? createBuiltinDialectRegistry();
    this.http = http ?? createHttpClient();
  }

  // ----- probe (§10 standalone diagnosis) -----

  /** Run one golden probe against the offering's real upstream. NO status transition. */
  async probeOffering(offeringId: string): Promise<ProbeSupplyOfferingResponse> {
    const subject = await this.loadSubject(offeringId);
    const outcome = await this.runProbe(subject);
    return toProbeResponse(outcome);
  }

  // ----- enable (§2.5 the controlled draft/probing → enabled transition) -----

  /**
   * Enable an offering through the FULL gate stack: needs_pricing + the three
   * batch-3 config-time invariants (pure, first — no probe budget spent on a
   * doomed config), then the golden probe (real upstream), then
   * status = 'enabled'. Idempotent on an already-enabled offering.
   */
  async enableOffering(offeringId: string): Promise<EnableSupplyOfferingResponse> {
    const subject = await this.loadSubject(offeringId);
    const { offering, model } = subject;
    if (offering.status === 'enabled') {
      return { enabled: true, offering_status: 'enabled', violations: [] };
    }

    // ── gates 1–4 (pure config-time; §4.1 拒绝要可解释). ─────────────────────
    const saleCard =
      model.priceCardId === null
        ? undefined
        : await getSupplyPriceCardById(this.db, model.priceCardId);
    const violations = validateEnableGates({ model, offering, saleCard });
    if (violations.length > 0) {
      return { enabled: false, offering_status: offering.status, violations };
    }

    // ── gate 5: golden probe (真上游门). draft/disabled → probing while it runs. ──
    const previousStatus = offering.status;
    if (previousStatus !== 'probing') {
      await updateSupplyOffering(this.db, offering.id, { status: 'probing' });
    }
    const outcome = await this.runProbe(subject);
    if (outcome.status === 'rejected') {
      // The probe never ran (R5 refusal) — revert so the offering does not
      // claim a probing that never happened.
      if (previousStatus !== 'probing') {
        await updateSupplyOffering(this.db, offering.id, { status: previousStatus });
      }
      return {
        enabled: false,
        offering_status: previousStatus,
        violations: [probeViolation(outcome.message)],
        probe: toProbeResponse(outcome),
      };
    }
    const passed = outcome.result.connectivity.ok && outcome.result.functional.ok;
    if (!passed) {
      // Probed and NOT passed: stays `probing` (honest lifecycle position —
      // retry via enable once the upstream/config is fixed).
      const leg = outcome.result.connectivity.ok
        ? outcome.result.functional
        : outcome.result.connectivity;
      return {
        enabled: false,
        offering_status: 'probing',
        violations: [probeViolation(leg.message)],
        probe: toProbeResponse(outcome),
      };
    }
    await updateSupplyOffering(this.db, offering.id, { status: 'enabled' });
    return {
      enabled: true,
      offering_status: 'enabled',
      violations: [],
      probe: toProbeResponse(outcome),
    };
  }

  // ----- internals -----

  /** Load the probe/enable subject rows (offering → channel → provider → model), 404 on a broken chain. */
  private async loadSubject(offeringId: string): Promise<OfferingSubject> {
    const offering = await getSupplyOfferingById(this.db, offeringId);
    if (offering === undefined) throw engineNotFound(`supply offering ${offeringId} not found`);
    const model = await getSupplyModelById(this.db, offering.modelId);
    if (model === undefined) {
      throw engineNotFound(`model ${offering.modelId} (offering ${offeringId}) not found`);
    }
    const channel = await getSupplyChannelById(this.db, offering.channelId);
    if (channel === undefined) {
      throw engineNotFound(`channel ${offering.channelId} (offering ${offeringId}) not found`);
    }
    const provider = await getSupplyProviderById(this.db, channel.providerId);
    return {
      offering,
      channel,
      model,
      ...(provider !== undefined
        ? {
            provider: {
              slug: provider.slug,
              defaultDialect: provider.defaultDialect,
              callbackVerification: provider.callbackVerification,
              region: provider.region,
            },
          }
        : {}),
    };
  }

  private async runProbe(subject: OfferingSubject): Promise<GoldenProbeOutcome> {
    return goldenProbe(
      {
        db: this.db,
        registry: this.registry,
        http: this.http,
        budget: this.probeBudget,
        limits: {
          dailyBudgetUsd:
            (await this.settings?.get('PROBE_DAILY_BUDGET_USD')) ??
            this.env.PROBE_DAILY_BUDGET_USD ??
            FALLBACK_PROBE_DAILY_BUDGET_USD,
          minIntervalSec:
            (await this.settings?.get('PROBE_MIN_INTERVAL_SEC')) ??
            this.env.PROBE_MIN_INTERVAL_SEC ??
            FALLBACK_PROBE_MIN_INTERVAL_SEC,
        },
        // Channel egress proxy: proxy_ref via the vault resolver, else the
        // platform default (the model-test resolveProxy discipline).
        resolveProxyUrl: async (proxyRef: string): Promise<string | undefined> =>
          (await this.secrets.resolve(proxyRef)) ?? this.env.UPSTREAM_PROXY_URL,
      },
      subject,
    );
  }
}

// ----- outcome → contract views (snake_case supply-view convention) -----

function probeViolation(message: string): EnableGateViolation {
  return { gate: 'golden_probe', message: `golden probe did not pass: ${message}` };
}

/** Map the engine outcome to the contract response (camelCase engine → snake_case view). */
export function toProbeResponse(outcome: GoldenProbeOutcome): ProbeSupplyOfferingResponse {
  if (outcome.status === 'rejected') {
    return {
      status: 'rejected',
      rejection: {
        reason: outcome.reason,
        message: outcome.message,
        retry_after_seconds: outcome.retryAfterSeconds,
      },
    };
  }
  const r = outcome.result;
  const result: GoldenProbeResult = {
    offering_id: r.offeringId,
    operation: r.operation,
    connectivity: r.connectivity,
    functional: r.functional,
    ...(r.sample !== undefined ? { sample: r.sample } : {}),
    elapsed_ms: r.elapsedMs,
  };
  return { status: 'completed', result };
}
