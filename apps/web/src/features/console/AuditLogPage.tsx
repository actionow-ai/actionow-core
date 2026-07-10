import { XIcon } from '@phosphor-icons/react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { DetailRow } from '../../components/console/DetailScaffold';
import {
  FILTER_SELECT_MIN_W,
  InlineFilterField,
  InlineFilterLabel,
  StickyFilterBar,
} from '../../components/console/StickyFilterBar';
import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { LoadMore } from '../../components/data/LoadMore';
import { TenantSelect } from '../../components/data/TenantSelect';
import { DateField } from '../../components/ui/DateField';
import { Drawer } from '../../components/ui/Drawer';
import { Pill, type PillTone } from '../../components/ui/Pill';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { TextField } from '../../components/ui/TextField';
import { qk } from '../../lib/api/queryKeys';
import type { AuditLogView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { STALE_VOLATILE } from '../../lib/query';
import { useDebounced } from '../../lib/useDebounced';
import { useUrlState } from '../../lib/useUrlState';

const ACTOR_TONE: Record<string, PillTone> = {
  operator: 'run',
  member: 'ok',
  system: 'idle',
};

/** Compact one-line JSON preview for the `meta` column (full JSON shows in the drawer). */
function metaPreview(meta: unknown): string {
  if (meta === null || meta === undefined) return '';
  try {
    const s = JSON.stringify(meta);
    return s === '{}' ? '' : s;
  } catch {
    return '';
  }
}

const SHORT = (id: string | null): string => (id === null ? '—' : id.slice(0, 8));

/**
 * The 审计日志 (audit log, 记录系统) console page — `/console/audit-log` in the 运营
 * group. A sticky filter bar (tenant / actor type / action / target / time range)
 * over a keyset-paginated `DataTable` of who-changed-what records; a row opens a
 * drawer with the full actor/target/meta detail. Read-only (the log is append-only).
 */
export function AuditLogPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();

  const [tenantId, setTenantId] = useUrlState('tenant');
  const [actorType, setActorType] = useUrlState('actor');
  const [action, setAction] = useUrlState('action');
  const [targetType, setTargetType] = useUrlState('target');
  const [targetId, setTargetId] = useUrlState('target_id');
  const [from, setFrom] = useUrlState('from');
  const [to, setTo] = useUrlState('to');
  const [selected, setSelected] = useState<AuditLogView | undefined>(undefined);

  const [actionLocal, setActionLocal] = useDebounced(action, setAction);
  const [targetLocal, setTargetLocal] = useDebounced(targetType, setTargetType);

  const filters: Record<string, string | undefined> = {
    tenantId: tenantId === '' ? undefined : tenantId,
    actorType: actorType === '' ? undefined : actorType,
    action: action === '' ? undefined : action,
    targetType: targetType === '' ? undefined : targetType,
    targetId: targetId === '' ? undefined : targetId,
    from: from === '' ? undefined : `${from}T00:00:00Z`,
    to: to === '' ? undefined : `${to}T23:59:59Z`,
  };

  const q = useInfiniteQuery({
    queryKey: qk.auditLog(filters),
    queryFn: ({ pageParam }) => api.listAuditLog({ ...filters, limit: '50', cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: STALE_VOLATILE,
  });
  const rows = q.data?.pages.flatMap((p) => p.rows) ?? [];

  const cols: Column<AuditLogView>[] = [
    {
      key: 'time',
      header: t('auditLog.cols.time'),
      cell: (r) => new Date(r.created_at).toLocaleString(),
      width: '170px',
    },
    {
      key: 'actor',
      header: t('auditLog.cols.actor'),
      noClip: true,
      cell: (r) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-1h)' }}>
          <Pill tone={ACTOR_TONE[r.actor_type] ?? 'idle'}>
            {t('auditLog.actor.' + r.actor_type, r.actor_type)}
          </Pill>
          {r.actor_id !== null && (
            <span className="mono" style={{ color: 'var(--muted)' }} title={r.actor_id}>
              {SHORT(r.actor_id)}
            </span>
          )}
        </span>
      ),
      width: '170px',
    },
    {
      key: 'action',
      header: t('auditLog.cols.action'),
      cell: (r) => <span className="mono">{r.action}</span>,
      width: '180px',
    },
    {
      key: 'target',
      header: t('auditLog.cols.target'),
      cell: (r) => (
        <span>
          {r.target_type}
          {r.target_id !== null && (
            <span className="mono" style={{ color: 'var(--muted)' }} title={r.target_id}>
              {' '}
              {SHORT(r.target_id)}
            </span>
          )}
        </span>
      ),
      width: '180px',
    },
    {
      key: 'scope',
      header: t('auditLog.cols.scope'),
      cell: (r) => (
        <span className="mono" style={{ color: 'var(--muted)', fontSize: 'var(--fs-caption)' }}>
          {SHORT(r.tenant_id)}
          {r.subject_id !== null ? ` / ${SHORT(r.subject_id)}` : ''}
        </span>
      ),
      width: '140px',
    },
    {
      key: 'meta',
      header: t('auditLog.cols.meta'),
      cell: (r) => (
        <span
          className="mono"
          style={{
            color: 'var(--faint)',
            fontSize: 'var(--fs-caption)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            display: 'block',
          }}
        >
          {metaPreview(r.meta)}
        </span>
      ),
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
      <StickyFilterBar>
        <div style={{ minWidth: FILTER_SELECT_MIN_W }}>
          <TenantSelect
            value={tenantId}
            onChange={setTenantId}
            placeholder={t('auditLog.allTenants')}
          />
        </div>
        <SegmentedControl
          ariaLabel={t('auditLog.cols.actor')}
          value={actorType}
          onChange={setActorType}
          options={[
            { value: '', label: t('auditLog.actor.all') },
            { value: 'operator', label: t('auditLog.actor.operator') },
            { value: 'member', label: t('auditLog.actor.member') },
            { value: 'system', label: t('auditLog.actor.system') },
          ]}
        />
        <InlineFilterField id="flt-audit-action" label={t('auditLog.cols.action')}>
          <TextField
            id="flt-audit-action"
            value={actionLocal}
            onChange={setActionLocal}
            placeholder={t('auditLog.actionPlaceholder')}
          />
        </InlineFilterField>
        <InlineFilterField id="flt-audit-target" label={t('auditLog.targetPlaceholder')}>
          <TextField id="flt-audit-target" value={targetLocal} onChange={setTargetLocal} />
        </InlineFilterField>
        {targetId !== '' && (
          <button
            type="button"
            onClick={() => setTargetId('')}
            title={t('auditLog.clearTargetId')}
            // NOT `all: unset` — that would also kill the global :focus-visible ring.
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              font: 'inherit',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            <Pill tone="neutral">
              {t('auditLog.targetIdFilter', { id: SHORT(targetId) })}{' '}
              <XIcon size={12} weight="bold" aria-hidden="true" />
            </Pill>
          </button>
        )}
        <InlineFilterLabel text={t('auditLog.from')}>
          <DateField
            value={from}
            onChange={setFrom}
            max={to === '' ? undefined : to}
            ariaLabel={t('auditLog.from')}
          />
        </InlineFilterLabel>
        <InlineFilterLabel text={t('auditLog.to')}>
          <DateField
            value={to}
            onChange={setTo}
            min={from === '' ? undefined : from}
            ariaLabel={t('auditLog.to')}
          />
        </InlineFilterLabel>
      </StickyFilterBar>

      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        error={q.isError}
        onRetry={() => void q.refetch()}
        empty={t('auditLog.empty')}
        onRowClick={(r) => setSelected(r)}
        selectedKey={selected?.id}
      />

      <LoadMore
        hasNextPage={q.hasNextPage}
        isFetchingNextPage={q.isFetchingNextPage}
        onLoadMore={() => void q.fetchNextPage()}
      />

      <Drawer
        open={selected !== undefined}
        title={t('auditLog.detail.title')}
        onClose={() => setSelected(undefined)}
        width="min(560px, 96vw)"
      >
        {selected !== undefined && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
            <DetailRow label={t('auditLog.cols.time')}>
              {new Date(selected.created_at).toLocaleString()}
            </DetailRow>
            <DetailRow label={t('auditLog.cols.actor')}>
              {t('auditLog.actor.' + selected.actor_type, selected.actor_type)}
              {selected.actor_id !== null ? ` · ${selected.actor_id}` : ''}
            </DetailRow>
            <DetailRow label={t('auditLog.cols.action')}>
              <span className="mono">{selected.action}</span>
            </DetailRow>
            <DetailRow label={t('auditLog.cols.target')}>
              <span className="mono">
                {selected.target_type}
                {selected.target_id !== null ? ` · ${selected.target_id}` : ''}
              </span>
            </DetailRow>
            <DetailRow label={t('auditLog.cols.scope')}>
              <span className="mono">
                {selected.tenant_id ?? '—'}
                {selected.subject_id !== null ? ` / ${selected.subject_id}` : ''}
              </span>
            </DetailRow>
            <DetailRow label={t('auditLog.cols.meta')}>
              <pre
                style={{
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  fontSize: 'var(--fs-caption)',
                  color: 'var(--text)',
                }}
              >
                {JSON.stringify(selected.meta ?? {}, null, 2)}
              </pre>
            </DetailRow>
          </div>
        )}
      </Drawer>
    </div>
  );
}
