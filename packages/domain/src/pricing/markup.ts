import type { Markup } from '@actionow/contracts';

import { applyPercent, type MicroCredits } from '../credits.js';

/** Apply a pricebook markup: `percent` via round-half-up, `flat` as +µcredits, undefined = identity. */
export function applyMarkup(base: MicroCredits, markup: Markup | undefined): MicroCredits {
  if (markup === undefined) return base;
  return markup.type === 'percent' ? applyPercent(base, markup.value) : base + BigInt(markup.value);
}
