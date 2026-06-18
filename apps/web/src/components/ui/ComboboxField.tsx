import { CaretDownIcon } from '@phosphor-icons/react';
import type { KeyboardEvent } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Z } from '../../lib/zIndex';
import { FormField, useFieldId } from './FormField';

/**
 * A typeable dropdown on the unified field contract: a text input plus a
 * portaled warm popover of `options` (matching `Select`'s glass/`--overlay-bg`
 * styling). Unlike `SelectField`, the value is free-form — the input commits
 * whatever the user types (backend fields are `z.string()`) while the dropdown
 * offers suggestions filtered by case-insensitive substring.
 *
 * Keyboard (focus stays on the input): typing filters + opens; ArrowDown/Up move
 * the highlight; Enter commits the highlight (or, with none, the typed text) and
 * closes; Escape closes without changing the typed value; clicking an option
 * commits it. The input carries `role="combobox"` + `aria-expanded`/`-controls`/
 * `-activedescendant`; the popover is a `role="listbox"` of `role="option"`.
 */
export function ComboboxField({
  label,
  value,
  onChange,
  options,
  placeholder,
  hint,
  tooltip,
  required,
  disabled,
  id,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  hint?: string;
  tooltip?: string;
  required?: boolean;
  disabled?: boolean;
  id?: string;
}) {
  const fieldId = useFieldId(id);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Suggestions are a case-insensitive substring filter over the typed value.
  // An empty value shows all options (the full suggestion list on focus).
  const q = value.trim().toLowerCase();
  const filtered = q === '' ? options : options.filter((o) => o.toLowerCase().includes(q));
  const optionId = (i: number) => `${listId}-opt-${String(i)}`;

  const openMenu = () => {
    if (disabled === true) return;
    setActiveIndex(-1);
    setOpen(true);
  };

  const commit = (v: string) => {
    onChange(v);
    setOpen(false);
    inputRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = inputRef.current?.getBoundingClientRect();
      if (r) setRect({ left: r.left, top: r.bottom + 4, width: r.width });
    };
    place();
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (inputRef.current?.contains(target) !== true && menuRef.current?.contains(target) !== true)
        setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', place);
    // Reposition (don't close) on scroll so the suggestions follow the input
    // when it lives inside a scrollable Modal/Drawer/table.
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  // Keep the highlighted option scrolled into view.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const el = menuRef.current?.querySelector(`#${CSS.escape(`${listId}-opt-${String(activeIndex)}`)}`);
    if (el instanceof HTMLElement && typeof el.scrollIntoView === 'function')
      el.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex, listId]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((i) => (filtered.length === 0 ? -1 : Math.min(i + 1, filtered.length - 1)));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
        break;
      case 'Home':
        if (filtered.length > 0) {
          e.preventDefault();
          setActiveIndex(0);
        }
        break;
      case 'End':
        if (filtered.length > 0) {
          e.preventDefault();
          setActiveIndex(filtered.length - 1);
        }
        break;
      case 'Enter':
        e.preventDefault();
        // A highlighted suggestion wins; otherwise commit the typed text.
        commit(activeIndex >= 0 && activeIndex < filtered.length ? filtered[activeIndex] : value);
        break;
      case 'Escape':
        e.preventDefault();
        setOpen(false);
        break;
      case 'Tab':
        setOpen(false);
        break;
      default:
        break;
    }
  };

  return (
    <FormField id={fieldId} label={label} hint={hint} tooltip={tooltip} required={required}>
      <div style={{ position: 'relative', display: 'flex' }}>
        <input
          ref={inputRef}
          id={fieldId}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={open && filtered.length > 0 ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          required={required}
          autoComplete="off"
          onChange={(e) => {
            onChange(e.target.value);
            setActiveIndex(-1);
            if (!open) openMenu();
          }}
          onFocus={openMenu}
          onClick={openMenu}
          onKeyDown={onKeyDown}
          className="panel"
          style={{
            width: '100%',
            fontSize: 'var(--fs-sm)',
            color: 'var(--text)',
            padding: '9px 30px 9px 11px',
            borderRadius: 'var(--r-sm)',
            outline: 'none',
          }}
        />
        <CaretDownIcon
          size={14}
          aria-hidden="true"
          style={{
            position: 'absolute',
            right: 11,
            top: 0,
            bottom: 0,
            margin: 'auto',
            color: 'var(--muted)',
            pointerEvents: 'none',
            transition: 'transform 0.2s ease',
            transform: open ? 'rotate(180deg)' : 'none',
          }}
        />
      </div>
      {open &&
        rect !== null &&
        filtered.length > 0 &&
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
              borderRadius: 'var(--r-md)',
              // near-opaque so option text stays legible over any underlying content
              background: 'var(--overlay-bg)',
            }}
          >
            {filtered.map((o, i) => {
              const on = o === value;
              const active = i === activeIndex;
              return (
                <button
                  key={o}
                  id={optionId(i)}
                  type="button"
                  role="option"
                  aria-selected={on}
                  tabIndex={-1}
                  // mousedown (not click) so the commit fires before the input's
                  // blur-driven outside-click handler can close the popover.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    commit(o);
                  }}
                  onMouseEnter={() => setActiveIndex(i)}
                  className="select-opt"
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    border: 'none',
                    background: active ? 'var(--hover-bg)' : 'transparent',
                    cursor: 'pointer',
                    padding: 'var(--s-2) var(--s-3)',
                    borderRadius: 'var(--r-sm)',
                    fontSize: 'var(--fs-sm)',
                    color: on ? 'var(--accent)' : 'var(--text)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {o}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </FormField>
  );
}
