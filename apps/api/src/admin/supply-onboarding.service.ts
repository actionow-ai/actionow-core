// apps/api/src/admin/supply-onboarding.service.ts
//
// model-supply-greenfield 批次5 slice2 — the CHANNEL ONBOARDING seam (§10
// 发现与批建, Major A5): the three wizard endpoints between "channel +
// credential exist" and "offerings enabled":
//
//   1. discover  — engine `discoverModels` (dialect discovery endpoint when the
//      DSL pack declares one, else the official catalog by provider slug);
//   2. batch     — transactional batch offering creation, ALWAYS `draft`
//      (§10 双门: `enabled` is unreachable here — only the slice-1 enable path
//      writes it), plus DEFAULT SALE-CARD MINTING from the official catalog
//      (matched on the upstream model name; the channel route group's
//      `group_ratio_bps` folded into the synthesized spec; no match →
//      `needs_pricing`, never a 0-price card — §10 永不 0 价上架);
//   3. probe-and-enable — each offering through the FULL slice-1 gate stack
//      (OfferingLifecycleService.enableOffering: config gates → golden probe →
//      enabled). Sequential on purpose: the lifecycle service's shared
//      InMemoryProbeBudget (R5) paces the batch — this service adds NO second
//      budget and NO bypass.
import type {
  BatchCreatedSupplyOffering,
  BatchCreateSupplyOfferingsResponse,
  BatchProbeEnableResult,
  BatchProbeEnableSupplyOfferingsResponse,
  DiscoverSupplyModelsResponse,
  FetchProfile,
  HttpClient,
  ModelOperation,
  Offering as SupplyOfferingView,
  OfferingPricingOutcome,
  Operation,
} from '@actionow/contracts';
import { offeringSchema as supplyOfferingViewSchema } from '@actionow/contracts';
import type {
  Database,
  DbOrTx,
  SupplyChannelRow,
  SupplyModelRow,
  SupplyOfferingRow,
  SupplyProviderRow,
} from '@actionow/db';
import {
  createSupplyModel,
  createSupplyOffering,
  createSupplyPriceCard,
  getRouteGroupById,
  getSupplyChannelById,
  getSupplyModelById,
  getSupplyOfferingById,
  getSupplyProviderById,
  listSupplyOfferings,
  matchOfficialPrice,
  officialPriceToSpec,
  updateSupplyModel,
} from '@actionow/db';
import type { ResolveDialectProvider } from '@actionow/engine';
import { discoverModels, packKeyOf } from '@actionow/engine';
import type { AppEnv } from '@actionow/infra';
import { createHttpClient } from '@actionow/infra';
import type { DialectPack, DialectRegistry } from '@actionow/spi';
import { builtinDialectPacks, createBuiltinDialectRegistry } from '@actionow/spi';
import { Inject, Injectable, Optional } from '@nestjs/common';

import { engineInvalidInput, engineNotFound } from '../common/errors.js';
import { SecretResolver } from '../common/secret-resolver.js';
import { DB, ENV } from '../common/tokens.js';
import type {
  BatchCreateSupplyOfferingsDto,
  BatchProbeEnableSupplyOfferingsDto,
} from './dto/admin.dto.js';
import { OfferingLifecycleService } from './offering-lifecycle.service.js';
import { DISCOVERY_PACKS, PROBE_DIALECTS, PROBE_HTTP } from './supply.tokens.js';

/** Postgres SQLSTATE for a unique-constraint violation (local copy — see supply.service.ts). */
const PG_UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur !== null && cur !== undefined && depth < 8; depth += 1) {
    if (typeof cur === 'object' && (cur as { code?: unknown }).code === PG_UNIQUE_VIOLATION) {
      return true;
    }
    cur = typeof cur === 'object' ? (cur as { cause?: unknown }).cause : undefined;
  }
  return false;
}

/**
 * Conservative default operation surface for an INLINE new model (the wizard's
 * fast path): chat.completions sync+stream, empty canonical params. Honest
 * placeholder — the catalog author refines the contract before enable matters
 * (the enable gates run against whatever is declared).
 */
const DEFAULT_NEW_MODEL_OPERATIONS: ModelOperation[] = [
  { operation: 'chat.completions', paradigms: ['sync', 'stream'], slow: false, params: [] },
];

/** Identity customer-price ratio in basis points (route_group default). */
const DEFAULT_GROUP_RATIO_BPS = 10_000;

/** Page size for the internal full-list loop over a channel's offerings. */
const PAGE_LIMIT = 200;
const MAX_PAGES = 50;

