// packages/engine/src/gateway/enable-gate.ts
//
// model-supply-greenfield 批次5 slice1 — the offering ENABLE gate: the pure
// CONFIG-TIME validation of the batch-3 invariants contract (the header block
// of planner/effective-params.ts, "CONFIG-TIME INVARIANTS (batch-5 offering
// enable / golden probe MUST enforce)") plus the §10 needs_pricing gate.
//
// The runtime resolver TRUSTS these invariants and never re-verifies, clamps
// or patches (§4.1: 不在运行期静默兜底) — so an offering may reach `enabled`
// ONLY through this gate:
//
//   1. needs_pricing            — the model carries a SALE price card (§10 永不 0 价上架,
//                                 the assertPriced semantics extended to offering enable).
//   2. operator ⊆ upstream      — invariant ①: every operator-origin declaration row
//                                 constrains WITHIN what the upstream declaration serves
//                                 (existence AND value range; 运营者可收紧不可放宽).
//   3. default ⊆ offering domain — invariant ②: each canonical default is admitted by the
//                                 offering's declared domain (else runtime passthrough
//                                 sends an out-of-domain value upstream → 4xx).
//   4. billing translation tier — invariant ③: a billing_relevant param's map/fixed
//                                 upstream translation stays within the SALE-card price
//                                 tier of the canonical value (billingDims key off the
//                                 canonical side, §4 rule 2 — a tier-crossing translation
//                                 charges low and pays high: 毛利倒挂).
//
// The FIFTH gate (golden probe — real upstream) is golden-probe.ts's; the
// orchestration (apps/api OfferingLifecycleService) runs THESE cheap pure
// checks FIRST so a misconfigured offering never spends probe budget.
//
// PURE LOGIC — no I/O, no db, no state.
import type {
  CanonicalParam,
  EnableGateViolation,
  ModelOperation,
  OfferingParamDecl,
  Operation,
  PriceSpec,
} from '@actionow/contracts';

import type { ConstraintRule, MergedParamDecl } from '../planner/effective-params.js';
import { mergeDeclarations, translateUpstreamValue } from '../planner/effective-params.js';

// --- input ---------------------------------------------------------------------

/** The model facts the gate consumes (structurally satisfied by SupplyModelRow). */
export interface EnableGateModel {
  name: string;
  priceCardId: string | null;
  operations: ModelOperation[];
}

/** The offering facts the gate consumes (structurally satisfied by SupplyOfferingRow). */
export interface EnableGateOffering {
  id: string;
  paramDeclarations: OfferingParamDecl[];
}

/** The SALE card facts invariant 3 prices against (structurally satisfied by SupplyPriceCardRow). */
export interface EnableGateSaleCard {
  spec: PriceSpec;
  tierDims: string[];
}

export interface EnableGateInput {
  model: EnableGateModel;
  offering: EnableGateOffering;
  /**
   * The model's SALE price card row, resolved by the caller from
   * `model.priceCardId`. `undefined` = missing/soft-deleted → the
   * needs_pricing gate fires even when the id column is set (a dangling sale
   * card must not enable an offering).
   */
  saleCard: EnableGateSaleCard | undefined;
}

/**
 * Run gates 1–3 (+ the pricing precondition of gate 4). Returns EVERY
 * violation found (never fail-fast) so the operator fixes the config in one
 * round; `[]` = the config side is clean and ONLY the golden probe remains.
 */
export function validateEnableGates(input: EnableGateInput): EnableGateViolation[] {
  const violations: EnableGateViolation[] = [];

  // ── gate 1: needs_pricing (§10) ────────────────────────────────────────────
  if (input.model.priceCardId === null) {
    violations.push({
      gate: 'needs_pricing',
      message: `needs_pricing: model '${input.model.name}' has no sale price card — an offering must never enable un-priced`,
    });
  } else if (input.saleCard === undefined) {
    violations.push({
      gate: 'needs_pricing',
      message: `needs_pricing: model '${input.model.name}' sale price card ${input.model.priceCardId} is missing or soft-deleted`,
    });
  }

  // ── gates 2–4, per operation surface ───────────────────────────────────────
  for (const op of input.model.operations) {
    const merged = mergeDeclarations(input.offering.paramDeclarations, op.operation);
    violations.push(...checkOperatorSubset(merged, op.operation));
    violations.push(...checkDefaultsInDomain(merged, op.operation, op.params));
    if (input.saleCard !== undefined) {
      violations.push(...checkBillingTranslations(merged, op.operation, op.params, input.saleCard));
    }
  }
  return violations;
}

