// packages/engine/src/planner/param-filter.ts
//
// model-supply-greenfield 批次3 — §4 parameter-aware candidate filtering (路由
// 5 规则). Runs BEFORE offering selection: judges every candidate offering's
// declarations against the request's canonical params, rejects candidates
// that cannot honestly serve the request, and resolves EffectiveParams for
// each survivor (§4.1 layer 2, effective-params.ts).
//
// The five routing rules (§4), each implemented here:
//   1. explicit params (isDefault: false) filter on existence + domain — an
//      `unsupported` declaration rejects the candidate; a `domain` must
//      contain the explicit value.
//   2. billing_relevant params are FORCED through filtering on their RESOLVED
//      value (explicit or default): domain must contain it, fixed must equal
//      it — the margin-inversion killer (never "charge 720p, pay for 1080p").
//      This applies to default values too, and lenient mode NEVER relaxes it.
//   3. non-billing default values do NOT participate in filtering; the
//      selected offering's declarations resolve them afterwards.
//   4. all candidates filtered ⇒ GatewayError `unsupported_parameter` whose
//      details state WHICH param excluded WHICH offerings. strict is the
//      default; lenient (explicit opt-in) drops non-billing unsupported
//      EXPLICIT params instead of rejecting — and every drop is echoed in
//      warnings[] (静默 dropUnsupported is abolished).
//   5. stateless + pure: failover/降级链 re-runs this on each hop's candidate
//      subset; calling it again on the survivors is a fixed point.
//
// PURE LOGIC — no I/O, no db, no state.
import type {
  BillingDims,
  CanonicalParam,
  CanonicalParamValue,
  EffectiveParams,
  GatewayError,
  GatewayWarning,
  OfferingParamDecl,
  Operation,
  ParamDeclRule,
} from '@actionow/contracts';

import {
  type ConstraintRule,
  mergeDeclarations,
  type MergedParamDecl,
  resolveEffectiveParams,
  resolveRequestValue,
} from './effective-params.js';

/** Warning code echoed for every lenient-mode drop (§4 rule 4: 丢弃必回显). */
export const PARAMETER_DROPPED_WARNING = 'parameter_dropped';

export type FilterMode = 'strict' | 'lenient';

export interface FilterCandidate {
  offeringId: string;
  /** The offering's param_declarations (full table or pre-scoped; operation scoping is applied here). */
  declarations: OfferingParamDecl[];
}

export interface FilterCandidatesInput {
  operation: Operation;
  /** The operation's canonical param contract (model.operations[op].params, §4). */
  canonicalParams: CanonicalParam[];
  /** GatewayRequest.params — explicit-vs-default tagged (§4.1 layer 1). */
  requestParams: Record<string, CanonicalParamValue>;
  candidates: FilterCandidate[];
  /** Default 'strict'. 'lenient' is the explicit opt-in of §4 rule 4. */
  mode?: FilterMode;
}

export interface FilterSurvivor {
  offeringId: string;
  /** §4.1 layer-2 resolution for THIS offering (canonical + upstream bags). */
  effective: EffectiveParams;
  billingDims: BillingDims;
  /** Params this offering dropped in lenient mode (each is also echoed in FilterResult.warnings). */
  dropped?: string[];
}

export interface FilterRejection {
  offeringId: string;
  /** The canonical param that excluded this offering (§4 rule 4 error details). */
  param: string;
  reason: string;
}

export interface FilterResult {
  survivors: FilterSurvivor[];
  rejected: FilterRejection[];
  /** Lenient-mode drop echoes (§4 rule 4) — empty in strict mode. */
  warnings: GatewayWarning[];
  /** Set iff candidates existed and param filtering excluded them ALL (§4 rule 4). */
  error?: GatewayError;
}

/**
 * §4 parameter-aware candidate filtering. Pure and stateless — call it per
 * failover hop on that hop's candidate subset (§4 rule 5). Survivors carry
 * their own EffectiveParams + billingDims so the selector (批次3 slice 3) can
 * rank and hand the chosen offering's upstream bag straight to adapter
 * aspect ①.
 */
