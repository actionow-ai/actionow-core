import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { STALE_VOLATILE } from '../query';
import { qk } from './queryKeys';
import type { LatestAuditView } from './types';
import { useAdminApi } from './useAdminApi';

/**
 * Batch-fetch the newest `audit_log` row per visible entity (前端打磨 — the
 * version badges) in ONE request per list render. Keyed on the target type + the
 * SORTED visible ids (so row-order changes don't churn the cache), returning a
 * `Map<target_id, LatestAuditView>` for O(1) per-row lookup. Ids with no audit
 * history are simply absent from the map (the badge then renders nothing).
 * Disabled (no fetch) when `ids` is empty.
 */
export function useLatestAudit(targetType: string, ids: string[]): Map<string, LatestAuditView> {
  const api = useAdminApi();
  // A stable, sorted, de-duplicated id list — both the cache key and the request.
  const sortedIds = useMemo(() => Array.from(new Set(ids)).sort(), [ids]);

  const q = useQuery({
    queryKey: qk.latestAudit(targetType, sortedIds),
    queryFn: () => api.latestAudit(targetType, sortedIds),
    enabled: sortedIds.length > 0,
    staleTime: STALE_VOLATILE,
  });

  return useMemo(() => {
    const map = new Map<string, LatestAuditView>();
    for (const row of q.data ?? []) map.set(row.target_id, row);
    return map;
  }, [q.data]);
}
