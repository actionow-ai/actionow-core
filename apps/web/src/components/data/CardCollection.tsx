import type { CSSProperties, ReactNode } from 'react';
import { useRef } from 'react';

import { gsap, useGSAP } from '../../lib/motion/gsap';
import { DUR, EASE } from '../../lib/motion/tokens';
import { RoseLoader } from '../ui/RoseLoader';
import { ErrorState } from './ErrorState';

/**
 * Renders a set of entity cards as a responsive grid (default) or a vertical
 * list (for a narrow master pane), with shared loading + empty states. The
 * card-based replacement for a DataTable on non-tabular console pages.
 */
export function CardCollection<T>({
  rows,
  loading,
  error,
  onRetry,
  empty,
  layout = 'grid',
  renderCard,
}: {
  rows: T[];
  loading?: boolean;
  /** Render an error + retry state in place of cards when the backing query failed. */
  error?: boolean;
  /** Retry handler for the error state — wire to the query's `refetch`. */
  onRetry?: () => void;
  empty?: ReactNode;
  layout?: 'grid' | 'list';
  renderCard: (row: T) => ReactNode;
}) {
  const gridRef = useRef<HTMLDivElement>(null);

  // Stagger-reveal the rendered cards when the row set changes. fromTo (explicit
  // start+end) so a re-run can't strand a card hidden; reduced-motion skips it.
  // The hook stays above the loading/empty early-returns so it's unconditional.
  useGSAP(
    () => {
      const el = gridRef.current;
      if (!el || el.children.length === 0) return;
      const mm = gsap.matchMedia();
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        gsap.fromTo(
          el.children,
          { opacity: 0, y: 12 },
          { opacity: 1, y: 0, duration: DUR.base, ease: EASE.out, stagger: 0.04 },
        );
      });
    },
    { scope: gridRef, dependencies: [rows.length] },
  );

  if (error === true) {
    return <ErrorState onRetry={onRetry} />;
  }
  if (loading === true) {
    return (
      <div style={{ padding: 'var(--s-8)', display: 'grid', placeItems: 'center' }}>
        <RoseLoader size={64} />
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div
        style={{
          padding: 'var(--s-8)',
          textAlign: 'center',
          color: 'var(--muted)',
          fontSize: 'var(--fs-sm)',
        }}
      >
        {empty}
      </div>
    );
  }
  const style: CSSProperties =
    layout === 'grid'
      ? {
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: 'var(--s-4)',
          alignContent: 'start',
        }
      : { display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' };
  return (
    <div ref={gridRef} style={style}>
      {rows.map(renderCard)}
    </div>
  );
}
