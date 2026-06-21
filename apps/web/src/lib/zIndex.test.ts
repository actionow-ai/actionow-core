import { describe, expect, test } from 'vitest';

import { Z } from './zIndex';

describe('Z (z-index ladder)', () => {
  test('overlay layers stack in the intended order', () => {
    // Anchored popovers (Select/Combobox/column menus) must sit above the
    // modal/drawer scrim so a dropdown opened inside a modal is visible.
    expect(Z.popover).toBeGreaterThan(Z.scrim);
    // Toasts must paint above an open modal — the bug today is they share the
    // popover plane and the backdrop, so they can hide behind / collide.
    expect(Z.toast).toBeGreaterThan(Z.scrim);
    expect(Z.toast).toBeGreaterThan(Z.popover);
    // Tooltips are transient and topmost — above popovers and toasts.
    expect(Z.tooltip).toBeGreaterThan(Z.popover);
    expect(Z.tooltip).toBeGreaterThan(Z.toast);
    // App chrome (sticky nav / bottom tabs) sits below the scrim so overlays
    // cover it; content sits below chrome; background is the floor.
    expect(Z.scrim).toBeGreaterThan(Z.nav);
    expect(Z.nav).toBeGreaterThan(Z.base);
    expect(Z.base).toBeGreaterThan(Z.background);
  });

  test('every layer is a finite non-negative integer', () => {
    for (const v of Object.values(Z)) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });
});
