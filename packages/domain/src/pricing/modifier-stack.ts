import type { Modifier } from '@actionow/contracts';

import { applyPercent, type MicroCredits } from '../credits.js';
import { DomainError } from '../errors.js';

/** One audit row: the modifier that fired and the value it transformed. */
export interface AppliedModifier {
  id: string;
  version: number;
  before: MicroCredits;
  after: MicroCredits;
}

export interface ApplyModifiersResult {
  final: MicroCredits;
  applied: AppliedModifier[];
}

function clampNonNegative(value: MicroCredits): MicroCredits {
  return value < 0n ? 0n : value;
}

/** Compute the result of a single modifier op against the running value. */
function applyOne(running: MicroCredits, modifier: Modifier): MicroCredits {
  if (modifier.value === undefined) {
    throw new DomainError('invalid_pricing', `modifier "${modifier.id}" is missing a value`);
  }
  const value = modifier.value;
  switch (modifier.op) {
    case 'override_rate':
      return clampNonNegative(BigInt(value));
    case 'percent_off':
      return clampNonNegative(applyPercent(running, -value));
    case 'flat_off':
      return clampNonNegative(running - BigInt(value));
    case 'percent_add':
      return clampNonNegative(applyPercent(running, value));
  }
}

/**
 * Apply a list of modifiers to a base µcredit price.
 *
 * Modifiers are processed in ascending `priority` (§9.2: tenant override=0,
 * volume tier=1, promo/coupon=2, publisher markup=3). Within a single priority
 * group only one modifier fires: the one that yields the value most favorable
 * to the buyer (the lowest result). The running value is clamped at zero after
 * every step and never falls below it. Each fired modifier is recorded for the
 * caller to persist as an audit trail.
 */
export function applyModifiers(base: MicroCredits, modifiers: Modifier[]): ApplyModifiersResult {
  const byPriority = new Map<number, Modifier[]>();
  for (const modifier of modifiers) {
    const group = byPriority.get(modifier.priority);
    if (group === undefined) {
      byPriority.set(modifier.priority, [modifier]);
    } else {
      group.push(modifier);
    }
  }

  const priorities = [...byPriority.keys()].sort((a, b) => a - b);
  const applied: AppliedModifier[] = [];
  let running = clampNonNegative(base);

  for (const priority of priorities) {
    const group = byPriority.get(priority) ?? [];
    let best: { modifier: Modifier; after: MicroCredits } | undefined;
    for (const modifier of group) {
      const after = applyOne(running, modifier);
      if (best === undefined || after < best.after) {
        best = { modifier, after };
      }
    }
    if (best === undefined) continue;
    applied.push({
      id: best.modifier.id,
      version: best.modifier.version,
      before: running,
      after: best.after,
    });
    running = best.after;
  }

  return { final: running, applied };
}
