import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import { qk } from '../../lib/api/queryKeys';
import type { ChannelHealthView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { STALE_VOLATILE } from '../../lib/query';
import { QueryBoundary } from '../data/QueryBoundary';
import { Pill, type PillTone } from '../ui/Pill';

/** Derived live state of one channel (authoritative, from the circuit-breaker + oauth). */
export type HealthState = 'healthy' | 'cooling' | 'reauth' | 'disabled';

const STATE_TONE: Record<HealthState, PillTone> = {
  healthy: 'ok',
  cooling: 'fail',
  reauth: 'wait',
  disabled: 'idle',
};

/** Derive a channel's live state. Row absence of a cooldown ⇒ healthy (NOT unknown). */
export function deriveChannelHealth(
  ch: ChannelHealthView,
  oauthByRef: Map<string, { status: string; expires_at: string | null }>,
  now: number,
): HealthState {
  if (ch.status === 'disabled') return 'disabled';
  if (ch.cooldown_until !== null && new Date(ch.cooldown_until).getTime() > now) return 'cooling';
  const oauth = ch.credential_ref === null ? undefined : oauthByRef.get(ch.credential_ref);
  if (
    oauth !== undefined &&
    (oauth.status === 'needs_reauth' ||
      (oauth.expires_at !== null && new Date(oauth.expires_at).getTime() < now))
  ) {
    return 'reauth';
  }
  return 'healthy';
}

/** Page-level worst-of verdict: cooling > reauth > healthy. Disabled is intentional, ignored. */
export function aggregateHealth(states: HealthState[]): HealthState {
  if (states.includes('cooling')) return 'cooling';
  if (states.includes('reauth')) return 'reauth';
  return 'healthy';
}

const ORDER: Record<HealthState, number> = { cooling: 0, reauth: 1, disabled: 2, healthy: 3 };

/** Format remaining cooldown as `m:ss` (or `<1s`). */
function remaining(cooldownUntil: string | null, now: number): string | null {
  if (cooldownUntil === null) return null;
  const ms = new Date(cooldownUntil).getTime() - now;
  if (ms <= 0) return null;
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Shared ops-health source: fetches the authoritative `GET /admin/health`
 * snapshot + the OAuth-session listing (for the re-auth overlay) and derives each
 * channel's live state + the page-level aggregate + billable RPM. Both the KPI
 * band and the {@link ModelHealthCard} consume this; TanStack dedupes the calls.
 */
export function useOpsHealth() {
  const api = useAdminApi();
  const health = useQuery({
    queryKey: qk.health(),
    queryFn: () => api.getHealth(),
    staleTime: STALE_VOLATILE,
    refetchInterval: 20_000,
  });
  const oauth = useQuery({
    queryKey: qk.oauthSessions(),
    queryFn: () => api.listOAuthSessions({ limit: 200 }),
    staleTime: STALE_VOLATILE,
  });
  const now = Date.now();
  const oauthByRef = useMemo(() => {
    const m = new Map<string, { status: string; expires_at: string | null }>();
    for (const s of oauth.data?.rows ?? []) m.set(s.id, { status: s.status, expires_at: s.expires_at });
    return m;
  }, [oauth.data]);
  const channels = useMemo(() => {
    const list = (health.data?.channels ?? []).map((ch) => ({
      ch,
      state: deriveChannelHealth(ch, oauthByRef, now),
    }));
    list.sort((a, b) => ORDER[a.state] - ORDER[b.state]);
    return list;
  }, [health.data, oauthByRef, now]);
  const aggregate = aggregateHealth(channels.map((c) => c.state));
  return {
    health,
    channels,
    aggregate,
    rpm: health.data?.rpm_billable ?? 0,
    isLoading: health.isLoading,
  };
}

/**
 * The per-channel health board (operator overview). Independent of the analytics
 * lens — it shows "is anything broken right now" from the circuit-breaker + oauth
 * status, with each row deep-linking to that channel's relay traces.
 */
export function ModelHealthCard() {
  const { t } = useTranslation('console');
  const { health, channels } = useOpsHealth();
  const now = Date.now();

  const label = (s: HealthState) => t(`overview.health.state.${s}`);

  return (
    <QueryBoundary query={health}>
      {channels.length === 0 ? (
        <div style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)', padding: 'var(--s-3)' }}>
          {t('overview.health.empty')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {channels.map(({ ch, state }) => {
            const left = state === 'cooling' ? remaining(ch.cooldown_until, now) : null;
            return (
              <Link
                key={ch.channel_id}
                to={`/console/relay-traces?channelId=${encodeURIComponent(ch.channel_id)}`}
                className="glass-hover"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--s-3)',
                  padding: 'var(--s-2) var(--s-2)',
                  borderRadius: 'var(--r-sm)',
                  color: 'inherit',
                  textDecoration: 'none',
                  fontSize: 'var(--fs-sm)',
                }}
              >
                <span style={{ fontWeight: 'var(--fw-medium)', flexShrink: 0 }}>
                  {ch.provider_type}
                </span>
                <span
                  className="mono"
                  style={{
                    fontSize: 'var(--fs-caption)',
                    color: 'var(--faint)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {ch.channel_id.slice(0, 8)}
                </span>
                <span style={{ flex: 1 }} />
                {left !== null && (
                  <span className="tabular" style={{ fontSize: 'var(--fs-caption)', color: 'var(--fail)' }}>
                    {t('overview.health.cooldown', { time: left, n: ch.consecutive_failures })}
                  </span>
                )}
                <Pill tone={STATE_TONE[state]} dot>
                  {label(state)}
                </Pill>
              </Link>
            );
          })}
        </div>
      )}
    </QueryBoundary>
  );
}
