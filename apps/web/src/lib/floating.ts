/**
 * Pure geometry for anchored floating elements (tooltips, popovers). Kept free
 * of the DOM so the flip/clamp logic is unit-testable without layout; the
 * `Floating` component (components/ui/Floating.tsx) feeds it real
 * `getBoundingClientRect()` measurements and re-runs it on scroll/resize.
 *
 * Vertical: place on the requested side, flip to the opposite side only when the
 * requested side would overflow the viewport AND the opposite side fits.
 * Horizontal: align (center over the trigger, or start-aligned to its left edge)
 * then clamp into the viewport so the content never spills off-screen.
 */
export type Placement = 'top' | 'bottom';
export type Align = 'center' | 'start';

export interface AnchorRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
}
export interface Size {
  width: number;
  height: number;
}
export interface Viewport {
  width: number;
  height: number;
}

export interface AnchorArgs {
  trigger: AnchorRect;
  content: Size;
  viewport: Viewport;
  placement: Placement;
  align: Align;
  /** Gap between trigger edge and content, in px. */
  gap: number;
  /** Minimum distance kept from each viewport edge, in px. */
  margin: number;
}

export interface AnchorResult {
  left: number;
  top: number;
  /** The side actually used after flip resolution. */
  placement: Placement;
}

export function computeAnchoredPosition(a: AnchorArgs): AnchorResult {
  const { trigger, content, viewport, align, gap, margin } = a;

  // --- Vertical: requested side, with a flip when it would overflow. -------
  const topIfAbove = trigger.top - content.height - gap;
  const topIfBelow = trigger.bottom + gap;
  let placement = a.placement;
  if (placement === 'top') {
    const overflowsAbove = topIfAbove < margin;
    const fitsBelow = topIfBelow + content.height <= viewport.height - margin;
    if (overflowsAbove && fitsBelow) placement = 'bottom';
  } else {
    const overflowsBelow = topIfBelow + content.height > viewport.height - margin;
    const fitsAbove = topIfAbove >= margin;
    if (overflowsBelow && fitsAbove) placement = 'top';
  }
  const top = placement === 'top' ? topIfAbove : topIfBelow;

  // --- Horizontal: align then clamp into the viewport. ---------------------
  let left =
    align === 'center' ? trigger.left + trigger.width / 2 - content.width / 2 : trigger.left;
  const maxLeft = viewport.width - margin - content.width;
  if (left > maxLeft) left = maxLeft;
  if (left < margin) left = margin;

  return { left, top, placement };
}
