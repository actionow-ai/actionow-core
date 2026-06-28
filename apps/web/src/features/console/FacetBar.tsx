import { useTranslation } from 'react-i18next';

import type { ModelFacets } from './useModelFacets';

/**
 * The catalog facet chip-bar (模态/开发者/能力/标签). Purely presentational — all
 * derivation and selection state live in {@link useModelFacets}; this only renders
 * the rows of toggle chips and the clear button. Returns null when there are no
 * facets that can narrow the set.
 */
export function FacetBar({ facets }: { facets: ModelFacets }) {
  const { t } = useTranslation('console');
  const { rows, selected, toggle, clear, anySelected, filteredCount } = facets;
  if (rows.length === 0) return null;

  return (
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
            {r.values.map((v) => {
              const on = selected[r.key].has(v.value);
              return (
                <button
                  key={v.value}
                  type="button"
                  className="chip"
                  onClick={() => toggle(r.key, v.value)}
                  style={{
                    cursor: 'pointer',
                    border: on ? '1px solid var(--accent)' : '1px solid transparent',
                    background: on ? 'var(--hover-bg)' : undefined,
                    color: on ? 'var(--text)' : undefined,
                  }}
                >
                  {v.label} <span style={{ color: 'var(--faint)' }}>{v.count}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {anySelected && (
        <button
          type="button"
          onClick={clear}
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
          {t('facets.clear', { n: filteredCount })}
        </button>
      )}
    </div>
  );
}
