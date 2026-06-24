import { useState } from 'react';

/** One filter dimension over a list of `T` (e.g. status / modality / maker). */
export interface FacetDef<T> {
  key: string;
  title: string;
  /** The value(s) an item exposes for this facet (multi for tags/capabilities). */
  values: (item: T) => string[];
  /** Optional display label for a raw value (else the raw value is shown). */
  label?: (value: string) => string;
}

/** A rendered facet group: distinct values (with counts) for one dimension. */
export interface FacetGroup {
  key: string;
  title: string;
  options: { value: string; label: string; count: number }[];
}

export interface Facets<T> {
  selected: Record<string, Set<string>>;
  toggle: (key: string, value: string) => void;
  clear: () => void;
  /** `defs`-driven predicate: OR within a dimension, AND across dimensions. */
  match: (item: T) => boolean;
  filtered: T[];
  /** Dimensions with ≥2 distinct values (a single value can't narrow). */
  groups: FacetGroup[];
  activeCount: number;
}

/**
 * Generic multi-dimension faceting for the 模型接入 columns (plugins / channels /
 * models). Mirrors the catalog facet semantics — multi-select OR within a
 * dimension, AND across dimensions — but is data-type agnostic and surfaced via a
 * popover ({@link FilterMenu}) rather than an inline chip bar.
 */
export function useFacets<T>(items: T[], defs: FacetDef<T>[]): Facets<T> {
  const [selected, setSelected] = useState<Record<string, Set<string>>>({});

  const toggle = (key: string, value: string): void =>
    setSelected((prev) => {
      const cur = new Set(prev[key] ?? []);
      if (cur.has(value)) cur.delete(value);
      else cur.add(value);
      return { ...prev, [key]: cur };
    });
  const clear = (): void => setSelected({});

  const match = (item: T): boolean =>
    defs.every((d) => {
      // Index access is typed non-undefined (noUncheckedIndexedAccess off) but a
      // never-toggled key is absent at runtime — cast so the guard is real.
      const sel = selected[d.key] as Set<string> | undefined;
      if (sel === undefined || sel.size === 0) return true;
      return d.values(item).some((v) => sel.has(v));
    });
  const filtered = items.filter(match);

  const groups: FacetGroup[] = defs
    .map((d) => {
      const counts = new Map<string, number>();
      for (const it of items)
        for (const v of d.values(it)) if (v !== '') counts.set(v, (counts.get(v) ?? 0) + 1);
      return {
        key: d.key,
        title: d.title,
        options: [...counts.entries()].map(([value, count]) => ({
          value,
          label: d.label ? d.label(value) : value,
          count,
        })),
      };
    })
    .filter((g) => g.options.length >= 2);

  const activeCount = Object.values(selected).reduce((n, s) => n + s.size, 0);

  return { selected, toggle, clear, match, filtered, groups, activeCount };
}
