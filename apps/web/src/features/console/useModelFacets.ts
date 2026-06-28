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

export type FacetKey = 'modality' | 'maker' | 'capability' | 'tag';
export type FacetSelected = Record<FacetKey, Set<string>>;

export interface FacetValue {
  value: string;
  label: string;
  count: number;
}
export interface FacetRow {
  key: FacetKey;
  title: string;
  values: FacetValue[];
}

/** Pure-data facet state for the catalog chip bar — rendered by `<FacetBar>`. */
export interface ModelFacets {
  rows: FacetRow[];
  selected: FacetSelected;
  toggle: (key: FacetKey, value: string) => void;
  clear: () => void;
  anySelected: boolean;
  filteredCount: number;
}

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

function matches(m: FacetableModel, sel: FacetSelected): boolean {
  if (sel.modality.size > 0 && !sel.modality.has(m.modality)) return false;
  if (sel.maker.size > 0 && !(m.maker !== null && sel.maker.has(m.maker))) return false;
  if (sel.tag.size > 0 && !m.tags.some((tg) => sel.tag.has(tg))) return false;
  if (sel.capability.size > 0) {
    const caps = (m.capabilities ?? {}) as Record<string, unknown>;
    if (![...sel.capability].every((c) => caps[c] === true)) return false;
  }
  return true;
}

const emptySelection = (): FacetSelected => ({
  modality: new Set(),
  maker: new Set(),
  capability: new Set(),
  tag: new Set(),
});

/**
 * ZenMux-style catalog faceting (catalog-tags-ia): derives 模态/开发者/能力/标签
 * facets from the loaded models and returns the filtered list plus the pure-data
 * `facets` object for `<FacetBar>` to render. Multi-select within a facet is OR;
 * across facets is AND; capabilities are AND (a model must have every selected
 * capability). A facet row only appears when it has ≥2 distinct values (else it
 * can't narrow). The hook owns derivation + state; the bar owns rendering.
 */
export function useModelFacets<T extends FacetableModel>(
  models: T[],
): { filtered: T[]; facets: ModelFacets } {
  const { t } = useTranslation('console');
  const [selected, setSelected] = useState<FacetSelected>(emptySelection);

  const filtered = useMemo(() => models.filter((m) => matches(m, selected)), [models, selected]);

  const toggle = (key: FacetKey, value: string) => {
    setSelected((prev) => {
      const next = new Set(prev[key]);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return { ...prev, [key]: next };
    });
  };
  const clear = () => setSelected(emptySelection());

  const labelFor = (key: FacetKey, value: string): string => {
    if (key === 'modality') return enumLabel(t, MODALITIES, value);
    if (key === 'capability')
      return t(CAPABILITIES.find((c) => c.key === value)?.labelKey ?? value);
    return value;
  };

  const rows: FacetRow[] = (['modality', 'maker', 'capability', 'tag'] as FacetKey[])
    .map((key) => ({
      key,
      title: t('facets.' + key),
      values: [...valuesFor(models, key).entries()].map(([value, count]) => ({
        value,
        label: labelFor(key, value),
        count,
      })),
    }))
    .filter((r) => r.values.length >= 2);

  const anySelected = (Object.keys(selected) as FacetKey[]).some((k) => selected[k].size > 0);

  return {
    filtered,
    facets: { rows, selected, toggle, clear, anySelected, filteredCount: filtered.length },
  };
}
