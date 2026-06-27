import { ArrowsClockwiseIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSetConsoleAction } from '../../components/console/ConsoleChrome';
import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Pill, type PillTone } from '../../components/ui/Pill';
import { RowAction } from '../../components/ui/RowAction';
import { toast } from '../../components/ui/toast';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { BreakerView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';

/** Breaker FSM state → palette tone: open = tripped (fail), half_open = probing (wait), closed = healthy (ok). */
function stateTone(state: BreakerView['state']): PillTone {
  if (state === 'open') return 'fail';
  if (state === 'half_open') return 'wait';
  return 'ok';
}

/** Relative remaining cooldown ("in 42s" / "ready") for an open breaker; em-dash when none. */
function cooldownLabel(iso: string | null, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (iso === null) return '—';
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return t('breakers.cooldown.ready');
  const secs = Math.ceil(ms / 1000);
  if (secs < 60) return t('breakers.cooldown.inS', { s: secs });
  return t('breakers.cooldown.inM', { m: Math.ceil(secs / 60) });
}

/** Absolute time (locale) for a transition timestamp; em-dash when null. */
function fmtTime(iso: string | null): string {
  return iso === null ? '—' : new Date(iso).toLocaleString();
}

/** Recent-window failure rate as a percent ("75.5%"); em-dash when null (Redis unreadable). */
function failureRateLabel(rate: number | null): string {
  return rate === null ? '—' : `${String(Math.round(rate * 10) / 10)}%`;
}

/**
 * The 熔断 (circuit breakers, 弹性2.0) console page — wired to the live
 * `/admin/breakers` backend. A read-mostly `DataTable` of every tripped/probing
 * `(channel, model)` breaker (a closed breaker has no row and is simply absent),
 * with a per-row reset action that clears it back to closed (ops un-stick). The
 * list auto-refreshes each 10s so a freshly-tripped or recovered breaker surfaces
 * without a manual reload.
 */
export function BreakersPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();

  const { data, isLoading, isFetching, isError, refetch } = useQuery({
    queryKey: qk.breakers(),
    queryFn: api.listBreakers,
    refetchInterval: 10_000, // live-ish: a tripped/recovered breaker shows up within 10s
  });

  const [resetTarget, setResetTarget] = useState<BreakerView | undefined>(undefined);

  const reset = useMutation({
    mutationFn: (row: BreakerView) => api.resetBreaker(row.channel_id, row.model),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.breakers() });
      toast(t('breakers.reset.done'));
      setResetTarget(undefined);
    },
    onError: mutationError(t),
  });

  useSetConsoleAction(
    () => (
      <Button
        variant="ghost"
        onClick={() => void qc.invalidateQueries({ queryKey: qk.breakers() })}
        loading={isFetching}
      >
        <ArrowsClockwiseIcon size={14} weight="bold" /> {t('breakers.refresh')}
      </Button>
    ),
    [t, isFetching, qc],
  );

  const cols: Column<BreakerView>[] = [
    {
      key: 'channel',
      header: t('breakers.cols.channel'),
      cell: (r) => (
        <span>
          <strong>{r.channel_name ?? t('breakers.unknownChannel')}</strong>
          {r.resource_id !== null && (
            <span style={{ marginLeft: 6, fontSize: 'var(--fs-caption)', color: 'var(--muted)' }}>
              {r.resource_id}
            </span>
          )}
        </span>
      ),
      width: '200px',
    },
    {
      key: 'model',
      header: t('breakers.cols.model'),
      cell: (r) => <span className="tabular">{r.model}</span>,
      width: '160px',
    },
    {
      key: 'state',
      header: t('breakers.cols.state'),
      noClip: true,
      cell: (r) => (
        <Pill tone={stateTone(r.state)} dot>
          {t('breakers.state.' + r.state, r.state)}
        </Pill>
      ),
      width: '120px',
    },
    {
      key: 'cooldown',
      header: t('breakers.cols.cooldown'),
      cell: (r) => (
        <span className="tabular" style={{ fontSize: 'var(--fs-caption)', color: 'var(--muted)' }}>
          {r.state === 'open' ? cooldownLabel(r.cooldown_until, t) : '—'}
        </span>
      ),
      width: '110px',
    },
    {
      key: 'trips',
      header: t('breakers.cols.trips'),
      cell: (r) => <span className="tabular">{r.trip_count}</span>,
      width: '80px',
    },
    {
      key: 'failureRate',
      header: t('breakers.cols.failureRate'),
      cell: (r) => <span className="tabular">{failureRateLabel(r.failure_rate)}</span>,
      width: '110px',
    },
    {
      key: 'transition',
      header: t('breakers.cols.transition'),
      cell: (r) => (
        <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--muted)' }}>
          {fmtTime(r.last_transition_at)}
        </span>
      ),
    },
  ];

  return (
    // Consistent with the sibling list pages: no own scroll/padding wrapper, no
    // in-page title (the TopBar renders the title + subtitle).
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
      <DataTable
        columns={cols}
        rows={data ?? []}
        rowKey={(r) => `${r.channel_id}:${r.model}`}
        loading={isLoading}
        error={isError}
        onRetry={() => void refetch()}
        empty={t('breakers.empty')}
        searchable
        pageSize={20}
        actionsWidth="48px"
        rowActions={(r) => (
          <RowAction
            icon={ArrowsClockwiseIcon}
            label={t('breakers.reset.action')}
            onClick={() => setResetTarget(r)}
          />
        )}
      />

      <ConfirmDialog
        open={resetTarget !== undefined}
        title={t('breakers.reset.title')}
        message={t('breakers.reset.msg', {
          channel: resetTarget?.channel_name ?? resetTarget?.channel_id ?? '',
          model: resetTarget?.model ?? '',
        })}
        confirmLabel={t('breakers.reset.action')}
        cancelLabel={t('common.cancel')}
        loading={reset.isPending}
        onConfirm={() => {
          if (resetTarget) reset.mutate(resetTarget);
        }}
        onClose={() => setResetTarget(undefined)}
      />
    </div>
  );
}
