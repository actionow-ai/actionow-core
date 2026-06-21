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

export function Modal({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  /** Optional secondary line under the title (e.g. "此操作不可恢复"). */
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  // `mounted` keeps the node in the tree through the exit animation; it only
  // drops to false once the close tween completes (or instantly when reduced).
  const [mounted, setMounted] = useState(open);
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const { t } = useTranslation('console');

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
        zIndex: Z.scrim,
        background: 'var(--scrim)',
        backdropFilter: 'blur(2px)',
        WebkitBackdropFilter: 'blur(2px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--s-5)',
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
          width: 'min(440px, 94vw)',
          maxHeight: 'min(86dvh, 720px)',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 'var(--r-lg)',
          padding: 'var(--s-6)',
          // near-opaque dialog so form text/fields stay legible over page content
          background: 'var(--overlay-bg)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 'var(--s-3)', flexShrink: 0 }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 'var(--fs-lg)', fontWeight: 'var(--fw-semibold)' }}>{title}</h2>
            {subtitle !== undefined && <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginTop: 4 }}>{subtitle}</div>}
          </div>
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
          <div style={{ marginTop: 'var(--s-6)', display: 'flex', justifyContent: 'flex-end', gap: 'var(--s-3)', flexShrink: 0 }}>
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
