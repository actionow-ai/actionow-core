import type { KeyboardEvent } from 'react';
import { useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { useReducedMotion } from '../../lib/motion/useReducedMotion';
import { useUrlState } from '../../lib/useUrlState';
import { ModelsPage } from './ModelsPage';
import { ResourcesPage } from './ResourcesPage';

const CATALOG_TABS = [
  { value: 'models', labelKey: 'nav.models' },
  { value: 'resources', labelKey: 'nav.resources' },
] as const;

/**
 * The unified Catalog surface: a single `/console/catalog` route with a
 * page-level 模型 | 资源 tab strip driven by `?tab` (模型 = default/first, the
 * 对外 product surface; 资源 = the capability hub with the merged detail pane).
 *
 * Only the active tab's body is mounted, so each body's `useSetConsoleAction`
 * (新建模型 / 新建资源) is the only one in effect — the top-bar action follows
 * the tab automatically. Each body keeps its own url-state (`edit`/`grants` for
 * models, `id` for resource selection) alongside `tab`.
 *
 * The strip mirrors `ui/Tabs` (warm underline, roving tabindex, arrow/Home/End
 * keyboard nav, `role=tab`/`tabpanel` linkage) but lays out as a flex column so
 * the active body fills the (padding-free) console content area and scrolls
 * internally.
 */
export function CatalogPage() {
  const { t } = useTranslation('console');
  const reduced = useReducedMotion();
  const [tab, setTab] = useUrlState('tab', 'models');
  const base = useId();
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const activeIdx = Math.max(
    CATALOG_TABS.findIndex((tb) => tb.value === tab),
    0,
  );
  const active = CATALOG_TABS[activeIdx].value;
  const tabId = (v: string) => `${base}-tab-${v}`;
  const panelId = `${base}-panel-${active}`;

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    let next = activeIdx;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (activeIdx + 1) % CATALOG_TABS.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp')
      next = (activeIdx - 1 + CATALOG_TABS.length) % CATALOG_TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = CATALOG_TABS.length - 1;
    else return;
    e.preventDefault();
    setTab(CATALOG_TABS[next].value);
    btnRefs.current[next]?.focus();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div
        role="tablist"
        aria-label={t('nav.catalog')}
        style={{
          display: 'flex',
          gap: 'var(--s-4)',
          padding: '0 var(--s-3)',
          borderBottom: '1px solid var(--row-bd)',
          flexShrink: 0,
        }}
      >
        {CATALOG_TABS.map((tb, i) => {
          const on = i === activeIdx;
          return (
            <button
              key={tb.value}
              ref={(el) => {
                btnRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={tabId(tb.value)}
              aria-selected={on}
              aria-controls={on ? panelId : undefined}
              tabIndex={on ? 0 : -1}
              onClick={() => setTab(tb.value)}
              onKeyDown={onKeyDown}
              style={{
                position: 'relative',
                padding: '10px 2px',
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                fontSize: 'var(--fs-sm)',
                fontWeight: 600,
                whiteSpace: 'nowrap',
                color: on ? 'var(--text)' : 'var(--muted)',
                transition: reduced ? 'none' : `color var(--dur-fast) var(--ease-out)`,
              }}
            >
              {t(tb.labelKey)}
              <span
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: -1,
                  height: 2,
                  borderRadius: 'var(--r-pill)',
                  background: 'var(--grad-accent)',
                  opacity: on ? 1 : 0,
                  transition: reduced ? 'none' : `opacity var(--dur-fast) var(--ease-out)`,
                }}
              />
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={panelId}
        aria-labelledby={tabId(active)}
        style={{ flex: 1, minHeight: 0 }}
      >
        {active === 'resources' ? <ResourcesPage /> : <ModelsPage />}
      </div>
    </div>
  );
}
