import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

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
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 80,
        background: 'rgba(0,0,0,.45)',
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
