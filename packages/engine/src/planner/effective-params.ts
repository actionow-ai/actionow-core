// packages/engine/src/planner/effective-params.ts
//
// model-supply-greenfield 批次3 — §4.1 LAYER 2 (offering 声明层): the planner
// applies the SELECTED offering's param declarations to the canonical request
// params and produces EffectiveParams — the canonical bag (售价/审计 side) and
// the upstream bag (成本/回传 side) — plus the billing dims (§4.1 字段回流).
//
// Layer ownership is pinned by §4.1 and must not drift:
//   - layer 1 (canonical 归一) is the dialect facade's — it already resolved
//     canonical defaults into GatewayRequest.params with `isDefault` tags.
//     This module takes values as-is; the isDefault tag influences FILTERING
//     (param-filter.ts, §4 rules 1–3), never value resolution here.
//   - layer 2 (THIS module) bakes ALL value/name/domain semantics: domain is
//     a filter-domain only (never transforms values), map translates
//     value/name, fixed pins, operator variants override.
//   - layer 3 (adapter aspect ①) consumes EffectiveParams.upstream and does
//     pure wire-structure placement (query/json/form, method, path). It never
//     reads declarations and never re-maps values — the "one SPI" premise.
//
// Precedence (§4.1): operator variant > upstream declaration > canonical
// default.
//
// ---------------------------------------------------------------------------
// CONFIG-TIME INVARIANTS (batch-5 offering enable / golden probe MUST enforce)
// ---------------------------------------------------------------------------
// The runtime below TRUSTS these. Per §4.1 they are validated when an offering
// is enabled / golden-probed (批次5) — never silently patched, clamped, or
// guarded at runtime:
//
// 1. OPERATOR VARIANT ⊆ UPSTREAM DOMAIN — existence AND value range. Every
//    operator-origin row (domain/map/fixed/unsupported) may only constrain to
//    values the upstream declaration actually serves (运营者可收紧不可放宽,
//    §4.1 明文: 运营者钉的值必须落在上游 domain 内, 拒绝配出上游会拒绝的值).
//    Runtime resolves by precedence and does NOT re-verify the ⊆ relation.
//
// 2. CANONICAL DEFAULT ⊆ OFFERING DOMAIN — a non-billing param's canonical
//    default does not participate in filtering (§4 rule 3) and resolves by
//    passthrough here: if the default falls outside the offering's declared
//    domain, the out-of-domain value is sent upstream AS-IS (runtime follows
//    rule 3 and never clamps). Config time must guarantee every enabled
//    offering's domain admits each canonical default (or declares a map/fixed
//    covering it), or the mismatch surfaces as an upstream 4xx.
//
// 3. BILLING-RELEVANT UPSTREAM TRANSLATION MUST NOT CROSS PRICE TIERS — for a
//    billing_relevant param, `map.values` / `fixed.upstreamValue` must
//    translate WITHIN the price tier of the canonical value. billingDims
//    always keys off the CANONICAL effective value (§4 rule 2 红线, see
//    resolveEffectiveParams), so a translation that upgrades the delivered
//    tier (canonical "720p" → upstream wire "1080p") would charge the low
//    tier while paying the high one — 毛利倒挂. Runtime rule 2 only validates
//    the canonical side; translation honesty rests on THIS config-time check
//    plus cost-card reconciliation (§9.2 对账).
// ---------------------------------------------------------------------------
//
// PURE LOGIC — no I/O, no db, no state. Safe to re-run per failover hop
// (§4 rule 5).
import type {
  BillingDims,
  CanonicalParam,
  CanonicalParamValue,
  EffectiveParams,
  OfferingParamDecl,
  Operation,
  ParamDeclRule,
} from '@actionow/contracts';

/** The `map` member of the declaration-rule union (§4: 值/名/类型翻译) — the TRANSLATION aspect. */
export type MapRule = Extract<ParamDeclRule, { kind: 'map' }>;

/** The non-`map` members (supports/domain/fixed/unsupported) — the CONSTRAINT aspect (§4: 存在性 + 值域). */
export type ConstraintRule = Exclude<ParamDeclRule, { kind: 'map' }>;

