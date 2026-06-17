import { CaretDownIcon, CheckIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface Option {
  value: string;
  label: string;
}

/**
 * System-styled select: a glass trigger + a portaled warm popover (never the
 * native OS dropdown, which renders a blue selection off-palette and is clipped
 * inside scrollable modals). Portaled + fixed-positioned so it escapes modal
 * overflow. Closes on outside-click, Escape, or scroll.
 */
export function Select({
  value,
  onChange,
  options,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Option[];
  placeholder?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const all = placeholder !== undefined ? [{ value: '', label: placeholder }, ...options] : options;
  const selected = all.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (r) setRect({ left: r.left, top: r.bottom + 4, width: r.width });
    };
    place();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) !== true && menuRef.current?.contains(t) !== true) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="panel"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--s-2)',
          width: '100%',
          fontSize: 'var(--fs-sm)',
          color: selected !== undefined && selected.value !== '' ? 'var(--text)' : 'var(--muted)',
          padding: 'var(--s-2) var(--s-3)',
          borderRadius: 'var(--r-sm)',
          cursor: 'pointer',
          textAlign: 'left',
          border: `1px solid ${open ? 'var(--hover-bd)' : 'var(--panel-bd)'}`,
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selected?.label ?? placeholder ?? ''}
        </span>
        <CaretDownIcon
          size={14}
          style={{ flexShrink: 0, color: 'var(--muted)', transition: 'transform 0.2s ease', transform: open ? 'rotate(180deg)' : 'none' }}
        />
      </button>
      {open &&
        rect !== null &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            className="glass"
            style={{
              position: 'fixed',
              left: rect.left,
              top: rect.top,
              width: rect.width,
              zIndex: 90,
              maxHeight: 280,
              overflowY: 'auto',
              padding: 'var(--s-1)',
              borderRadius: 'var(--r-md)',
            }}
          >
            {all.map((o) => {
              const on = o.value === value;
              return (
                <button
                  key={o.value}
                  type="button"
                  role="option"
                  aria-selected={on}
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  className="select-opt"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 'var(--s-2)',
                    width: '100%',
                    textAlign: 'left',
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    padding: 'var(--s-2) var(--s-3)',
                    borderRadius: 'var(--r-sm)',
                    fontSize: 'var(--fs-sm)',
                    color: on ? 'var(--accent)' : 'var(--text)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.label}</span>
                  {on && <CheckIcon size={14} weight="bold" style={{ flexShrink: 0 }} />}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
