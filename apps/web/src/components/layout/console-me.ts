import { useQuery } from '@tanstack/react-query';

import { apiFetch } from '@/api/client';

/** `GET /console/me` wire view (subset the shells need). */
export interface ConsoleMe {
  id: string;
  email: string;
  role: 'user' | 'admin';
  tenant_id: string | null;
  tenant_role: 'admin' | 'member' | null;
}

/**
 * The caller's tenant-plane identity. Fails quietly (retry: false) — a
 * tenant-less platform admin gets 4xx here and the shells fall back to
 * JWT-derived labels.
 */
export function useConsoleMe(enabled = true) {
  return useQuery({
    queryKey: ['console', 'me'],
    queryFn: () => apiFetch<ConsoleMe>('/console/me'),
    staleTime: Infinity,
    retry: false,
    enabled,
  });
}
