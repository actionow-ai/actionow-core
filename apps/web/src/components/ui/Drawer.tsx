import { XIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { lockBackground } from '../../lib/inert';
import { gsap, useGSAP } from '../../lib/motion/gsap';
import { DUR, EASE } from '../../lib/motion/tokens';
import { useFocusTrap } from '../../lib/useFocusTrap';
import { Z } from '../../lib/zIndex';
import { IconButton } from './IconButton';

/**
 * A right-slide side panel — a heavier sibling of `Modal` for long forms (e.g.
 * the channel editor). Same deferred-unmount lifecycle (stays mounted through
 * the exit tween), focus trap while open, Escape/backdrop close, `--scrim`
 * backdrop, near-opaque `--overlay-bg` panel. Slides fully in from the right
 * edge (translateX 100%→0); reduced-motion unmounts/sets instantly.
 */
export function Drawer({
  open,
  title,
  onClose,
  children,
  footer,
  width = 'min(460px, 94vw)',
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  const { t } = useTranslation('console');
  const [mounted, setMounted] = useState(open);
  const backdropRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Mirror the latest `open` so the exit timeline's deferred onComplete reads the
  // current value, not the (stale) one captured when the timeline was built.
  const openRef = useRef(open);
  openRef.current = open;

  useFocusTrap(panelRef, open && mounted);

  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  // Make the background inert/aria-hidden while open (Tab trap alone doesn't
  // hide it from a screen reader's virtual cursor).
  useEffect(() => {
    if (!open) return;
    return lockBackground();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useGSAP(
    () => {
      const backdrop = backdropRef.current;
      const panel = panelRef.current;
      if (!backdrop || !panel) return;
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      if (open) {
        if (reduced) {
          gsap.set(backdrop, { opacity: 1 });
          gsap.set(panel, { xPercent: 0 });
          return;
        }
        gsap.fromTo(backdrop, { opacity: 0 }, { opacity: 1, duration: DUR.base, ease: EASE.out });
        // Full-width slide from the right edge (the design's translateX(100%)→0).
        gsap.fromTo(panel, { xPercent: 100 }, { xPercent: 0, duration: DUR.base, ease: EASE.out });
        return;
      }

      // Closing: animate out, then unmount. Reduced-motion unmounts immediately.
      if (reduced) {
        setMounted(false);
        return;
      }
      // Guard the unmount: a rapid close→reopen within the exit window flips
      // `open` back to true before this completes, so only unmount if still closed.
      const tl = gsap.timeline({
        onComplete: () => {
          if (!openRef.current) setMounted(false);
        },
      });
      tl.to(panel, { xPercent: 100, duration: DUR.fast, ease: EASE.in }, 0);
      tl.to(backdrop, { opacity: 0, duration: DUR.fast, ease: EASE.in }, 0);
    },
    { dependencies: [open] },
  );

  if (!mounted) return null;
  return createPortal(
    <div
      ref={backdropRef}
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: Z.scrim,
        background: 'var(--scrim)',
        backdropFilter: 'blur(2px)',
        WebkitBackdropFilter: 'blur(2px)',
        display: 'flex',
        justifyContent: 'flex-end',
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="liquid-glass"
        style={{
          width,
          height: '100dvh',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 0,
          padding: 'var(--s-6)',
          // near-opaque panel so form text/fields stay legible over page content
          background: 'var(--overlay-bg)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--s-3)',
            flexShrink: 0,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 'var(--fs-lg)', fontWeight: 'var(--fw-semibold)' }}>
            {title}
          </h2>
          <IconButton icon={XIcon} label={t('forms.close')} onClick={onClose} size={18} bare />
        </div>
        <div
          style={{
            marginTop: 'var(--s-4)',
            // The scroll container would clip a focused input's outline ring;
            // pad the scrollport and pull back with a negative margin so the
            // ring has room without shifting the fields inward.
            marginInline: 'calc(-1 * var(--s-2))',
            paddingInline: 'var(--s-2)',
            paddingBlock: 'var(--s-1)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--s-3)',
            overflowY: 'auto',
            flex: 1,
            minHeight: 0,
          }}
        >
          {children}
        </div>
        {footer && (
          <div
            style={{
              marginTop: 'var(--s-6)',
              paddingTop: 'var(--s-4)',
              borderTop: '1px solid var(--row-bd)',
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 'var(--s-3)',
              flexShrink: 0,
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
