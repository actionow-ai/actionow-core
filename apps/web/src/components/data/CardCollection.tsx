import type { CSSProperties, ReactNode } from 'react';

import { RoseLoader } from '../ui/RoseLoader';

/**
 * Renders a set of entity cards as a responsive grid (default) or a vertical
 * list (for a narrow master pane), with shared loading + empty states. The
 * card-based replacement for a DataTable on non-tabular console pages.
 */
export function CardCollection<T>({
  rows,
  loading,
  empty,
  layout = 'grid',
  renderCard,
}: {
  rows: T[];
  loading?: boolean;
  empty?: ReactNode;
  layout?: 'grid' | 'list';
  renderCard: (row: T) => ReactNode;
}) {
  if (loading === true) {
    return (
      <div style={{ padding: 'var(--s-8)', display: 'grid', placeItems: 'center' }}>
        <RoseLoader size={64} />
      </div>
    );
  }
  if (rows.length === 0) {
    return <div style={{ padding: 'var(--s-8)', textAlign: 'center', color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>{empty}</div>;
  }
  const style: CSSProperties =
    layout === 'grid'
      ? { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 'var(--s-4)', alignContent: 'start' }
      : { display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' };
  return <div style={style}>{rows.map(renderCard)}</div>;
}
