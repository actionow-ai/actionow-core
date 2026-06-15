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
