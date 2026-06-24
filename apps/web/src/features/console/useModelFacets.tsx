import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CAPABILITIES, enumLabel, MODALITIES } from '../../lib/api/enums';

/** The minimal model shape the catalog facets read (shared by ConsoleModelView + ModelView). */
export interface FacetableModel {
  modality: string;
  maker: string | null;
  capabilities?: unknown;
  tags: string[];
}

type FacetKey = 'modality' | 'maker' | 'capability' | 'tag';
type Selected = Record<FacetKey, Set<string>>;

/** Distinct values (with counts) a model set exposes for one facet. */
function valuesFor(models: readonly FacetableModel[], key: FacetKey): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (v: string) => counts.set(v, (counts.get(v) ?? 0) + 1);
  for (const m of models) {
    if (key === 'modality') bump(m.modality);
    else if (key === 'maker') {
      if (m.maker !== null && m.maker !== '') bump(m.maker);
    } else if (key === 'tag') for (const tg of m.tags) bump(tg);
    else {
      const caps = (m.capabilities ?? {}) as Record<string, unknown>;
      for (const c of CAPABILITIES) if (caps[c.key] === true) bump(c.key);
    }
  }
  return counts;
}

function matches(m: FacetableModel, sel: Selected): boolean {
  if (sel.modality.size > 0 && !sel.modality.has(m.modality)) return false;
  if (sel.maker.size > 0 && !(m.maker !== null && sel.maker.has(m.maker))) return false;
  if (sel.tag.size > 0 && !m.tags.some((tg) => sel.tag.has(tg))) return false;
  if (sel.capability.size > 0) {
    const caps = (m.capabilities ?? {}) as Record<string, unknown>;
    if (![...sel.capability].every((c) => caps[c] === true)) return false;
  }
  return true;
}

/**
 * ZenMux-style catalog faceting (catalog-tags-ia): derives 模态/开发者/能力/标签
 * facets from the loaded models, renders a toggle-chip bar, and returns the
 * filtered list. Multi-select within a facet is OR; across facets is AND.
 * Capabilities are AND (a model must have every selected capability). A facet
 * row only renders when it has ≥2 distinct values (else it can't narrow).
 */
export function useModelFacets<T extends FacetableModel>(models: T[]): {
  node: ReactNode;
  filtered: T[];
} {
  const { t } = useTranslation('console');
  const [sel, setSel] = useState<Selected>({
    modality: new Set(),
    maker: new Set(),
    capability: new Set(),
    tag: new Set(),
  });

  const filtered = useMemo(() => models.filter((m) => matches(m, sel)), [models, sel]);

  const toggle = (key: FacetKey, value: string) => {
    setSel((prev) => {
      const next = new Set(prev[key]);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return { ...prev, [key]: next };
    });
  };

  const label = (key: FacetKey, value: string): string => {
    if (key === 'modality') return enumLabel(t, MODALITIES, value);
    if (key === 'capability') return t(CAPABILITIES.find((c) => c.key === value)?.labelKey ?? value);
    return value;
  };

  const rows: { key: FacetKey; title: string; values: Map<string, number> }[] = (
    ['modality', 'maker', 'capability', 'tag'] as FacetKey[]
  )
    .map((key) => ({ key, title: t('facets.' + key), values: valuesFor(models, key) }))
    .filter((r) => r.values.size >= 2);

  const anySelected = (Object.keys(sel) as FacetKey[]).some((k) => sel[k].size > 0);

  const node =
    rows.length === 0 ? null : (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--s-2)',
          marginBottom: 'var(--s-3)',
        }}
      >
        {rows.map((r) => (
          <div key={r.key} style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--s-2)' }}>
            <span
              style={{
                fontSize: 'var(--fs-caption)',
                color: 'var(--muted)',
                minWidth: 52,
                flexShrink: 0,
              }}
            >
              {r.title}
            </span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s-1)' }}>
              {[...r.values.entries()].map(([value, n]) => {
                const on = sel[r.key].has(value);
                return (
                  <button
                    key={value}
                    type="button"
                    className="chip"
                    onClick={() => toggle(r.key, value)}
                    style={{
                      cursor: 'pointer',
                      border: on ? '1px solid var(--accent)' : '1px solid transparent',
                      background: on ? 'var(--hover-bg)' : undefined,
                      color: on ? 'var(--text)' : undefined,
                    }}
                  >
                    {label(r.key, value)} <span style={{ color: 'var(--faint)' }}>{n}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {anySelected && (
          <button
            type="button"
            onClick={() =>
              setSel({
                modality: new Set(),
                maker: new Set(),
                capability: new Set(),
                tag: new Set(),
              })
            }
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
            {t('facets.clear', { n: filtered.length })}
          </button>
        )}
      </div>
    );

  return { node, filtered };
}
