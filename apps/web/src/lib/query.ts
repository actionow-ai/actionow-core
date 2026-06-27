import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false } },
});

/** Catalog/reference data changes rarely → cache longer. */
export const STALE_REFERENCE = 60_000;
/** Read-mostly detail views within a session → medium. */
export const STALE_DETAIL = 30_000;
/** Volatile operational data (jobs/usage/ledger) → short. */
export const STALE_VOLATILE = 10_000;
