import type { Modifier, PricebookEntry, UsageVector } from '@actionow/contracts';
import {
  type AppliedModifier,
  applyModifiers,
  type MicroCredits,
  quote,
  settle,
} from '@actionow/domain';

export interface FinalCost {
  /** The single rounding/charge amount in µcredits (integer). */
  credits: MicroCredits;
  /** The modifiers that fired, for the settle ledger audit trail. */
  applied: AppliedModifier[];
}

/**
 * The JSON-safe shape of one applied-modifier audit row. The µcredit `before`/
 * `after` are serialized as decimal strings (bigint is not JSON-serializable),
 * mirroring how money is serialized everywhere else on the wire.
 */
export interface AppliedModifierAudit {
  id: string;
  version: number;
  before: string;
  after: string;
}

/**
 * Convert the modifier audit trail to a JSON-safe form for the `modifiers_applied`
 * jsonb column / ledger snapshot. Without this, persisting an `AppliedModifier`
 * (whose `before`/`after` are bigint) throws "Do not know how to serialize a
 * BigInt" the moment any modifier fires.
 */
export function serializeAppliedModifiers(applied: AppliedModifier[]): AppliedModifierAudit[] {
  return applied.map((a) => ({
    id: a.id,
    version: a.version,
    before: a.before.toString(),
    after: a.after.toString(),
  }));
}

/**
 * Compute the final settle cost for a completed run. `post`-timed entries price
 * the observed `usage` via `settle`; `pre`-timed entries re-confirm the quote
 * from the original `inputs`. The modifier stack then applies, producing the
 * single integer µcredit charge (§4.2 "唯一取整时机").
 */
export function computeFinalCost(
  entry: PricebookEntry,
  usage: UsageVector,
  inputs: Record<string, unknown>,
  modifiers: Modifier[],
): FinalCost {
  const base = entry.timing === 'post' ? settle(entry, usage) : quote(entry, inputs);
  const { final, applied } = applyModifiers(base, modifiers);
  return { credits: final, applied };
}

/**
 * The final settle charge for a completed run, CAPPED at the placed hold — the
 * engine never settles above what it reserved (and floors at 0). A no-usage
 * success charges the held upper bound rather than the empty-usage 0 (never leak
 * revenue: provider units consumed but unbilled).
 *
 * This is the SINGLE source of truth shared by the streaming, blocking, and async
 * settle paths. The cap binds ONLY when a real reservation was placed
 * (`holdAmount > 0`): a caller who under-estimates `estimated_usage` can then never
 * push the real charge above the (balance-gated) hold and drive the wallet
 * negative — the operator absorbs the bounded overage, exactly as the streaming
 * path already did. A `holdAmount` of 0 is the "no reservation, charge the real
 * metered cost" discipline (chat blocking, which sets `holdFloor: 0`); capping such
 * a run to 0 would make it free, so the cap is skipped there. Media post-unit holds
 * are floored by `minimumHold` (in `computeHold`), so they are always > 0 and thus
 * always capped.
 */
export function settledCost(
  entry: PricebookEntry,
  usage: UsageVector,
  inputs: Record<string, unknown>,
  modifiers: Modifier[],
  holdAmount: bigint,
): FinalCost {
  const hasUsage = Object.keys(usage).length > 0;
  const { credits: computed, applied } = computeFinalCost(entry, usage, inputs, modifiers);
  const candidate = hasUsage ? computed : holdAmount;
  let finalCost = candidate < 0n ? 0n : candidate;
  if (holdAmount > 0n && finalCost > holdAmount) finalCost = holdAmount;
  return { credits: finalCost, applied };
}