// --- gate 2: operator variant ⊆ upstream domain (invariant ①) ----------------------

/**
 * Invariant ① (存在性 + 值域): every operator-origin row may only constrain to
 * values the upstream declaration actually serves. Checked per merged param:
 *
 * - EXISTENCE: an upstream `unsupported` admits NOTHING — any operator row
 *   other than `unsupported` (a re-enable, a pin, a translation) widens it.
 * - `supports`: claims the FULL canonical domain — widens any upstream
 *   domain/fixed/unsupported narrowing.
 * - `fixed`: the pinned value must be admitted by the upstream constraint.
 * - `domain`: every discrete value must be admitted; a numeric range must sit
 *   INSIDE the upstream range (an unbounded operator side over a bounded
 *   upstream side widens); an operator RANGE over a DISCRETE upstream domain
 *   is rejected as unverifiable (declare the discrete subset instead — the
 *   gate forces honest config, never guesses).
 * - operator `map`: its discrete canonical keys must be values the upstream
 *   serves (translating an un-served value is dead config that masks a §4
 *   filter hole). `scale`/`offset` translate OUTPUT values and never widen the
 *   served set — no subset check (tier honesty is gate 4's).
 */
function checkOperatorSubset(
  merged: Map<string, MergedParamDecl>,
  operation: Operation,
): EnableGateViolation[] {
  const violations: EnableGateViolation[] = [];
  const violate = (param: string, message: string): void => {
    violations.push({ gate: 'operator_subset', param, operation, message });
  };

  for (const [param, decl] of merged) {
    const hasOperatorRow = decl.opConstraint !== undefined || decl.opMap !== undefined;
    if (!hasOperatorRow) continue;
    const up = decl.upConstraint;

    // Existence: upstream `unsupported` admits nothing.
    if (up?.kind === 'unsupported' && decl.opConstraint?.kind !== 'unsupported') {
      violate(
        param,
        `operator declares '${decl.opConstraint?.kind ?? 'map'}' on a param the upstream marked unsupported (运营者不可放宽)`,
      );
      continue;
    }

    const opC = decl.opConstraint;
    if (opC !== undefined) {
      switch (opC.kind) {
        case 'unsupported':
          break; // pure tightening — always ⊆.
        case 'supports':
          if (up !== undefined && up.kind !== 'supports') {
            violate(
              param,
              `operator 'supports' (full domain) widens the upstream '${up.kind}' declaration`,
            );
          }
          break;
        case 'fixed':
          if (!admitsValue(up, opC.value)) {
            violate(
              param,
              `operator pins value ${stringifyValue(opC.value)} outside the upstream ${up?.kind ?? ''} domain`,
            );
          }
          break;
        case 'domain': {
          for (const v of opC.values ?? []) {
            if (!admitsValue(up, v)) {
              violate(
                param,
                `operator domain value ${stringifyValue(v)} is outside the upstream ${up?.kind ?? ''} domain`,
              );
            }
          }
          if (opC.min !== undefined || opC.max !== undefined) {
            const rangeViolation = rangeSubsetViolation(opC, up);
            if (rangeViolation !== undefined) violate(param, rangeViolation);
          }
          break;
        }
      }
    }

    if (decl.opMap?.values !== undefined && up !== undefined && up.kind !== 'supports') {
      for (const key of Object.keys(decl.opMap.values)) {
        if (!admitsKey(up, key)) {
          violate(
            param,
            `operator map translates canonical value '${key}' which the upstream ${up.kind} domain does not serve`,
          );
        }
      }
    }
  }
  return violations;
}

