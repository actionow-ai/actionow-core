import type { CSSProperties, ReactNode } from 'react';

import { BP } from '../../lib/breakpoints';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { RoseLoader } from '../ui/RoseLoader';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  width?: string;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  empty,
  loading,
  fill,
  onRowClick,
  selectedKey,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  empty?: ReactNode;
  loading?: boolean;
  fill?: boolean;
  onRowClick?: (row: T) => void;
  selectedKey?: string;
}) {
  const isDesktop = useMediaQuery(BP.md);
  const grid = columns.map((c) => c.width ?? '1fr').join(' ');
  const clickable = onRowClick !== undefined;

  const rootStyle: CSSProperties = {
    borderRadius: 'var(--r-md)',
    overflowX: isDesktop ? 'auto' : 'visible',
    ...(fill ? { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } : null),
  };

  const loadingState = (
    <div style={{ padding: 'var(--s-6)', display: 'grid', placeItems: 'center' }}>
      <RoseLoader size={56} />
    </div>
  );

  const emptyState = (
    <div style={{ padding: 'var(--s-6)', color: 'var(--muted)', fontSize: 'var(--fs-sm)', textAlign: 'center' }}>{empty}</div>
  );

  const bodyStyle: CSSProperties = fill ? { flex: 1, minHeight: 0, overflowY: 'auto' } : {};

  const rowProps = (r: T) => {
    const selected = selectedKey !== undefined && rowKey(r) === selectedKey;
    return {
      className: clickable ? 'dt-row' : undefined,
      onClick: clickable ? () => onRowClick(r) : undefined,
      selectedBg: selected ? 'var(--hover-bg)' : undefined,
      selectedBd: selected,
    };
  };

  if (!isDesktop) {
    return (
      <div className="panel" style={rootStyle}>
        <div style={bodyStyle}>
          {loading ? (
            loadingState
          ) : rows.length === 0 ? (
            emptyState
          ) : (
            rows.map((r) => {
              const rp = rowProps(r);
              return (
                <div
                  key={rowKey(r)}
                  className={rp.className}
                  onClick={rp.onClick}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 'var(--s-2)',
                    padding: 'var(--s-4)',
                    borderBottom: '1px solid var(--row-bd)',
                    background: rp.selectedBg,
                  }}
                >
                  {columns.map((c) => (
                    <div key={c.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--s-3)' }}>
                      <div
                        style={{
                          fontSize: 'var(--fs-caption)',
                          color: 'var(--muted)',
                          textTransform: 'uppercase',
                          letterSpacing: '.05em',
                          flexShrink: 0,
                        }}
                      >
                        {c.header}
                      </div>
                      <div style={{ fontSize: 'var(--fs-sm)', minWidth: 0, textAlign: 'right' }}>{c.cell(r)}</div>
                    </div>
                  ))}
                </div>
              );
            })
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="panel" style={rootStyle}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: grid,
          gap: 'var(--s-3)',
          padding: '10px var(--s-4)',
          minWidth: 520,
          fontSize: 'var(--fs-caption)',
          textTransform: 'uppercase',
          letterSpacing: '.05em',
          color: 'var(--muted)',
          borderBottom: '1px solid var(--row-bd)',
        }}
      >
        {columns.map((c) => (
          <div key={c.key}>{c.header}</div>
        ))}
      </div>
      <div style={bodyStyle}>
        {loading ? (
          loadingState
        ) : rows.length === 0 ? (
          emptyState
        ) : (
          rows.map((r) => {
            const rp = rowProps(r);
            return (
              <div
                key={rowKey(r)}
                className={rp.className}
                onClick={rp.onClick}
                style={{
                  display: 'grid',
                  gridTemplateColumns: grid,
                  gap: 'var(--s-3)',
                  padding: 'var(--s-3) var(--s-4)',
                  minWidth: 520,
                  fontSize: 'var(--fs-sm)',
                  alignItems: 'center',
                  borderBottom: '1px solid var(--row-bd)',
                  background: rp.selectedBg,
                  boxShadow: rp.selectedBd ? 'inset 2px 0 0 var(--accent)' : undefined,
                }}
              >
                {columns.map((c) => (
                  <div key={c.key} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {c.cell(r)}
                  </div>
                ))}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
