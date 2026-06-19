import type { ReactNode } from 'react';

import { RoseLoader } from '../ui/RoseLoader';
import { ErrorState } from './ErrorState';

/** The minimal slice of a react-query result this boundary needs. */
export interface QueryLike {
  isLoading: boolean;
  isError: boolean;
  refetch: () => unknown;
}

/**
 * Section-level async boundary for non-table content (balance cards, charts,
 * detail panes). Renders one of three states for one or many queries:
 * - error (any query failed) → `<ErrorState>` with a retry that refetches all,
 * - loading (any query still on its first load) → a centered `RoseLoader`,
 * - else → `children`.
 *
 * Error wins over loading so a failed refetch surfaces instead of spinning. This
 * is the cure for the `?? []` / `?? '0'` pattern that silently rendered failed
 * requests as empty/zero data.
 */
export function QueryBoundary({
  query,
  children,
  loading,
  message,
}: {
  query: QueryLike | QueryLike[];
  children: ReactNode;
  /** Override the default centered loader. */
  loading?: ReactNode;
  /** Override the default error message. */
  message?: ReactNode;
}) {
  const queries = Array.isArray(query) ? query : [query];
  const isError = queries.some((q) => q.isError);
  const isLoading = queries.some((q) => q.isLoading);

  if (isError) {
    return <ErrorState message={message} onRetry={() => queries.forEach((q) => q.refetch())} />;
  }
  if (isLoading) {
    return (
      loading ?? (
        <div style={{ padding: 'var(--s-6)', display: 'grid', placeItems: 'center' }}>
          <RoseLoader size={56} />
        </div>
      )
    );
  }
  return <>{children}</>;
}