/** The [min,max] containment leg of gate 2: the operator range must sit inside the upstream one. */
function rangeSubsetViolation(
  opC: Extract<ConstraintRule, { kind: 'domain' }>,
  up: ConstraintRule | undefined,
): string | undefined {
  if (up === undefined || up.kind === 'supports') return undefined;
  if (up.kind === 'fixed') {
    return `operator declares a numeric range over an upstream fixed pin (${stringifyValue(up.value)}) — declare fixed or drop the row`;
  }
  if (up.kind === 'unsupported') return 'operator range over an upstream-unsupported param';
  // up.kind === 'domain'
  if (up.values !== undefined && up.min === undefined && up.max === undefined) {
    return 'operator declares a numeric range over a DISCRETE upstream domain — declare the discrete subset instead';
  }
  if (up.min !== undefined && (opC.min === undefined || opC.min < up.min)) {
    return `operator range min ${String(opC.min ?? '-∞')} falls below the upstream min ${String(up.min)}`;
  }
  if (up.max !== undefined && (opC.max === undefined || opC.max > up.max)) {
    return `operator range max ${String(opC.max ?? '+∞')} exceeds the upstream max ${String(up.max)}`;
  }
  return undefined;
}

// --- gate 3: canonical default ⊆ offering domain (invariant ②) ----------------------

/**
 * Invariant ②: a canonical default resolves by PASSTHROUGH at runtime (§4
 * rule 3 exempts non-billing defaults from filtering; the resolver never
 * clamps) — so an enabled offering's WINNING constraint must admit every
 * canonical default, or the out-of-domain value goes upstream as-is.
 * `fixed` overrides the default (admitted by pin); `unsupported` excludes the
 * param from both bags (nothing is sent — a REQUIRED upstream param is the
 * upstream contract author's concern, not a domain violation).
 */
function checkDefaultsInDomain(
  merged: Map<string, MergedParamDecl>,
  operation: Operation,
  canonicalParams: CanonicalParam[],
): EnableGateViolation[] {
  const violations: EnableGateViolation[] = [];
  for (const param of canonicalParams) {
    if (param.default === undefined) continue;
    const decl = merged.get(param.name);
    const constraint = decl?.opConstraint ?? decl?.upConstraint;
    if (constraint === undefined || constraint.kind === 'supports') continue;
    if (constraint.kind === 'fixed' || constraint.kind === 'unsupported') continue;
    if (!admitsValue(constraint, param.default)) {
      violations.push({
        gate: 'default_in_domain',
        param: param.name,
        operation,
        message: `canonical default ${stringifyValue(param.default)} falls outside the offering's declared domain — runtime passthrough would send an out-of-domain value upstream`,
      });
    }
  }
  return violations;
}

// --- gate 4: billing translation must not cross price tiers (invariant ③) ---------------

/**
 * Invariant ③ (毛利倒挂防线): billingDims ALWAYS key off the CANONICAL
 * effective value (§4 rule 2), so an upstream translation that changes what
 * the SALE card would price (canonical "720p" charged, upstream wire "1080p"
 * delivered) inverts the margin. Per billing_relevant param:
 *
 * - enumerate the CANONICAL values the offering can serve (fixed pin, else
 *   declared discrete domains, else the contract's own values/default);
 * - translate each through the EXACT runtime precedence
 *   ({@link translateUpstreamValue});
 * - a translated pair must price IDENTICALLY on the sale card:
 *   · `matrix` (param ∈ key): every table row keyed by the canonical value must
 *     have a sibling row (upstream value substituted) with the SAME cell price;
 *   · `unit`/`credits` (param ∈ dimensions): the price is LINEAR in the value —
 *     any numeric change crosses tiers;
 *   · `formula` (expr references the param): statically unverifiable → rejected
 *     conservatively;
 *   · a spec the param does not price (fixed/passthrough/model_token, or not a
 *     dimension/key) cannot cross tiers → OK.
 * - a non-identity `scale`/`offset` on a billing param is ALWAYS rejected when
 *   the param prices (a linear rescale is exactly the hazard, and its full
 *   numeric domain cannot be enumerated).
 */
