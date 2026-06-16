import type { QueryKey } from '@tanstack/react-query';
import { QueryClient, useInfiniteQuery } from '@tanstack/react-query';

import type { Page } from './api/types';

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false } },
});

/** Keyset-paginated list backed by useInfiniteQuery; flattens loaded pages into `rows`. */
export function useKeyset<T>(key: QueryKey, fetchPage: (cursor?: string) => Promise<Page<T>>) {
  const q = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  return {
    rows: (q.data?.pages ?? []).flatMap((p) => p.rows),
    hasNext: q.hasNextPage,
    isLoading: q.isLoading,
    isFetchingNext: q.isFetchingNextPage,
    fetchNext: () => void q.fetchNextPage(),
  };
}