export function filterCandidates(input: FilterCandidatesInput): FilterResult {
  const mode: FilterMode = input.mode ?? 'strict';
  const survivors: FilterSurvivor[] = [];
  const rejected: FilterRejection[] = [];
  /** param name → offering ids that dropped it (lenient), for the warning echo. */
  const droppedBy = new Map<string, string[]>();

  for (const candidate of input.candidates) {
    const merged = mergeDeclarations(candidate.declarations, input.operation);
    let rejection: FilterRejection | undefined;
    const dropped: string[] = [];

    for (const param of input.canonicalParams) {
      const verdict = judgeParam(param, merged.get(param.name), input.requestParams, mode);
      if (verdict.kind === 'reject') {
        rejection = {
          offeringId: candidate.offeringId,
          param: param.name,
          reason: verdict.reason,
        };
        break;
      }
      if (verdict.kind === 'drop') dropped.push(param.name);
    }

    if (rejection !== undefined) {
      rejected.push(rejection);
      continue;
    }

    // Rule 5 note: a lenient drop needs no special handling here — the drop
    // verdict only ever fires on an `unsupported` winning constraint, which
    // resolveEffectiveParams already excludes from both bags.
    const { effective, billingDims } = resolveEffectiveParams({
      operation: input.operation,
      canonicalParams: input.canonicalParams,
      requestParams: input.requestParams,
      declarations: candidate.declarations,
    });
    survivors.push(
      dropped.length > 0
        ? { offeringId: candidate.offeringId, effective, billingDims, dropped }
        : { offeringId: candidate.offeringId, effective, billingDims },
    );
    for (const name of dropped) {
      const list = droppedBy.get(name) ?? [];
      list.push(candidate.offeringId);
      droppedBy.set(name, list);
    }
  }

  const warnings: GatewayWarning[] = [...droppedBy.entries()].map(([param, offeringIds]) => ({
    code: PARAMETER_DROPPED_WARNING,
    message: `explicit param '${param}' is unsupported by offering(s) ${offeringIds.join(', ')} and was dropped (lenient mode)`,
    param,
  }));

  const result: FilterResult = { survivors, rejected, warnings };
  if (survivors.length === 0 && rejected.length > 0) {
    result.error = allFilteredError(rejected);
  }
  return result;
}

type ParamVerdict = { kind: 'pass' } | { kind: 'drop' } | { kind: 'reject'; reason: string };

/**
 * Judge ONE canonical param against ONE candidate's merged declarations.
 *
 * Only CONSTRAINT-aspect rows (supports/domain/fixed/unsupported) participate:
 * `map` rows are the TRANSLATION aspect and never change the filter domain
 * (翻译不改过滤域) — they apply at resolution time (effective-params.ts).
 *
 * Existence (`unsupported`) follows the WINNING constraint (operator >
 * upstream), mirroring resolveEffectiveParams so filter and resolution never
 * disagree on whether a param is served. Value constraints (domain membership
 * / fixed equality) are checked against BOTH origins' constraint rows — an
 * operator row may only TIGHTEN the upstream's constraints (运营者可收紧不可
 * 放宽), so the honest runtime check is the intersection; the ⊆ invariant
 * itself is validated at config time (offering enable / golden probe), not
 * silently patched here.
 */