function checkBillingTranslations(
  merged: Map<string, MergedParamDecl>,
  operation: Operation,
  canonicalParams: CanonicalParam[],
  saleCard: EnableGateSaleCard,
): EnableGateViolation[] {
  const violations: EnableGateViolation[] = [];
  for (const param of canonicalParams) {
    if (!param.billingRelevant) continue;
    const decl = merged.get(param.name);
    if (decl === undefined) continue; // no declarations → passthrough → identity.
    if (!paramPricesOnCard(saleCard.spec, param.name)) continue;

    const violate = (message: string): void => {
      violations.push({ gate: 'billing_translation_tier', param: param.name, operation, message });
    };

    // Non-identity linear translation on a priced param: reject outright.
    for (const map of [decl.opMap, decl.upMap]) {
      if (map === undefined) continue;
      const scale = map.scale ?? 1;
      const offset = map.offset ?? 0;
      if ((map.scale !== undefined || map.offset !== undefined) && (scale !== 1 || offset !== 0)) {
        violate(
          `linear translation (scale ${String(scale)}, offset ${String(offset)}) on a billing-relevant param cannot be tier-safe — the sale card prices the canonical value`,
        );
      }
    }

    for (const canonicalValue of candidateBillingValues(decl, param)) {
      const upstreamValue = translateUpstreamValue(canonicalValue, decl);
      if (sameWireValue(canonicalValue, upstreamValue)) continue;
      const mismatch = tierMismatch(saleCard.spec, param.name, canonicalValue, upstreamValue);
      if (mismatch !== undefined) {
        violate(
          `translation ${stringifyValue(canonicalValue)} → ${stringifyValue(upstreamValue)} ${mismatch}`,
        );
      }
    }
  }
  return violations;
}

/** Does the sale card's spec price this param at all? (Specs it does not price cannot cross tiers.) */
function paramPricesOnCard(spec: PriceSpec, param: string): boolean {
  switch (spec.method) {
    case 'matrix':
      return spec.key.includes(param) || spec.multiplier === param || spec.perItem === param;
    case 'unit':
    case 'credits':
      return Object.hasOwn(spec.dimensions, param);
    case 'formula':
      return spec.expr.includes(param);
    default:
      return false;
  }
}

/**
 * The canonical values invariant 3 checks a param over: the fixed pin when one
 * wins, else every discrete value the declarations/map/contract mention. A
 * purely numeric-range domain has no finite enumeration — its exposure is the
 * `scale`/`offset` rule above (discrete `map.values` keys still enumerate).
 */
function candidateBillingValues(decl: MergedParamDecl, param: CanonicalParam): unknown[] {
  const winning = decl.opConstraint ?? decl.upConstraint;
  if (winning?.kind === 'fixed') return [winning.value];
  if (winning?.kind === 'unsupported') return [];
  const values = new Map<string, unknown>();
  const add = (v: unknown): void => {
    if (!admitsValue(winning, v)) return; // un-served values never resolve — not a tier concern.
    values.set(stringifyValue(v), v);
  };
  for (const c of [decl.opConstraint, decl.upConstraint]) {
    if (c?.kind === 'domain') for (const v of c.values ?? []) add(v);
  }
  for (const m of [decl.opMap, decl.upMap]) {
    for (const key of Object.keys(m?.values ?? {})) add(key);
  }
  for (const v of param.values ?? []) add(v);
  if (param.default !== undefined) add(param.default);
  return [...values.values()];
}

/**
 * Do the canonical and translated values price to the SAME tier on the sale
 * card? Returns the mismatch description, or `undefined` when tier-safe.
 * String-level comparison is FAITHFUL to the pricing engine: `priceMatrix`
 * keys cells by `String(params[k])` and unit/credits coerce via `Number`.
 */
