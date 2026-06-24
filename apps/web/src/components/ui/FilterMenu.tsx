import { FunnelSimpleIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { FacetGroup } from '../../features/console/useFacets';
import { FIELD_INPUT_BASE } from './fieldStyles';
import { Floating } from './Floating';

/**
 * A custom (NOT native `<select>`) multi-dimension filter: a trigger button with
 * an active-count badge that opens a portaled popover of facet groups, each a row
 * of toggle chips. Multi-select OR within a group, AND across groups (the matching
 * is owned by {@link useFacets}). Renders nothing when there are no narrowable
 * dimensions.
 */
export function FilterMenu({
  groups,
  selected,
  onToggle,
  onClear,
  activeCount,
}: {
  groups: FacetGroup[];
  selected: Record<string, Set<string>>;
  onToggle: (key: string, value: string) => void;
  onClear: () => void;
  activeCount: number;
}) {
  const { t } = useTranslation('console');
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const node = e.target as Node;
      if (triggerRef.current?.contains(node) === true) return;
      if (popRef.current?.contains(node) === true) return;
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

  if (groups.length === 0) return null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{
          ...FIELD_INPUT_BASE,
          width: 'auto',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 'var(--s-1)',
          cursor: 'pointer',
          flexShrink: 0,
          color: activeCount > 0 ? 'var(--text)' : 'var(--muted)',
          borderColor: activeCount > 0 ? 'var(--accent)' : undefined,
        }}
      >
        <FunnelSimpleIcon size={15} aria-hidden="true" />
        {t('common.filter', '过滤')}
        {activeCount > 0 && (
          <span
            style={{
              minWidth: 16,
              height: 16,
              padding: '0 4px',
              borderRadius: 'var(--r-pill)',
              background: 'var(--accent)',
              color: 'var(--ink)',
              fontSize: 'var(--fs-caption)',
              fontWeight: 'var(--fw-semibold)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {activeCount}
          </span>
        )}
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
            minWidth: 240,
            maxWidth: 320,
            maxHeight: 420,
            overflowY: 'auto',
            background: 'var(--overlay-bg)',
            border: '1px solid var(--panel-bd)',
            borderRadius: 'var(--r-md)',
            boxShadow: 'var(--glass-shadow)',
            padding: 'var(--s-3)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--s-3)',
          }}
        >
          {groups.map((g) => (
            <div key={g.key} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
              <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--muted)' }}>{g.title}</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s-1)' }}>
                {g.options.map((o) => {
                  const sel = selected[g.key] as Set<string> | undefined;
                  const on = sel?.has(o.value) === true;
                  return (
                    <button
                      key={o.value}
                      type="button"
                      className="chip"
                      aria-pressed={on}
                      onClick={() => onToggle(g.key, o.value)}
                      style={{
                        cursor: 'pointer',
                        border: on ? '1px solid var(--accent)' : '1px solid transparent',
                        background: on ? 'var(--hover-bg)' : undefined,
                        color: on ? 'var(--text)' : undefined,
                      }}
                    >
                      {o.label} <span style={{ color: 'var(--faint)' }}>{o.count}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {activeCount > 0 && (
            <button
              type="button"
              onClick={onClear}
              style={{
                alignSelf: 'flex-start',
                background: 'transparent',
                border: 'none',
                color: 'var(--muted)',
                cursor: 'pointer',
                fontSize: 'var(--fs-caption)',
                padding: 0,
              }}
            >
              {t('common.clearFilters', '清除筛选')}
            </button>
          )}
        </div>
      </Floating>
    </>
  );
}