/**
 * One param's declaration rows after operation scoping, split along the TWO
 * ORTHOGONAL ASPECTS a declaration can carry, each keyed by origin:
 *
 * - CONSTRAINT aspect (`supports` / `domain` / `fixed` / `unsupported`):
 *   WHICH canonical values the offering serves — feeds filtering
 *   (param-filter.ts) and canonical-value pinning (fixed).
 * - TRANSLATION aspect (`map`): HOW a served value is spelled on the upstream
 *   wire (name rename + value translation) — never affects filtering
 *   (翻译不改过滤域).
 *
 * A param routinely needs BOTH (e.g. a `domain` narrowing the billable values
 * AND a `map` renaming the wire key): the aspects are COMPLEMENTARY, not
 * duplicates, and merging must preserve both per origin. Within one
 * (operation, param, origin, aspect) slot at most one row is meaningful
 * (write-time enforcement is a later batch); same-aspect duplicates keep the
 * first row seen.
 */
export interface MergedParamDecl {
  opConstraint?: ConstraintRule;
  upConstraint?: ConstraintRule;
  opMap?: MapRule;
  upMap?: MapRule;
}

/**
 * Scope an offering's declaration table to one operation and merge it per
 * param by (origin × aspect). Scoping: a row with `operation` set applies to
 * THAT operation only; an absent `operation` applies to all operation
 * surfaces — and an operation-specific row wins over the all-operations row
 * for the same (param, origin, aspect).
 *
 * Shared by resolveEffectiveParams and filterCandidates so filtering and
 * resolution can never disagree about which rows govern a param (§4 rule 5:
 * every failover hop re-runs both against the same merge).
 */
export function mergeDeclarations(
  declarations: OfferingParamDecl[],
  operation: Operation,
): Map<string, MergedParamDecl> {
  const merged = new Map<string, MergedParamDecl>();
  const put = (row: OfferingParamDecl): void => {
    const entry = merged.get(row.param) ?? {};
    if (row.rule.kind === 'map') {
      if (row.origin === 'operator') entry.opMap ??= row.rule;
      else entry.upMap ??= row.rule;
    } else {
      if (row.origin === 'operator') entry.opConstraint ??= row.rule;
      else entry.upConstraint ??= row.rule;
    }
    merged.set(row.param, entry);
  };
  // Operation-specific rows first so they win over all-operations rows.
  for (const row of declarations) if (row.operation === operation) put(row);
  for (const row of declarations) if (row.operation === undefined) put(row);
  return merged;
}

/**
 * The request-side resolved canonical value for a param (§4 "解析后的生效值,
 * 显式或默认"): the value riding GatewayRequest.params (explicit OR the
 * canonical default the facade tagged `isDefault: true`), falling back to the
 * canonical contract's own default when the facade omitted the param entirely.
 * `undefined` = the param has no resolvable value (optional, no default).
 */
export function resolveRequestValue(
  param: CanonicalParam,
  requestParams: Record<string, CanonicalParamValue>,
): unknown {
  const carried = requestParams[param.name];
  if (carried?.value !== undefined) return carried.value;
  return param.default;
}

export interface ResolveEffectiveParamsInput {
  operation: Operation;
  /** The operation's canonical param contract (model.operations[op].params, §4). */
  canonicalParams: CanonicalParam[];
  /** GatewayRequest.params — every canonical input tagged explicit-vs-default (§4.1 layer 1). */
  requestParams: Record<string, CanonicalParamValue>;
  /**
   * The SELECTED offering's param_declarations. May be pre-scoped to the
   * operation or the full table — operation scoping is (re-)applied here
   * either way (idempotent).
   */
  declarations: OfferingParamDecl[];
}

export interface EffectiveParamsResult {
  /**
   * §4 rule 2 双向可见: `canonical` = effective canonical values (sale price
   * tiers, audit); `upstream` = upstream wire names → actual upstream values
   * (cost side; adapter aspect ①'s ONLY param input).
   */
  effective: EffectiveParams;
  /** billing_relevant params' effective canonical values (§4.1 字段回流 — the price-card tier key). */
  billingDims: BillingDims;
}