function tierMismatch(
  spec: PriceSpec,
  param: string,
  canonicalValue: unknown,
  upstreamValue: unknown,
): string | undefined {
  switch (spec.method) {
    case 'matrix': {
      if (spec.multiplier === param || spec.perItem === param) {
        return numericMismatch(canonicalValue, upstreamValue, 'multiplies the matrix price');
      }
      const idx = spec.key.indexOf(param);
      if (idx === -1) return undefined;
      const canonicalKey = String(canonicalValue);
      const upstreamKey = String(upstreamValue);
      for (const [key, cell] of Object.entries(spec.table)) {
        const parts = key.split('|');
        if (parts[idx] !== canonicalKey) continue;
        const sibling = [...parts];
        sibling[idx] = upstreamKey;
        const siblingCell = spec.table[sibling.join('|')];
        if (siblingCell === undefined) {
          return `crosses price tiers: the sale card prices '${canonicalKey}' but has no cell for the delivered '${upstreamKey}'`;
        }
        if (siblingCell !== cell) {
          return `crosses price tiers: '${canonicalKey}' prices ${String(cell)} but the delivered '${upstreamKey}' prices ${String(siblingCell)}`;
        }
      }
      // A canonical value the card never prices quotes as price_key_not_found
      // at runtime — needs_pricing territory, not a translation-tier concern.
      return undefined;
    }
    case 'unit':
    case 'credits':
      return numericMismatch(canonicalValue, upstreamValue, 'prices linearly per unit');
    case 'formula':
      return `is statically unverifiable against a formula sale card referencing '${param}' — pin identical values or re-card`;
    default:
      return undefined;
  }
}

function numericMismatch(
  canonicalValue: unknown,
  upstreamValue: unknown,
  how: string,
): string | undefined {
  const c = Number(canonicalValue);
  const u = Number(upstreamValue);
  if (Number.isFinite(c) && Number.isFinite(u) && c === u) return undefined;
  return `crosses price tiers: the param ${how}, so the charged (${stringifyValue(canonicalValue)}) and delivered (${stringifyValue(upstreamValue)}) quantities must be equal`;
}

// --- shared admission / value helpers -----------------------------------------------

/**
 * Is `value` admitted by a constraint rule? `undefined`/`supports` admit all;
 * `unsupported` admits none; `fixed` admits exactly its pin; `domain` admits
 * its discrete values (string-compared, the `map.values`/matrix key
 * convention) intersected with its numeric bounds.
 */
function admitsValue(c: ConstraintRule | undefined, value: unknown): boolean {
  if (c === undefined || c.kind === 'supports') return true;
  if (c.kind === 'unsupported') return false;
  if (c.kind === 'fixed') return sameWireValue(c.value, value);
  if (c.values !== undefined && !c.values.some((v) => sameWireValue(v, value))) return false;
  if (typeof value === 'number') {
    if (c.min !== undefined && value < c.min) return false;
    if (c.max !== undefined && value > c.max) return false;
  } else if (c.values === undefined) {
    // A pure numeric-bounds domain cannot admit a non-numeric value.
    return false;
  }
  return true;
}

/** Gate-2 map-key admission: `map.values` keys are STRINGIFIED canonical values. */
function admitsKey(c: ConstraintRule | undefined, key: string): boolean {
  if (admitsValue(c, key)) return true;
  const asNumber = Number(key);
  return Number.isFinite(asNumber) && admitsValue(c, asNumber);
}

/** The string form pricing addresses a primitive by (`priceMatrix` cells / `map.values` keys); non-primitives have none. */
function wireKey(v: unknown): string | undefined {
  switch (typeof v) {
    case 'string':
      return v;
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(v);
    default:
      return undefined;
  }
}

/** Loose wire-level equality: `priceMatrix`/`map.values` address by the stringified primitive. */
function sameWireValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const ka = wireKey(a);
  return ka !== undefined && ka === wireKey(b);
}

function stringifyValue(value: unknown): string {
  const key = wireKey(value);
  if (typeof value === 'string') return `'${value}'`;
  if (key !== undefined) return key;
  // Declaration values are zod-parsed JSONB — undefined is the only
  // JSON.stringify-hostile shape that can reach here.
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value);
  } catch {
    return '[unstringifiable]';
  }
}