@Injectable()
export class SupplyOnboardingService {
  private readonly registry: DialectRegistry;
  private readonly http: HttpClient;
  private readonly packs: ReadonlyMap<string, DialectPack>;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: AppEnv,
    private readonly secrets: SecretResolver,
    private readonly lifecycle: OfferingLifecycleService,
    // Same override seams as the lifecycle service (tests: no real egress);
    // production defaults below. The REGISTRY defaults to the same builtin
    // assembly the probe uses; the PACKS default to the builtin YAML packs.
    @Optional() @Inject(PROBE_DIALECTS) registry?: DialectRegistry,
    @Optional() @Inject(PROBE_HTTP) http?: HttpClient,
    @Optional() @Inject(DISCOVERY_PACKS) packs?: ReadonlyMap<string, DialectPack>,
  ) {
    this.registry = registry ?? createBuiltinDialectRegistry();
    this.http = http ?? createHttpClient();
    this.packs = packs ?? new Map(builtinDialectPacks().map((pack) => [packKeyOf(pack), pack]));
  }

  // ----- step ③: discover (§10 发现模型) -----

  /** List the channel's upstream model candidates (dialect discovery endpoint or catalog). */
  async discoverChannelModels(channelId: string): Promise<DiscoverSupplyModelsResponse> {
    const { channel, provider } = await this.loadChannel(channelId);
    const outcome = await discoverModels(
      {
        db: this.db,
        registry: this.registry,
        http: this.http,
        packs: this.packs,
        resolveProxyUrl: async (proxyRef: string): Promise<string | undefined> =>
          (await this.secrets.resolve(proxyRef)) ?? this.env.UPSTREAM_PROXY_URL,
      },
      { channel, provider: toResolveProvider(provider) },
    );
    if (!outcome.ok) {
      throw engineInvalidInput(`${outcome.error.code}: ${outcome.error.message}`);
    }
    return {
      source: outcome.source,
      models: outcome.models.map((m) => ({
        upstream_model_name: m.upstreamModelName,
        ...(m.displayName !== undefined ? { display_name: m.displayName } : {}),
        source: m.source,
        exists_as_offering: m.existsAsOffering,
      })),
    };
  }

  // ----- step ④a: batch offering creation + default minting (§10 批量生成 draft) -----

  /**
   * Create the picked offerings in ONE transaction (all-or-nothing: a
   * duplicate (model, channel) or a taken model name rolls the whole batch
   * back into a clean 400). Every offering is born `draft` — this path never
   * writes `status` at all, so `enabled` is structurally unreachable here.
   */
  async batchCreateOfferings(
    channelId: string,
    dto: BatchCreateSupplyOfferingsDto,
  ): Promise<BatchCreateSupplyOfferingsResponse> {
    const { channel, provider } = await this.loadChannel(channelId);

    // Pre-checks OUTSIDE the transaction (referential 400s, not 500s).
    const seenModelIds = new Set<string>();
    const seenNewNames = new Set<string>();
    const existingModels = new Map<string, SupplyModelRow>();
    for (const item of dto.items) {
      if (item.model_id !== undefined) {
        if (seenModelIds.has(item.model_id)) {
          throw engineInvalidInput(
            `model ${item.model_id} is picked more than once — an offering is unique per (model, channel)`,
          );
        }
        seenModelIds.add(item.model_id);
        const model = await getSupplyModelById(this.db, item.model_id);
        if (model === undefined) throw engineInvalidInput(`model ${item.model_id} not found`);
        existingModels.set(item.model_id, model);
      } else if (item.new_model !== undefined) {
        if (seenNewNames.has(item.new_model.name)) {
          throw engineInvalidInput(
            `new model name '${item.new_model.name}' appears more than once`,
          );
        }
        seenNewNames.add(item.new_model.name);
      }
    }

    // 倍率折入 (§10): the channel route group's group_ratio_bps, else identity.
    const groupRatioBps = await this.groupRatioBpsFor(channel);

    try {
      return await this.db.transaction(async (tx) => {
        const offerings: BatchCreatedSupplyOffering[] = [];
        let needsPricingCount = 0;
        /** One pricing verdict per model — a model picked twice mints once. */
        const pricingByModel = new Map<string, OfferingPricingOutcome>();

        for (const item of dto.items) {
          let model: SupplyModelRow;
          if (item.model_id !== undefined) {
            const found = existingModels.get(item.model_id);
            if (found === undefined) throw engineInvalidInput(`model ${item.model_id} not found`);
            model = found;
          } else if (item.new_model !== undefined) {
            model = await createSupplyModel(tx, {
              name: item.new_model.name,
              displayName: item.new_model.display_name ?? item.new_model.name,
              modality: item.new_model.modality ?? 'text',
              operations: item.new_model.operations ?? DEFAULT_NEW_MODEL_OPERATIONS,
              // status omitted → born `draft` (needs_pricing keeps it un-servable).
            });
          } else {
            // Unreachable — the contract superRefine enforces exactly-one.
            throw engineInvalidInput('exactly one of model_id / new_model is required');
          }

          // 批建一律 draft: `status` is NEVER passed (db default 'draft'); the
          // slice-1 enable path is the only writer of 'enabled'.
          const offering = await createSupplyOffering(tx, {
            modelId: model.id,
            channelId: channel.id,
            upstreamModelName: item.upstream_model_name,
            fetchProfile: dto.fetch_profile ?? this.defaultFetchProfile(channel, provider, model),
          });

          let pricing = pricingByModel.get(model.id);
          if (pricing === undefined) {
            pricing = await this.mintDefaultSaleCard(
              tx,
              model,
              provider,
              item.upstream_model_name,
              groupRatioBps,
            );
            pricingByModel.set(model.id, pricing);
          }
          if (pricing.status === 'needs_pricing') needsPricingCount += 1;

          offerings.push({
            offering: toOfferingView(offering),
            model_id: model.id,
            upstream_model_name: item.upstream_model_name,
            pricing,
          });
        }
        return { offerings, needs_pricing_count: needsPricingCount };
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw engineInvalidInput(
          'batch rejected: a picked (model, channel) offering or model name already exists (the whole batch rolled back)',
        );
      }
      throw err;
    }
  }

  // ----- step ④b: batch probe-and-enable (§10 批量 golden probe → 通过才可 enable) -----

  /**
   * Run offerings through the FULL slice-1 enable stack, one at a time. The
   * shared lifecycle probe budget (R5 daily USD + per-offering min interval)
   * paces the batch; a budget-refused probe surfaces as that offering's
   * structured `golden_probe` violation, never as a batch failure.
   */
  async batchProbeAndEnable(
    channelId: string,
    dto: BatchProbeEnableSupplyOfferingsDto,
  ): Promise<BatchProbeEnableSupplyOfferingsResponse> {
    const { channel } = await this.loadChannel(channelId);

    let offerings: SupplyOfferingRow[];
    if (dto.offering_ids !== undefined) {
      offerings = [];
      for (const id of dto.offering_ids) {
        const row = await getSupplyOfferingById(this.db, id);
        if (row === undefined) throw engineInvalidInput(`offering ${id} not found`);
        if (row.channelId !== channel.id) {
          throw engineInvalidInput(`offering ${id} does not belong to channel ${channel.id}`);
        }
        offerings.push(row);
      }
    } else {
      // Default scope: every not-yet-enabled, not-disabled offering on the channel.
      offerings = [
        ...(await this.channelOfferings(channel.id, 'draft')),
        ...(await this.channelOfferings(channel.id, 'probing')),
      ];
    }

    const results: BatchProbeEnableResult[] = [];
    let enabledCount = 0;
    for (const offering of offerings) {
      // Sequential 逐个 — the shared InMemoryProbeBudget is the ONLY throttle.
      const verdict = await this.lifecycle.enableOffering(offering.id);
      if (verdict.enabled) enabledCount += 1;
      results.push({
        offering_id: offering.id,
        upstream_model_name: offering.upstreamModelName,
        enabled: verdict.enabled,
        offering_status: verdict.offering_status,
        violations: verdict.violations,
        ...(verdict.probe !== undefined ? { probe: verdict.probe } : {}),
      });
    }
    return { results, enabled_count: enabledCount };
  }

  // ----- internals -----

  private async loadChannel(
    channelId: string,
  ): Promise<{ channel: SupplyChannelRow; provider: SupplyProviderRow | undefined }> {
    const channel = await getSupplyChannelById(this.db, channelId);
    if (channel === undefined) throw engineNotFound(`supply channel ${channelId} not found`);
    const provider = await getSupplyProviderById(this.db, channel.providerId);
    return { channel, provider };
  }

  /** The channel route group's customer-price ratio, else the identity default. */
  private async groupRatioBpsFor(channel: SupplyChannelRow): Promise<number> {
    if (channel.routeGroupId === null) return DEFAULT_GROUP_RATIO_BPS;
    const group = await getRouteGroupById(this.db, channel.routeGroupId);
    return group?.groupRatioBps ?? DEFAULT_GROUP_RATIO_BPS;
  }

  /**
   * Dialect-informed default fetch profile (§10 「fetch_profile 默认或按方言」):
   * the dialect's FIRST declared fetch mode for the model's primary operation
   * — a task-only media dialect defaults to submit_poll, a chat dialect to
   * direct. Unresolvable dialect / undeclared operation → `direct`.
   */
  private defaultFetchProfile(
    channel: SupplyChannelRow,
    provider: SupplyProviderRow | undefined,
    model: SupplyModelRow,
  ): FetchProfile {
    const ref = channel.dialect ?? provider?.defaultDialect ?? null;
    const dialect = ref === null ? undefined : this.registry.resolve(ref);
    const primaryOp: Operation | undefined = model.operations[0]?.operation;
    const mode =
      primaryOp === undefined ? undefined : dialect?.operations[primaryOp]?.fetchModes[0];
    return { mode: mode ?? 'direct' };
  }

  /**
   * Default SALE-card minting for one model (§10 售价卡默认由官方价目生成):
   * matched on the UPSTREAM model name against the provider's official
   * catalog; the synthesized per-token spec folds `groupRatioBps` (a stored
   * rich scheme keeps its own pricing). Runs INSIDE the batch transaction so a
   * later failure never leaves an orphan card. No match → `needs_pricing`, the
   * model stays card-less and the enable gate holds it (永不 0 价上架).
   */
  private async mintDefaultSaleCard(
    tx: DbOrTx,
    model: SupplyModelRow,
    provider: SupplyProviderRow | undefined,
    upstreamModelName: string,
    groupRatioBps: number,
  ): Promise<OfferingPricingOutcome> {
    if (model.priceCardId !== null) {
      return { status: 'existing', price_card_id: model.priceCardId };
    }
    if (provider === undefined) {
      return {
        status: 'needs_pricing',
        message: 'channel has no live provider — cannot match the official catalog',
      };
    }
    const official = await matchOfficialPrice(tx, provider.slug, upstreamModelName);
    if (official === undefined) {
      return {
        status: 'needs_pricing',
        message: `no official price matched provider '${provider.slug}' for upstream model '${upstreamModelName}' — price manually before enable`,
      };
    }
    const spec = officialPriceToSpec(official, { groupRatioBps });
    const card = await createSupplyPriceCard(tx, {
      name: `${model.name} (official ${provider.slug})`,
      method: spec.method,
      unit: 'tokens',
      tierDims: [],
      spec,
      effectiveAt: new Date(),
    });
    await updateSupplyModel(tx, model.id, { priceCardId: card.id });
    return {
      status: 'minted',
      price_card_id: card.id,
      message: `minted from official ${provider.slug}/${official.modelSlug} (group ratio ${String(groupRatioBps)} bps)`,
    };
  }

  /** Every LIVE offering on the channel with `status`, keyset-paged to completion. */
  private async channelOfferings(channelId: string, status: string): Promise<SupplyOfferingRow[]> {
    const rows: SupplyOfferingRow[] = [];
    let cursor: { createdAt: Date; id: string } | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await listSupplyOfferings(
        this.db,
        { limit: PAGE_LIMIT, cursor },
        {
          channelId,
          status,
        },
      );
      rows.push(...result.rows);
      const last = result.rows.at(-1);
      if (!result.hasMore || last === undefined) break;
      cursor = { createdAt: last.createdAt, id: last.id };
    }
    return rows;
  }
}

// ----- view mappers (row → frozen entity view; Date → ISO string) -----

function toOfferingView(row: SupplyOfferingRow): SupplyOfferingView {
  return supplyOfferingViewSchema.parse({
    id: row.id,
    model_id: row.modelId,
    channel_id: row.channelId,
    status: row.status,
    upstream_model_name: row.upstreamModelName,
    fetch_profile: row.fetchProfile,
    timeout_budget_seconds: row.timeoutBudgetSeconds,
    param_declarations: row.paramDeclarations,
    cost_price_card_id: row.costPriceCardId,
    max_concurrency: row.maxConcurrency,
    weight: row.weight,
    tier: row.tier,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  });
}

function toResolveProvider(
  provider: SupplyProviderRow | undefined,
): ResolveDialectProvider | undefined {
  if (provider === undefined) return undefined;
  return {
    slug: provider.slug,
    defaultDialect: provider.defaultDialect,
    callbackVerification: provider.callbackVerification,
    region: provider.region,
  };
}