function judgeParam(
  param: CanonicalParam,
  decl: MergedParamDecl | undefined,
  requestParams: Record<string, CanonicalParamValue>,
  mode: FilterMode,
): ParamVerdict {
  const winning = decl?.opConstraint ?? decl?.upConstraint;
  const rows: ConstraintRule[] = [];
  if (decl?.opConstraint !== undefined) rows.push(decl.opConstraint);
  if (decl?.upConstraint !== undefined) rows.push(decl.upConstraint);

  // --- rule 2: billing_relevant filters on the RESOLVED value, default or not.
  if (param.billingRelevant) {
    const effectiveValue = resolveRequestValue(param, requestParams);
    // No resolvable value (optional billing param, no default): nothing to
    // judge; a fixed row will still honestly materialize its value into
    // billingDims at resolution time.
    if (effectiveValue === undefined) return { kind: 'pass' };
    if (winning?.kind === 'unsupported') {
      // Not lenient-droppable: an unverifiable billing dimension IS the
      // margin-inversion hazard rule 2 exists to kill.
      return {
        kind: 'reject',
        reason: `billing_relevant param '${param.name}' is unsupported by this offering`,
      };
    }
    for (const rule of rows) {
      if (rule.kind === 'domain' && !inDomain(effectiveValue, rule)) {
        return {
          kind: 'reject',
          reason: `billing_relevant param '${param.name}' effective value ${fmt(effectiveValue)} is outside the offering's domain`,
        };
      }
      if (rule.kind === 'fixed' && !valuesEqual(rule.value, effectiveValue)) {
        return {
          kind: 'reject',
          reason: `offering pins billing_relevant param '${param.name}' to ${fmt(rule.value)} but the effective value is ${fmt(effectiveValue)}`,
        };
      }
    }
    return { kind: 'pass' };
  }

  // --- rule 3: non-billing defaults do not filter.
  const carried = requestParams[param.name];
  if (carried === undefined) return { kind: 'pass' };
  if (carried.isDefault) return { kind: 'pass' };
  const explicitValue = carried.value;
  if (explicitValue === undefined) return { kind: 'pass' };

  // --- rule 1: explicit params filter on existence + domain.
  if (winning?.kind === 'unsupported') {
    if (mode === 'lenient') return { kind: 'drop' };
    return {
      kind: 'reject',
      reason: `explicit param '${param.name}' is unsupported by this offering`,
    };
  }
  for (const rule of rows) {
    if (rule.kind === 'domain' && !inDomain(explicitValue, rule)) {
      return {
        kind: 'reject',
        reason: `explicit param '${param.name}' value ${fmt(explicitValue)} is outside the offering's domain`,
      };
    }
    // A fixed pin the explicit ask disagrees with cannot be honored honestly —
    // serving would silently override the caller (值域 of size 1).
    if (rule.kind === 'fixed' && !valuesEqual(rule.value, explicitValue)) {
      return {
        kind: 'reject',
        reason: `offering pins param '${param.name}' to ${fmt(rule.value)} but the request explicitly asks for ${fmt(explicitValue)}`,
      };
    }
  }
  return { kind: 'pass' };
}

type DomainRule = Extract<ParamDeclRule, { kind: 'domain' }>;

/**
 * Domain membership: the discrete `values` list and the numeric `min`/`max`
 * range are alternative witnesses — a value is in-domain when either admits
 * it. A non-numeric value can only be admitted by `values`.
 */
function inDomain(value: unknown, rule: DomainRule): boolean {
  if (rule.values?.some((v) => Object.is(v, value))) return true;
  if ((rule.min !== undefined || rule.max !== undefined) && typeof value === 'number') {
    return (
      (rule.min === undefined || value >= rule.min) && (rule.max === undefined || value <= rule.max)
    );
  }
  return false;
}

/**
 * Equality for fixed-vs-effective checks: `Object.is` for primitives (NaN is
 * self-equal, NaN ≠ Infinity), STRUCTURAL deep equality for objects — arrays
 * compare element-wise IN ORDER; plain objects compare by KEY SET (never key
 * order), and a key present with value `undefined` is distinct from an absent
 * key. (JSON.stringify comparison is banned here: it is key-order sensitive —
 * false 400s — and collapses NaN/Infinity/undefined to null — false serves.)
 */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => valuesEqual(v, b[i]));
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  const recA = a as Record<string, unknown>;
  const recB = b as Record<string, unknown>;
  return keysA.every((k) => Object.hasOwn(recB, k) && valuesEqual(recA[k], recB[k]));
}

function fmt(value: unknown): string {
  try {
    // JSON.stringify is TYPED `string` but returns undefined at runtime for
    // undefined/function/symbol inputs — hence the widening assertion.
    const s = JSON.stringify(value) as string | undefined;
    return s ?? String(value);
  } catch {
    return String(value);
  }
}

/** §4 rule 4: every candidate fell — build the unsupported_parameter error with per-param exclusion details. */
function allFilteredError(rejected: FilterRejection[]): GatewayError {
  const excludedBy: Record<string, string[]> = {};
  for (const r of rejected) {
    (excludedBy[r.param] ??= []).push(r.offeringId);
  }
  const params = Object.keys(excludedBy)
    .map((p) => `'${p}'`)
    .join(', ');
  return {
    code: 'unsupported_parameter',
    message: `no offering can serve the request: param(s) ${params} excluded every candidate`,
    retryable: false,
    failover: false,
    details: {
      excludedBy,
      rejections: rejected.map((r) => ({
        offeringId: r.offeringId,
        param: r.param,
        reason: r.reason,
      })),
    },
  };
}
