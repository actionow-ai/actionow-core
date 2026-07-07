import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorState } from '../../components/data/ErrorState';
import { Pill, type PillTone } from '../../components/ui/Pill';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { config } from '../../config';
import { qk } from '../../lib/api/queryKeys';
import type { ModelHealthView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';

/** Availability % → a tone: ≥99 ok, ≥95 wait, else fail. */
function availabilityTone(pct: number): PillTone {
  if (pct >= 99) return 'ok';
  if (pct >= 95) return 'wait';
  return 'fail';
}

/** Last-call status → a tone for the header dot. */
function statusTone(s: string | null): PillTone {
  if (s === 'succeeded') return 'ok';
  if (s === 'failed') return 'fail';
  if (s === null) return 'idle';
  return 'wait';
}

function fmtLatency(ms: number | null): string {
  return ms === null ? '—' : `${String(ms)}ms`;
}

/**
 * AI SERVICES STATUS — per-model availability/latency/uptime derived from real
 * `usage_log` traffic over a 7/15/30-day window (no synthetic probing). Each
 * model is a card with availability, avg/p95 latency, last-call status, and a
 * per-day uptime sparkline. Mirrors the public status-monitor pattern.
 */
export function StatusPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const [days, setDays] = useState(7);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: qk.modelHealth(days),
    queryFn: () => api.modelHealth(days),
    refetchInterval: 60_000, // live-ish: refresh each minute
  });

  const models = data ?? [];
  const down = models.filter((m) => m.last_status === 'failed').length;
  // A failed health query must read as FAIL, not as a neutral "no data".
  const overallTone: PillTone = isError
    ? 'fail'
    : models.length === 0
      ? 'idle'
      : down > 0
        ? 'fail'
        : 'ok';

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: 'var(--s-2) var(--s-3) var(--s-4)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--s-3)',
          marginBottom: 'var(--s-3)',
          flexWrap: 'wrap',
        }}
      >
        <h1 style={{ margin: 0, fontSize: 'var(--fs-md)', fontWeight: 'var(--fw-semibold)' }}>
          {t('status.title')}
        </h1>
        <Pill tone={overallTone} dot>
          {isError
            ? t('errors.loadFailed')
            : models.length === 0
              ? t('status.noData')
              : down > 0
                ? t('status.degraded', { n: down })
                : t('status.operational')}
        </Pill>
        <div style={{ marginLeft: 'auto' }}>
          <SegmentedControl
            ariaLabel={t('status.window')}
            value={String(days)}
            onChange={(v) => setDays(Number(v))}
            options={[
              { value: '7', label: t('status.days', { n: 7 }) },
              { value: '15', label: t('status.days', { n: 15 }) },
              { value: '30', label: t('status.days', { n: 30 }) },
            ]}
          />
        </div>
      </div>

      <ReadinessCard />

      {isError ? (
        <ErrorState onRetry={() => void refetch()} />
      ) : isLoading ? (
        <p style={{ color: 'var(--muted)' }}>{t('common.loading')}</p>
      ) : models.length === 0 ? (
        <p style={{ color: 'var(--muted)' }}>{t('status.empty')}</p>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
            gap: 'var(--s-3)',
          }}
        >
          {models.map((m) => (
            <ModelCard key={m.model} m={m} />
          ))}
        </div>
      )}
    </div>
  );
}

/** The /readyz body (200 ready or 503 degraded — both carry the same shape). */
interface ReadyzReport {
  status: 'ready' | 'degraded';
  checks: { postgres: string; redis: string; queue: string };
}

/**
 * Platform readiness (#56) — the infra dependency probe, distinct from the
 * AI-model health below. Fetches /readyz directly (it returns 503 when degraded,
 * which the standard client would treat as an error) and surfaces postgres / redis
 * / queue status so an operator separates "infra down" from "a model degraded".
 */
