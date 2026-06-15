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
