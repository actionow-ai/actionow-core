import { CaretDownIcon, CheckIcon } from '@phosphor-icons/react';
import type { KeyboardEvent } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Z } from '../../lib/zIndex';

export interface Option {
  value: string;
  label: string;
}

/**
 * System-styled select: a glass trigger + a portaled warm popover (never the
 * native OS dropdown, which renders a blue selection off-palette and is clipped
 * inside scrollable modals). Portaled + fixed-positioned so it escapes modal
 * overflow. Closes on outside-click, Escape, or scroll.
 *
 * Keyboard (focus stays on the trigger; the active option is tracked with
 * `aria-activedescendant`): ArrowDown/Enter/Space open; ArrowUp/Down move the
 * active option; Home/End jump; Enter selects + closes; Escape closes;
 * printable keys type-ahead to the next matching label.
 */
export function Select({
  value,
  onChange,
  options,
  placeholder,
  ariaLabel,
  ariaInvalid,
  ariaDescribedby,
  id,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Option[];
  placeholder?: string;
  ariaLabel?: string;
  ariaInvalid?: boolean;
  ariaDescribedby?: string;
  id?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef<{ buffer: string; at: number }>({ buffer: '', at: 0 });
  const listId = useId();

  const all = placeholder !== undefined ? [{ value: '', label: placeholder }, ...options] : options;
  const selected = all.find((o) => o.value === value);
  const optionId = (i: number) => `${listId}-opt-${String(i)}`;

  const openMenu = (index?: number) => {
    const start =
      index ??
      Math.max(
        all.findIndex((o) => o.value === value),
        0,
      );
    setActiveIndex(start);
    setOpen(true);
  };

  const commit = (index: number) => {
    const opt = all[index];
    if (opt !== undefined) onChange(opt.value);
    setOpen(false);
    btnRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (r) setRect({ left: r.left, top: r.bottom + 4, width: r.width });
    };
    place();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) !== true && menuRef.current?.contains(t) !== true)
        setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', place);
    // Reposition (don't close) on scroll so a Select opened inside a scrollable
    // Modal/Drawer/table follows its trigger instead of vanishing.
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  // Keep the active option scrolled into view.
  useEffect(() => {
    if (!open) return;
    const el = menuRef.current?.querySelector(
      `#${CSS.escape(`${listId}-opt-${String(activeIndex)}`)}`,
    );
    if (el instanceof HTMLElement && typeof el.scrollIntoView === 'function')
      el.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex, listId]);

  const typeAhead = (key: string) => {
    const now = Date.now();
    const buffer = now - typeahead.current.at > 600 ? key : typeahead.current.buffer + key;
    typeahead.current = { buffer, at: now };
    const match = all.findIndex((o) => o.label.toLowerCase().startsWith(buffer.toLowerCase()));
    if (match >= 0) setActiveIndex(match);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, all.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
        break;
      case 'Home':
        e.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        e.preventDefault();
        setActiveIndex(all.length - 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        commit(activeIndex);
        break;
      case 'Escape':
        e.preventDefault();
        setOpen(false);
        break;
      case 'Tab':
        setOpen(false);
        break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          typeAhead(e.key);
        }
    }
  };

  return (
    <>
      <button
        ref={btnRef}
        id={id}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={ariaInvalid}
        aria-describedby={ariaDescribedby}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? optionId(activeIndex) : undefined}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
        className="field"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--s-2)',
          width: '100%',
          fontSize: 'var(--fs-sm)',
          color: selected !== undefined && selected.value !== '' ? 'var(--text)' : 'var(--muted)',
          cursor: disabled === true ? 'not-allowed' : 'pointer',
          opacity: disabled === true ? 0.55 : undefined,
          textAlign: 'left',
          // surface/border/radius/min-height/focus-ring come from `.field`; keep
          // only the open-state border highlight as an inline override.
          ...(open ? { borderColor: 'var(--hover-bd)' } : null),
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selected?.label ?? placeholder ?? ''}
        </span>
        <CaretDownIcon
          size={14}
          style={{
            flexShrink: 0,
            color: 'var(--muted)',
            transition: 'transform 0.2s ease',
            transform: open ? 'rotate(180deg)' : 'none',
          }}
        />
      </button>
      {open &&
        rect !== null &&
        createPortal(
          <div
            ref={menuRef}
            id={listId}
            role="listbox"
            className="glass"
            style={{
              position: 'fixed',
              left: rect.left,
              top: rect.top,
              width: rect.width,
              zIndex: Z.popover,
              maxHeight: 280,
              overflowY: 'auto',
              padding: 'var(--s-1)',
              borderRadius: 'var(--r-sm)',
              // near-opaque so option text stays legible over any underlying content
              background: 'var(--overlay-bg)',
            }}
          >
            {all.map((o, i) => {
              const on = o.value === value;
              const active = i === activeIndex;
              return (
                <button
                  key={o.value}
                  id={optionId(i)}
                  type="button"
                  role="option"
                  aria-selected={on}
                  tabIndex={-1}
                  onClick={() => commit(i)}
                  onMouseEnter={() => setActiveIndex(i)}
                  className="select-opt"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 'var(--s-2)',
                    width: '100%',
                    textAlign: 'left',
                    border: 'none',
                    background: active || on ? 'var(--hover-bg)' : 'transparent',
                    cursor: 'pointer',
                    padding: 'var(--s-2) var(--s-3)',
                    borderRadius: 'var(--r-sm)',
                    fontSize: 'var(--fs-sm)',
                    color: 'var(--text)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.label}</span>
                  {on && (
                    <CheckIcon
                      size={14}
                      weight="bold"
                      style={{ flexShrink: 0, color: 'var(--accent-2)' }}
                    />
                  )}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
