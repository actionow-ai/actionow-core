import { KeyIcon, SignOutIcon, UserCircleIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { Logo } from '../../components/brand/Logo';
import { BalanceCard } from '../../components/data/BalanceCard';
import { CopyField } from '../../components/data/CopyField';
import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { LimitUsageBars } from '../../components/data/LimitUsageBars';
import { Money } from '../../components/data/Money';
import { QueryBoundary } from '../../components/data/QueryBoundary';
import { StatusBadge, statusTone } from '../../components/data/StatusBadge';
import { AppBackground } from '../../components/glass/AppBackground';
import { LanguageSwitch } from '../../components/layout/LanguageSwitch';
import { ThemeToggle } from '../../components/layout/ThemeToggle';
import { Button } from '../../components/ui/Button';
import { Pill } from '../../components/ui/Pill';
import { SectionHeader } from '../../components/ui/SectionHeader';
import { qk } from '../../lib/api/queryKeys';
import type { MemberUsageRow } from '../../lib/api/types';
import { useMemberApi } from '../../lib/api/useMemberApi';
import { useAuth } from '../../lib/auth/AuthProvider';
import { STALE_REFERENCE, STALE_VOLATILE } from '../../lib/query';

/** One labelled identity row. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-1)' }}>
      <span
        style={{
          fontSize: 'var(--fs-caption)',
          textTransform: 'uppercase',
          letterSpacing: '.06em',
          color: 'var(--faint)',
        }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

const card = {
  borderRadius: 'var(--r-lg)',
  padding: 'var(--s-5)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--s-4)',
} as const;

/**
 * The MEMBER (end-user) portal — `/portal` (unified tenancy G-F + end-user data
 * plane Part B). A member JWT is rejected by every operator plane
 * (`ConsoleGuard`/`AdminGuard`), so this portal calls ONLY the read-only
 * `/member/*` endpoints (via {@link useMemberApi}, the member-token raw client),
 * each token-scoped to the caller's OWN subject server-side. Read-only in v1:
 * the member sees identity + wallet balance + governance plan/usage + their own
 * masked keys + recent usage — but no write controls (no plan binding, no key
 * mint, no top-up; those live on the tenant-admin `/app` plane and would 403/404
 * for a member).
 */
export function MemberPortal() {
  const { t } = useTranslation('console');
  const { logout } = useAuth();
  const navigate = useNavigate();
  const api = useMemberApi();

  const me = useQuery({
    queryKey: qk.memberMe(),
    queryFn: () => api.me(),
    staleTime: STALE_REFERENCE,
  });
  const balance = useQuery({
    queryKey: qk.memberBalance(),
    queryFn: () => api.balance(),
    staleTime: STALE_VOLATILE,
  });
  const limits = useQuery({
    queryKey: qk.memberLimits(),
    queryFn: () => api.limits(),
    staleTime: STALE_VOLATILE,
  });
  const usage = useQuery({
    queryKey: qk.memberUsage(),
    queryFn: () => api.usage(50),
    staleTime: STALE_VOLATILE,
  });
  const keys = useQuery({
    queryKey: qk.memberApiKeys(),
    queryFn: () => api.apiKeys(),
    staleTime: STALE_REFERENCE,
  });

  const ident = me.data;
  const bal = balance.data;
  const lim = limits.data;
  const usageRows = usage.data?.data ?? [];
  const keyRows = keys.data ?? [];

  const usageCols: Column<MemberUsageRow>[] = [
    {
      key: 'time',
      header: t('app.usage.cols.time'),
      cell: (r) => new Date(r.created_at).toLocaleString(),
      width: '170px',
    },
    {
      key: 'model',
      header: t('app.usage.cols.model'),
      cell: (r) => <span className="mono">{r.model}</span>,
    },
    {
      key: 'tokens',
      header: t('app.usage.cols.tokens'),
      numeric: true,
      cell: (r) => (r.input_tokens + r.output_tokens).toLocaleString(),
      width: '110px',
    },
    {
      key: 'cost',
      header: t('app.usage.cols.cost'),
      numeric: true,
      cell: (r) => <Money micro={r.cost} />,
      width: '110px',
    },
    {
      key: 'latency',
      header: t('app.usage.cols.latency'),
      numeric: true,
      cell: (r) => (r.latency_ms !== null ? `${String(r.latency_ms)} ms` : '—'),
      width: '96px',
    },
    {
      key: 'status',
      header: t('app.usage.cols.status'),
      noClip: true,
      cell: (r) => (
        <StatusBadge tone={statusTone(r.status)} label={t('status.' + r.status, r.status)} />
      ),
      width: '110px',
    },
  ];

  return (
    <>
      <AppBackground grid />
      <div
        style={{
          position: 'absolute',
          top: 'var(--s-4)',
          right: 'var(--s-4)',
          zIndex: 2,
          display: 'flex',
          gap: 'var(--s-2)',
        }}
      >
        <LanguageSwitch />
        <ThemeToggle />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            logout();
            void navigate('/member/login', { replace: true });
          }}
        >
          <SignOutIcon size={14} weight="bold" /> {t('topbar.logout')}
        </Button>
      </div>

      <div
        style={{
          position: 'relative',
          zIndex: 1,
          minHeight: '100dvh',
          display: 'flex',
          justifyContent: 'center',
          padding: 'var(--s-8) var(--s-5)',
        }}
      >
        <div
          style={{
            width: 'min(720px, 96vw)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--s-5)',
          }}
        >
          {/* Identity */}
          <div className="glass" style={card}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <Logo size={24} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-3)' }}>
              <UserCircleIcon size={40} weight="duotone" style={{ color: 'var(--accent)' }} />
              <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <strong style={{ fontSize: 'var(--fs-h3)' }}>{t('member.portal.title')}</strong>
                <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
                  {t('member.portal.subtitle')}
                </span>
              </div>
            </div>
            <QueryBoundary query={me}>
              {ident !== undefined && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
                  {ident.display_name !== null && (
                    <Row label={t('member.portal.name')}>
                      <span>{ident.display_name}</span>
                    </Row>
                  )}
                  {ident.email !== null && (
                    <Row label={t('member.portal.email')}>
                      <span>{ident.email}</span>
                    </Row>
                  )}
                  <Row label={t('member.portal.subjectId')}>
                    <CopyField
                      value={ident.id}
                      copyLabel={t('common.copy')}
                      copiedLabel={t('common.copied')}
                      failedLabel={t('common.copyFailed')}
                    />
                  </Row>
                  <Row label={t('member.portal.tenantId')}>
                    <CopyField
                      value={ident.tenant_id}
                      copyLabel={t('common.copy')}
                      copiedLabel={t('common.copied')}
                      failedLabel={t('common.copyFailed')}
                    />
                  </Row>
                </div>
              )}
            </QueryBoundary>
          </div>

          {/* Wallet balance */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
            <SectionHeader title={t('member.portal.balance')} />
            <QueryBoundary query={balance}>
              {bal !== undefined &&
                (bal.mode === 'shared' ? (
                  <div
                    className="panel"
                    style={{
                      borderRadius: 'var(--r-md)',
                      padding: 'var(--s-5)',
                      color: 'var(--muted)',
                      fontSize: 'var(--fs-sm)',
                    }}
                  >
                    {t('member.portal.sharedPool')}
                  </div>
                ) : (
                  <BalanceCard
                    micro={bal.balance}
                    label={t('member.portal.balance')}
                    held={bal.held}
                    heldLabel={t('accounts.cols.held')}
                  />
                ))}
            </QueryBoundary>
          </div>

          {/* Governance plan + usage-vs-cap */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
            <SectionHeader title={t('member.portal.plan')} />
            <QueryBoundary query={limits}>
              {lim !== undefined && (
                <div
                  className="panel"
                  style={{
                    borderRadius: 'var(--r-md)',
                    padding: 'var(--s-4)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 'var(--s-3)',
                  }}
                >
                  {lim.plan !== null ? (
                    <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 'var(--fw-medium)' }}>
                      {lim.plan.name}
                    </span>
                  ) : (
                    <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
                      {t('member.portal.noPlan')}
                    </span>
                  )}
                  {lim.rules.length > 0 && <LimitUsageBars rules={lim.rules} />}
                </div>
              )}
            </QueryBoundary>
          </div>

          {/* Own API keys (masked, read-only) */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
            <SectionHeader title={t('member.portal.keys')} />
            <QueryBoundary query={keys}>
              <div
                className="panel"
                style={{
                  borderRadius: 'var(--r-md)',
                  padding: 'var(--s-4)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--s-2)',
                }}
              >
                {keyRows.length === 0 ? (
                  <span style={{ color: 'var(--faint)', fontSize: 'var(--fs-caption)' }}>
                    {t('member.portal.noKeys')}
                  </span>
                ) : (
                  keyRows.map((k) => (
                    <div
                      key={k.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 'var(--s-2)',
                        justifyContent: 'space-between',
                      }}
                    >
                      <span
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}
                      >
                        <KeyIcon size={14} aria-hidden="true" />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {k.name ?? t('member.portal.unnamedKey')}
                        </span>
                        <code style={{ fontSize: 'var(--fs-caption)', color: 'var(--muted)' }}>
                          ····{k.last4}
                        </code>
                      </span>
                      <Pill tone={k.status === 'active' ? 'ok' : 'fail'}>
                        {t('status.' + k.status, k.status)}
                      </Pill>
                    </div>
                  ))
                )}
                <span style={{ color: 'var(--faint)', fontSize: 'var(--fs-caption)' }}>
                  {t('member.portal.keysNote')}
                </span>
              </div>
            </QueryBoundary>
          </div>

          {/* Recent usage */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
            <SectionHeader title={t('member.portal.usage')} />
            <DataTable
              columns={usageCols}
              rows={usageRows}
              rowKey={(r) => r.id}
              loading={usage.isLoading}
              error={usage.isError}
              onRetry={() => void usage.refetch()}
              empty={t('member.portal.noUsage')}
            />
          </div>
        </div>
      </div>
    </>
  );
}
