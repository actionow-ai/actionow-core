import type { CSSProperties, ReactNode, RefObject } from 'react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { type Align, computeAnchoredPosition, type Placement } from '../../lib/floating';
import { Z, type ZLayer } from '../../lib/zIndex';

/**
 * A portaled, anchored floating surface — the shared escape hatch from
 * `overflow:auto/hidden` clipping that previously truncated inline-absolute
 * tooltips inside Modal/Drawer/console scrollports. Reuses the canonical
 * portal + `position:fixed` + `getBoundingClientRect()` pattern (from `Select`)
 * and adds top/bottom flip + horizontal clamp (lib/floating) and
 * reposition-on-scroll (so an anchor inside a scroll container is followed, not
 * abandoned).
 *
 * `keepMounted` renders the node even while closed (visibility hidden) so an
 * `aria-describedby`/`aria-controls` relationship to it stays valid — used by
 * `Tooltip`, whose bubble must always exist for screen readers.
 */
export interface FloatingProps {
  open: boolean;
  /** The anchor element whose rect positions the content. */
  triggerRef: RefObject<HTMLElement | null>;
  placement?: Placement;
  align?: Align;
  /** Gap between trigger and content (px). */
  gap?: number;
  /** Minimum distance from each viewport edge (px). */
  margin?: number;
  /** Stacking layer (default 'tooltip' — topmost). */
  layer?: Extract<ZLayer, 'popover' | 'toast' | 'tooltip'>;
  /** Tooltips don't capture the pointer; interactive popovers do. */
  pointerEvents?: CSSProperties['pointerEvents'];
  /** Keep the node mounted while closed (visibility hidden) for aria links. */
  keepMounted?: boolean;
  role?: string;
  /** Accessible name for the floating element (e.g. a `role="dialog"` popover). */
  ariaLabel?: string;
  id?: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

function useAnchoredStyle(
  triggerRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
  open: boolean,
  opts: { placement: Placement; align: Align; gap: number; margin: number },
): CSSProperties | null {
  const { placement, align, gap, margin } = opts;
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const place = useCallback(() => {
    const t = triggerRef.current?.getBoundingClientRect();
    const c = contentRef.current?.getBoundingClientRect();
    if (!t || !c) return;
    const r = computeAnchoredPosition({
      trigger: { left: t.left, right: t.right, top: t.top, bottom: t.bottom, width: t.width },
      content: { width: c.width, height: c.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      placement,
      align,
      gap,
      margin,
    });
    setPos({ left: r.left, top: r.top });
  }, [triggerRef, contentRef, placement, align, gap, margin]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();
    // Capture-phase scroll so an anchor inside ANY scroll container is followed
    // (the old dropdowns closed on scroll instead); resize re-clamps.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, place]);

  return pos === null ? null : { position: 'fixed', left: pos.left, top: pos.top };
}

export function Floating({
  open,
  triggerRef,
  placement = 'top',
  align = 'center',
  gap = 8,
  margin = 8,
  layer = 'tooltip',
  pointerEvents = 'none',
  keepMounted = false,
  role,
  ariaLabel,
  id,
  className,
  style,
  children,
}: FloatingProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const anchored = useAnchoredStyle(triggerRef, contentRef, open, {
    placement,
    align,
    gap,
    margin,
  });

  if (!open && !keepMounted) return null;
  const visible = open && anchored !== null;

  return createPortal(
    <div
      ref={contentRef}
      role={role}
      aria-label={ariaLabel}
      id={id}
      data-open={open ? 'true' : 'false'}
      className={className}
      style={{
        position: 'fixed',
        left: 0,
        top: 0,
        zIndex: Z[layer],
        pointerEvents,
        opacity: visible ? 1 : 0,
        visibility: visible ? 'visible' : 'hidden',
        ...anchored,
        ...style,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
