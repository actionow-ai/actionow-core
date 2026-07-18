import { useInfiniteQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { apiFetch, type PageOf, type QueryValue } from './client';

/**
 * Cursor-paginated list query. Loads pages of `limit` rows and exposes the
 * flattened window in `rows`; call `fetchNextPage` from a load-more footer.
 */
export function useCursorQuery<T>(options: {
  key: readonly unknown[];
  path: string;
  query?: Record<string, QueryValue>;
  limit?: number;
  enabled?: boolean;
}) {
  const { key, path, query, limit = 50, enabled = true } = options;
  const result = useInfiniteQuery({
    queryKey: [...key, query ?? null, limit],
    queryFn: ({ pageParam, signal }) =>
      apiFetch<PageOf<T>>(path, {
        query: { ...query, cursor: pageParam === '' ? undefined : pageParam, limit },
        signal,
      }),
    initialPageParam: '',
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled,
  });
  const rows = useMemo(
    () => result.data?.pages.flatMap((page) => page.data) ?? [],
    [result.data],
  );
  return { ...result, rows };
}
