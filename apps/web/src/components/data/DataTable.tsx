import type { ReactNode } from 'react';

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
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  empty?: ReactNode;
  loading?: boolean;
}) {
  const grid = columns.map((c) => c.width ?? '1fr').join(' ');
  return (
    <div className="panel" style={{ borderRadius: 'var(--r-md)', overflowX: 'auto' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: grid,
          gap: 'var(--s-3)',
          padding: '10px var(--s-4)',
          minWidth: 520,
          fontSize: 9,
          textTransform: 'uppercase',
          letterSpacing: '.05em',
          color: 'var(--faint)',
          borderBottom: '1px solid var(--row-bd)',
        }}
      >
        {columns.map((c) => (
          <div key={c.key}>{c.header}</div>
        ))}
      </div>
      {loading ? (
        <div style={{ padding: 'var(--s-6)', color: 'var(--muted)', fontSize: 12, textAlign: 'center' }}>…</div>
      ) : rows.length === 0 ? (
        <div style={{ padding: 'var(--s-6)', color: 'var(--muted)', fontSize: 12, textAlign: 'center' }}>{empty}</div>
      ) : (
        rows.map((r) => (
          <div
            key={rowKey(r)}
            style={{
              display: 'grid',
              gridTemplateColumns: grid,
              gap: 'var(--s-3)',
              padding: '11px var(--s-4)',
              minWidth: 520,
              fontSize: 11.5,
              alignItems: 'center',
              borderBottom: '1px solid var(--row-bd)',
            }}
          >
            {columns.map((c) => (
              <div key={c.key} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {c.cell(r)}
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}
