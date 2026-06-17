import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { gsap, useGSAP } from '../../lib/motion/gsap';
import { DUR, EASE } from '../../lib/motion/tokens';
import { useFocusTrap } from '../../lib/useFocusTrap';

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  // `mounted` keeps the node in the tree through the exit animation; it only
  // drops to false once the close tween completes (or instantly when reduced).
  const [mounted, setMounted] = useState(open);
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Mirror the latest `open` so the exit timeline's deferred onComplete reads the
  // current value, not the (stale) one captured when the timeline was built.
  const openRef = useRef(open);
  openRef.current = open;

  // Focus-trap only while actually open (not during the exit animation), so the
  // trigger regains focus the moment a close is requested.
  useFocusTrap(dialogRef, open && mounted);

  useEffect(() => {
    if (open) setMounted(true);
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
      const dialog = dialogRef.current;
      if (!backdrop || !dialog) return;
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      if (open) {
        if (reduced) {
          gsap.set(backdrop, { opacity: 1 });
          gsap.set(dialog, { opacity: 1, scale: 1, y: 0 });
          return;
        }
        gsap.fromTo(backdrop, { opacity: 0 }, { opacity: 1, duration: DUR.base, ease: EASE.out });
        gsap.fromTo(dialog, { opacity: 0, scale: 0.96, y: 8 }, { opacity: 1, scale: 1, y: 0, duration: DUR.base, ease: EASE.out });
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
      tl.to(dialog, { opacity: 0, scale: 0.96, y: 8, duration: DUR.fast, ease: EASE.in }, 0);
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
        zIndex: 80,
        background: 'var(--scrim)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--s-4)',
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="glass"
        style={{
          width: 'min(440px, 92vw)',
          maxHeight: 'min(86dvh, 720px)',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 'var(--r-lg)',
          padding: 'var(--s-5)',
          // near-opaque dialog so form text/fields stay legible over page content
          background: 'var(--overlay-bg)',
        }}
      >
        <h2 style={{ margin: 0, fontSize: 'var(--fs-md)', fontWeight: 700 }}>{title}</h2>
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
          <div style={{ marginTop: 'var(--s-5)', display: 'flex', justifyContent: 'flex-end', gap: 'var(--s-2)', flexShrink: 0 }}>
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
