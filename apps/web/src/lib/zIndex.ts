/**
 * The single source of truth for stacking order. Before this, z-index was
 * scattered magic numbers (0, 1, 30, 40, 60, 80, 90, 95) with collisions —
 * notably toasts sharing the popover plane and rendering behind/over modals.
 *
 * Layers are spaced by 100 so intermediate values can be slotted without a
 * renumber. Keep this mirrored with the `--z-*` CSS custom properties in
 * `styles/theme.css` (CSS-positioned layers like the rail `.ico-tip` read the
 * vars; JS inline styles read this object).
 *
 * Order (low → high): background < base content < app chrome (nav/tabs) <
 * modal/drawer scrim < anchored popovers < toasts < tooltips.
 */
export const Z = {
  /** Fixed decorative backdrop (AppBackground). */
  background: 0,
  /** In-flow page/app content. */
  base: 1,
  /** App chrome that floats over content but under overlays: sticky nav, mobile bottom tabs. */
  nav: 40,
  /** Modal & Drawer backdrop (scrim) + the dialog it contains. */
  scrim: 100,
  /** Anchored popovers portaled to <body>: Select, Combobox, DataTable column menu. */
  popover: 200,
  /** Toasts — must sit above an open modal, not behind it. */
  toast: 300,
  /** Tooltips — transient and topmost. */
  tooltip: 400,
} as const;

export type ZLayer = keyof typeof Z;