function ReadinessCard() {
  const { t } = useTranslation('console');
  const { data, isError } = useQuery({
    queryKey: qk.readyz(),
    queryFn: async (): Promise<ReadyzReport> => {
      const res = await fetch(`${config.apiBase}/readyz`);
      return (await res.json()) as ReadyzReport;
    },
    refetchInterval: 30_000,
  });
  const dep = (name: string, status: string | undefined) => (
    <Pill tone={status === undefined ? 'idle' : status === 'ok' ? 'ok' : 'fail'} dot>
      {name}
    </Pill>
  );
  return (
    <div
      className="panel"
      style={{
        padding: 'var(--s-3)',
        borderRadius: 'var(--r-md)',
        marginBottom: 'var(--s-3)',
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--s-2)',
        flexWrap: 'wrap',
      }}
    >
      <strong style={{ fontSize: 'var(--fs-sm)' }}>{t('status.readiness.title')}</strong>
      {/* A failed probe request reads as FAIL — not as an unknown/idle state. */}
      {isError ? (
        <Pill tone="fail" dot>
          {t('status.readiness.unreachable')}
        </Pill>
      ) : (
        data !== undefined && (
          <Pill tone={data.status === 'ready' ? 'ok' : 'fail'} dot>
            {t('status.readiness.' + data.status, data.status)}
          </Pill>
        )
      )}
      <span
        style={{ marginLeft: 'auto', display: 'inline-flex', gap: 'var(--s-2)', flexWrap: 'wrap' }}
      >
        {/* On a failed probe the per-dependency state is UNKNOWN (idle), not the
            stale last-success snapshot react-query keeps in `data`. */}
        {dep('PostgreSQL', isError ? undefined : data?.checks.postgres)}
        {dep('Redis', isError ? undefined : data?.checks.redis)}
        {dep('Queue', isError ? undefined : data?.checks.queue)}
      </span>
    </div>
  );
}

function ModelCard({ m }: { m: ModelHealthView }) {
  const { t } = useTranslation('console');
  return (
    <div
      className="panel"
      style={{
        padding: 'var(--s-3)',
        borderRadius: 'var(--r-md)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--s-3)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)' }}>
        <strong
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {m.model}
        </strong>
        <Pill tone={statusTone(m.last_status)} dot>
          {m.last_status === null
            ? t('status.idle')
            : t('status.last.' + m.last_status, m.last_status)}
        </Pill>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--s-3)' }}>
        <span
          className="tabular"
          style={{
            fontSize: 'var(--fs-lg)',
            fontWeight: 'var(--fw-semibold)',
            color: `var(--${availabilityTone(m.availability_pct)})`,
          }}
        >
          {m.availability_pct.toFixed(2)}%
        </span>
        <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--muted)' }}>
          {t('status.availability')}
        </span>
      </div>

      <Sparkline history={m.history} />

      <div
        style={{
          display: 'flex',
          gap: 'var(--s-4)',
          fontSize: 'var(--fs-caption)',
          color: 'var(--muted)',
        }}
      >
        <span>
          {t('status.avgLatency')}: <span className="tabular">{fmtLatency(m.avg_latency_ms)}</span>
        </span>
        <span>
          p95: <span className="tabular">{fmtLatency(m.p95_latency_ms)}</span>
        </span>
      </div>
      <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--muted)' }}>
        {t('status.requests', { total: m.total, errors: m.errors })}
      </div>
    </div>
  );
}

/** Per-day uptime bars (oldest→newest): green = clean, amber = some errors, red = all errors, grey = no data. */
function Sparkline({ history }: { history: ModelHealthView['history'] }) {
  const { t } = useTranslation('console');
  if (history.length === 0) {
    return (
      <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--muted)' }}>
        {t('status.noHistory')}
      </div>
    );
  }
  const okDays = history.filter((b) => b.total > 0 && b.errors === 0).length;
  const errDays = history.filter((b) => b.errors > 0).length;
  return (
    <div
      role="img"
      aria-label={t('status.sparkAria', { days: history.length, ok: okDays, err: errDays })}
      style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height: 28 }}
    >
      {history.map((b) => {
        const errRate = b.total > 0 ? b.errors / b.total : 0;
        const tone =
          b.total === 0 ? '--idle' : errRate === 0 ? '--ok' : errRate >= 1 ? '--fail' : '--wait';
        return (
          <div
            key={b.day}
            title={`${b.day}: ${String(b.total - b.errors)}/${String(b.total)} ok`}
            style={{
              flex: 1,
              minWidth: 3,
              height: '100%',
              borderRadius: 2,
              background: `color-mix(in srgb, var(${tone}) 70%, transparent)`,
            }}
          />
        );
      })}
    </div>
  );
}