/**
 * §4.1 layer 2: apply the selected offering's declarations to the canonical
 * request params. Per param the two aspects resolve INDEPENDENTLY:
 *
 * CANONICAL value — governed by the winning CONSTRAINT (opConstraint ??
 * upConstraint):
 * - `unsupported`: excluded from BOTH bags (the offering does not serve it;
 *   filtering of explicit carries is §4 rule 1, done in param-filter.ts).
 * - `fixed`: the HONESTLY declared `value` (visible to docs/estimation, §4
 *   rule 3). A fixed param materializes even when the request never carried
 *   it.
 * - no constraint / `supports` / `domain`: the resolved request value passes
 *   through unchanged (domain narrows the FILTER domain only — filtering
 *   happened in param-filter.ts before this ran).
 *
 * UPSTREAM wire name — an upstream dialect FACT the operator may override but
 * never erase (运营者收紧不可抹掉上游 wire 事实):
 * `opMap.upstreamName ?? upMap.upstreamName ?? param.name`.
 *
 * UPSTREAM wire value — translation precedence operator > upstream >
 * passthrough; within each origin level the fixed pin's own spelling
 * (`fixed.upstreamValue`) outranks that level's `map` translation (discrete
 * `values` keyed by the stringified canonical value, else linear
 * `scale`/`offset` for numbers). A level that produces no translation falls
 * through to the next — a partial operator map never erases the upstream
 * spelling of uncovered values, and a fully uncovered value is carried AS-IS
 * (honest passthrough, never a silent drop).
 *
 * billingDims — ALWAYS the effective CANONICAL value, never the translated
 * upstream value (§4 rule 2 红线: 售价按 canonical 计 tier; see config-time
 * invariant 3 above for the translation-honesty counterpart).
 */
export function resolveEffectiveParams(input: ResolveEffectiveParamsInput): EffectiveParamsResult {
  const merged = mergeDeclarations(input.declarations, input.operation);
  const canonical: Record<string, unknown> = {};
  const upstream: Record<string, unknown> = {};
  const billingDims: BillingDims = {};

  for (const param of input.canonicalParams) {
    const decl = merged.get(param.name) ?? {};
    const constraint = decl.opConstraint ?? decl.upConstraint;
    if (constraint?.kind === 'unsupported') continue;

    const canonicalValue =
      constraint?.kind === 'fixed'
        ? constraint.value
        : resolveRequestValue(param, input.requestParams);
    if (canonicalValue === undefined) continue;

    const upstreamName = decl.opMap?.upstreamName ?? decl.upMap?.upstreamName ?? param.name;
    const upstreamValue = (
      translateAtLevel(canonicalValue, decl.opConstraint, decl.opMap) ??
      translateAtLevel(canonicalValue, decl.upConstraint, decl.upMap) ?? { value: canonicalValue }
    ).value;

    canonical[param.name] = canonicalValue;
    upstream[upstreamName] = upstreamValue;

    if (param.billingRelevant && isBillingPrimitive(canonicalValue)) {
      billingDims[param.name] = canonicalValue;
    }
  }

  return { effective: { canonical, upstream }, billingDims };
}

/** A produced wire-value translation (wrapped so a translation TO `undefined` stays distinguishable from "no translation"). */
interface Translated {
  value: unknown;
}

/**
 * One origin level's wire-value translation: the level's fixed pin spelling
 * (`fixed.upstreamValue`) first, else the level's `map` translation.
 * `undefined` = this level produces no translation for the value (fall
 * through to the next level, then to passthrough).
 */
function translateAtLevel(
  canonicalValue: unknown,
  constraint: ConstraintRule | undefined,
  map: MapRule | undefined,
): Translated | undefined {
  if (constraint?.kind === 'fixed' && constraint.upstreamValue !== undefined) {
    return { value: constraint.upstreamValue };
  }
  return translateValue(canonicalValue, map);
}

/**
 * Translate one canonical value through a `map` rule: discrete `values` first
 * (keyed by the stringified canonical value), then linear `scale`/`offset`
 * for numeric values. `undefined` = the map does not cover this value — the
 * caller falls through (a partial map is never a silent drop, §4 rule 4
 * 废除静默 dropUnsupported).
 */
function translateValue(value: unknown, map: MapRule | undefined): Translated | undefined {
  if (map === undefined) return undefined;
  if (map.values !== undefined) {
    const key = mapKey(value);
    if (key !== undefined && Object.hasOwn(map.values, key)) return { value: map.values[key] };
  }
  if ((map.scale !== undefined || map.offset !== undefined) && typeof value === 'number') {
    return { value: value * (map.scale ?? 1) + (map.offset ?? 0) };
  }
  return undefined;
}

/** The stringified-canonical-value key a `map.values` record is addressed by. */
function mapKey(value: unknown): string | undefined {
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'boolean':
      return String(value);
    default:
      return undefined;
  }
}

/** billing_relevant tier values are primitive by design (billingDimsSchema); anything else is a config error surfaced at contract-edit time. */
function isBillingPrimitive(value: unknown): value is string | number | boolean {
  const t = typeof value;
  return t === 'string' || t === 'number' || t === 'boolean';
}
