import type { Icon } from '@phosphor-icons/react';
import type { KeyboardEvent, ReactNode } from 'react';

export interface CardMeta {
  label: string;
  value: ReactNode;
}

/**
 * A glass entity card — the console's primary unit instead of a table row.
 * Leading gradient glyph + title + status badge, an optional chip row, a
 * definition-style meta grid, and trailing actions. Clickable + selectable
 * (for master-detail lists).
 */
export function EntityCard({
  icon: IconCmp,
  glyph,
  title,
  badge,
  chips,
  meta,
  actions,
  onClick,
  selected,
}: {
  icon?: Icon;
  /** Custom leading glyph (e.g. a vendor logo); overrides `icon` when set. */
  glyph?: ReactNode;
  title: ReactNode;
  badge?: ReactNode;
  chips?: ReactNode[];
  meta?: CardMeta[];
  actions?: ReactNode;
  onClick?: () => void;
  selected?: boolean;
}) {
  const clickable = onClick !== undefined;
  const cls = `entity-card${clickable ? ' is-clickable' : ''}${selected === true ? ' is-selected' : ''}`;
  const onKeyDown = clickable
    ? (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }
    : undefined;
  return (
    <div
      className={cls}
      onClick={onClick}
      onKeyDown={onKeyDown}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-pressed={clickable ? selected === true : undefined}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--s-3)' }}>
        {glyph !== undefined ? (
          <span style={{ flexShrink: 0 }} aria-hidden="true">
            {glyph}
          </span>
        ) : (
          IconCmp !== undefined && (
            <span className="card-glyph" aria-hidden="true">
              <IconCmp size={18} weight="duotone" />
            </span>
          )
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 'var(--fs-base)', fontWeight: 'var(--fw-semibold)', letterSpacing: 'var(--track-snug)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {title}
          </div>
          {chips !== undefined && chips.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 7 }}>
              {chips.map((c, i) => (
                <span key={i} className="chip">
                  {c}
                </span>
              ))}
            </div>
          )}
        </div>
        {badge !== undefined && <div style={{ flexShrink: 0 }}>{badge}</div>}
      </div>

      {meta !== undefined && meta.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s-5)', marginTop: 'var(--s-4)' }}>
          {meta.map((m, i) => (
            <div key={i} style={{ minWidth: 0 }}>
              <div style={{ fontSize: 'var(--fs-caption)', textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--faint)' }}>{m.label}</div>
              <div className="tabular" style={{ fontSize: 'var(--fs-sm)', color: 'var(--text)', marginTop: 3, whiteSpace: 'nowrap' }}>
                {m.value}
              </div>
            </div>
          ))}
        </div>
      )}

      {actions !== undefined && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--s-2)', marginTop: 'var(--s-4)' }}>{actions}</div>
      )}
    </div>
  );
}
