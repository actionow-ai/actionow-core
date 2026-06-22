import { CalendarBlankIcon, CaretLeftIcon, CaretRightIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { FIELD_INPUT_BASE } from './fieldStyles';
import { Floating } from './Floating';

/**
 * A themed date picker — the design-system replacement for `<input type="date">`,
 * whose native calendar renders blue (a hard token violation) and ignores the
 * app's glass styling. A `.field`-styled trigger opens a month-grid popover on
 * the {@link Floating} primitive: tokens only, accent-yellow selection (never
 * blue), localized month/weekday labels, and the same controlled contract as the
 * inputs it replaces — `value`/`onChange` as ISO `YYYY-MM-DD`, plus `min`/`max`
 * to keep the from/to range guards. Mouse + Tab/Enter/Esc operable.
 */
export function DateField({
  value,
  onChange,
  min,
  max,
  ariaLabel,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  min?: string;
  max?: string;
  ariaLabel?: string;
  placeholder?: string;
}) {
  const { i18n } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  const selected = parseISO(value);
  const today = new Date();
  const minD = min !== undefined && min.length > 0 ? parseISO(min) : null;
  const maxD = max !== undefined && max.length > 0 ? parseISO(max) : null;

  const [view, setView] = useState(() => {
    const base = selected ?? today;
    return { y: base.getFullYear(), m: base.getMonth() };
  });

  // Close on Escape or an outside pointerdown (Floating positions only).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) === true) return;
      if (popRef.current?.contains(t) === true) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const fmtMonth = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { year: 'numeric', month: 'long' }),
    [i18n.language],
  );
  const fmtTrigger = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { year: 'numeric', month: 'short', day: 'numeric' }),
    [i18n.language],
  );
  // Sun..Sat short labels, localized (2023-01-01 is a Sunday).
  const weekdays = useMemo(() => {
    const f = new Intl.DateTimeFormat(i18n.language, { weekday: 'short' });
    return Array.from({ length: 7 }, (_, i) => f.format(new Date(2023, 0, 1 + i)));
  }, [i18n.language]);

  const isDisabled = (d: Date) =>
    (minD !== null && d < minD) || (maxD !== null && d > maxD);

  // 6-week grid covering the visible month.
  const firstOfMonth = new Date(view.y, view.m, 1);
  const gridStart = new Date(view.y, view.m, 1 - firstOfMonth.getDay());
  const days = Array.from(
    { length: 42 },
    (_, i) => new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i),
  );

  const pick = (d: Date) => {
    if (isDisabled(d)) return;
    onChange(toISO(d));
    setOpen(false);
  };
  const stepMonth = (delta: number) =>
    setView((v) => {
      const nd = new Date(v.y, v.m + delta, 1);
      return { y: nd.getFullYear(), m: nd.getMonth() };
    });

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{
          ...FIELD_INPUT_BASE,
          width: 'auto',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 'var(--s-2)',
          cursor: 'pointer',
          color: selected !== null ? 'var(--text)' : 'var(--muted)',
        }}
      >
        <CalendarBlankIcon size={15} aria-hidden="true" style={{ color: 'var(--muted)' }} />
        <span style={{ whiteSpace: 'nowrap' }}>
          {selected !== null ? fmtTrigger.format(selected) : (placeholder ?? '—')}
        </span>
      </button>

      <Floating
        open={open}
        triggerRef={triggerRef}
        placement="bottom"
        align="start"
        gap={6}
        layer="popover"
        role="dialog"
        pointerEvents="auto"
      >
        <div
          ref={popRef}
          style={{
            background: 'var(--overlay-bg)',
            border: '1px solid var(--panel-bd)',
            borderRadius: 'var(--r-md)',
            boxShadow: 'var(--glass-shadow)',
            padding: 'var(--s-3)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 'var(--s-2)',
            }}
          >
            <CalNav onClick={() => stepMonth(-1)} ariaLabel="−1">
              <CaretLeftIcon size={14} weight="bold" aria-hidden="true" />
            </CalNav>
            <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 'var(--fw-medium)' }}>
              {fmtMonth.format(firstOfMonth)}
            </span>
            <CalNav onClick={() => stepMonth(1)} ariaLabel="+1">
              <CaretRightIcon size={14} weight="bold" aria-hidden="true" />
            </CalNav>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 32px)', gap: 2 }}>
            {weekdays.map((w) => (
              <span
                key={w}
                style={{
                  textAlign: 'center',
                  fontSize: 'var(--fs-caption)',
                  color: 'var(--faint)',
                  paddingBottom: 'var(--s-1)',
                }}
              >
                {w}
              </span>
            ))}
            {days.map((d) => {
              const inMonth = d.getMonth() === view.m;
              const isSel = selected !== null && sameDay(d, selected);
              const isToday = sameDay(d, today);
              const dis = isDisabled(d);
              return (
                <button
                  key={toISO(d)}
                  type="button"
                  disabled={dis}
                  onClick={() => pick(d)}
                  aria-current={isToday ? 'date' : undefined}
                  aria-pressed={isSel}
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 'var(--r-xs)',
                    border: isToday && !isSel ? '1px solid var(--accent)' : '1px solid transparent',
                    cursor: dis ? 'not-allowed' : 'pointer',
                    fontSize: 'var(--fs-sm)',
                    background: isSel ? 'var(--grad-accent)' : 'transparent',
                    color: isSel
                      ? 'var(--ink)'
                      : dis
                        ? 'var(--faint)'
                        : inMonth
                          ? 'var(--text)'
                          : 'var(--muted)',
                    opacity: dis ? 0.4 : 1,
                  }}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>
        </div>
      </Floating>
    </>
  );
}

/** A compact month-nav button inside the calendar header. */
function CalNav({
  onClick,
  ariaLabel,
  children,
}: {
  onClick: () => void;
  ariaLabel: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className="glass-hover"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        borderRadius: 'var(--r-sm)',
        border: '1px solid var(--panel-bd)',
        background: 'transparent',
        color: 'var(--text)',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

/** Parse `YYYY-MM-DD` to a LOCAL midnight Date (avoids `new Date(str)`'s UTC shift). */
export function parseISO(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m === null) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
/** Format a Date as `YYYY-MM-DD` in local time. */
export function toISO(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
