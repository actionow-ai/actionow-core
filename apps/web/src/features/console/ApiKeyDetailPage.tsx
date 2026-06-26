import { ArrowLeftIcon, TrashIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { useSetConsoleBack } from '../../components/console/ConsoleChrome';
import { CopyField } from '../../components/data/CopyField';
import { ErrorState } from '../../components/data/ErrorState';
import { LimitUsageBars } from '../../components/data/LimitUsageBars';
import { StatusBadge, statusTone } from '../../components/data/StatusBadge';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { RoseLoader } from '../../components/ui/RoseLoader';
import { SelectField } from '../../components/ui/SelectField';
import { toast } from '../../components/ui/toast';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { ApiKeyView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { STALE_REFERENCE } from '../../lib/query';

/**
 * The routed API-key detail page (`/console/api-keys/:id`) — the full-page
 * successor to the former list `EntityCard`. The keys list is tenant-scoped, so
 * the owning tenant rides along as `?tenant=` (set by the directory row-click);
 * the key is resolved from that list by `:id`. Renders the copyable key id,
 * status, subject/rate/allowlist chips, the 路由组 + 额度套餐 binding selects
 * (bindGroup/bindPlan mutations live here), usage-vs-cap bars, and revoke.
 */
export function ApiKeyDetailPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const tenantId = params.get('tenant') ?? '';
  const { t } = useTranslation('console');
  const api = useAdminApi();

  useSetConsoleBack({ to: backTo(tenantId), label: t('apiKeys.title') });

  // The keys list is tenant-scoped (no get-by-id endpoint); resolve by :id.
  const keys = useQuery({
    queryKey: qk.apiKeys(tenantId),
    queryFn: () => api.listApiKeys(tenantId),
    enabled: tenantId !== '',
    staleTime: STALE_REFERENCE,
  });

  const key = (keys.data ?? []).find((k) => k.id === id);

  if (tenantId === '') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
        <BackLink to={backTo(tenantId)} label={t('apiKeys.detail.back')} />
        <NotFound message={t('apiKeys.detail.notFound')} />
      </div>
    );
  }
  if (keys.isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', padding: 'var(--s-6)' }}>
        <RoseLoader size={56} />
      </div>
    );
  }
  if (keys.isError) {
    return (
      <div style={{ padding: 'var(--s-5)' }}>
        <ErrorState onRetry={() => void keys.refetch()} />
      </div>
    );
  }
  if (key === undefined) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
        <BackLink to={backTo(tenantId)} label={t('apiKeys.detail.back')} />
        <NotFound message={t('apiKeys.detail.notFound')} />
      </div>
    );
  }

  return <ApiKeyDetailBody apiKey={key} tenantId={tenantId} />;
}

/** Build the back/detail-list target, preserving the tenant scope. */
function backTo(tenantId: string): string {
  return tenantId !== ''
    ? `/console/api-keys?tenant=${encodeURIComponent(tenantId)}`
    : '/console/api-keys';
}

/** The page's top-of-content back link (mirrors the TopBar back slot). */
function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--s-1)',
        fontSize: 'var(--fs-sm)',
        color: 'var(--muted)',
        textDecoration: 'none',
        width: 'fit-content',
      }}
    >
      <ArrowLeftIcon size={14} weight="bold" aria-hidden="true" />
      {label}
    </Link>
  );
}

function NotFound({ message }: { message: string }) {
  return (
    <div
      className="panel"
      style={{
        borderRadius: 'var(--r-md)',
        padding: 'var(--s-5)',
        color: 'var(--muted)',
        fontSize: 'var(--fs-sm)',
        textAlign: 'center',
      }}
    >
      {message}
    </div>
  );
}

/** One label / value row in the key detail header. */
function DetailRow({ label, children }: { label: string; children: ReactNode }) {
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
      <span style={{ fontSize: 'var(--fs-sm)' }}>{children}</span>
    </div>
  );
}

/**
 * The detail body — the former card content as a page. Identity (copyable id,
 * status, subject/rate/allowlist chips), the inline 路由组 + 额度套餐 binding
 * selects (writes invalidate the same tenant-scoped keys list the directory
 * reads), usage-vs-cap bars, and revoke (→ navigate back on success).
 */
function ApiKeyDetailBody({ apiKey, tenantId }: { apiKey: ApiKeyView; tenantId: string }) {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();
  const navigate = useNavigate();

  const [confirmRevoke, setConfirmRevoke] = useState(false);

  const groups = useQuery({
    queryKey: qk.routeGroups(),
    queryFn: () => api.listRouteGroups(),
    staleTime: STALE_REFERENCE,
  });
  const groupOptions = (groups.data ?? []).map((g) => ({ value: g.id, label: g.name }));

  const plans = useQuery({
    queryKey: qk.limitPlans(),
    queryFn: () => api.listLimitPlans(),
    staleTime: STALE_REFERENCE,
  });
  const planOptions = (plans.data ?? []).map((p) => ({ value: p.id, label: p.name }));

  const refreshKeys = () => qc.invalidateQueries({ queryKey: qk.apiKeys(tenantId) });

  const bindGroup = useMutation({
    // `null` unbinds the key back to the `default` group.
    mutationFn: (rg: string | null) => api.updateApiKeyGroup(apiKey.id, { routeGroupId: rg }),
    onSuccess: async () => {
      await refreshKeys();
    },
    onError: mutationError(t),
  });

  const bindPlan = useMutation({
    // `null` unbinds the key (back to unlimited).
    mutationFn: (pid: string | null) => api.setApiKeyLimitPlan(apiKey.id, pid),
    onSuccess: async () => {
      await refreshKeys();
    },
    onError: mutationError(t),
  });

  const revoke = useMutation({
    mutationFn: () => api.deleteApiKey(apiKey.id),
    onSuccess: async () => {
      await refreshKeys();
      toast(t('apiKeys.revoked'));
      setConfirmRevoke(false);
      void navigate(backTo(tenantId));
    },
    onError: mutationError(t),
  });

  const chips = [
    ...(apiKey.subject_id !== null
      ? [`${t('apiKeys.subject.chip')}: ${apiKey.subject_id.slice(0, 8)}`]
      : []),
    ...(apiKey.rate_limit !== null ? [`${String(apiKey.rate_limit)}/min`] : []),
    ...apiKey.resource_allowlist,
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
      <BackLink to={backTo(tenantId)} label={t('apiKeys.detail.back')} />
      <h1
        style={{
          fontSize: 'var(--fs-lg)',
          fontWeight: 'var(--fw-medium)',
          margin: 0,
          fontFamily: 'ui-monospace, Menlo, monospace',
          wordBreak: 'break-all',
        }}
      >
        {apiKey.id}
      </h1>

      <DetailRow label={t('apiKeys.cols.id')}>
        <CopyField
          value={apiKey.id}
          copyLabel={t('common.copy')}
          copiedLabel={t('common.copied')}
          failedLabel={t('common.copyFailed')}
        />
      </DetailRow>

      <DetailRow label={t('apiKeys.cols.status')}>
        <StatusBadge
          tone={statusTone(apiKey.status)}
          label={t('status.' + apiKey.status, apiKey.status)}
        />
      </DetailRow>

      {chips.length > 0 && (
        <DetailRow label={t('apiKeys.detail.attrs')}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s-2)' }}>
            {chips.map((c) => (
              <span key={c} className="chip">
                {c}
              </span>
            ))}
          </div>
        </DetailRow>
      )}

      {/* Routing + governance binding (the former inline card selects). */}
      <div
        className="panel"
        style={{
          borderRadius: 'var(--r-md)',
          padding: 'var(--s-4)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--s-4)',
          maxWidth: 360,
        }}
      >
        <SelectField
          label={t('apiKeys.group.label')}
          tooltip={t('apiKeys.group.tip')}
          value={apiKey.route_group_id ?? ''}
          onChange={(v) => bindGroup.mutate(v === '' ? null : v)}
          options={groupOptions}
          placeholder={t('apiKeys.group.default')}
        />
        <SelectField
          label={t('apiKeys.plan.label')}
          tooltip={t('apiKeys.plan.tip')}
          value={apiKey.limit_plan_id ?? ''}
          onChange={(v) => bindPlan.mutate(v === '' ? null : v)}
          options={planOptions}
          placeholder={t('apiKeys.plan.none')}
        />
      </div>

      {apiKey.limit_plan_id !== null && (
        <KeyLimitUsage keyId={apiKey.id} planId={apiKey.limit_plan_id} />
      )}

      <div>
        <Button variant="ghost" onClick={() => setConfirmRevoke(true)}>
          <TrashIcon size={14} weight="bold" aria-hidden="true" /> {t('apiKeys.revoke')}
        </Button>
      </div>

      <ConfirmDialog
        open={confirmRevoke}
        title={t('apiKeys.revokeConfirm.title')}
        message={t('apiKeys.revokeConfirm.msg', { id: apiKey.id })}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        danger
        loading={revoke.isPending}
        onConfirm={() => revoke.mutate()}
        onClose={() => setConfirmRevoke(false)}
      />
    </div>
  );
}

/** Usage-vs-cap bars for one key's bound plan (rolling-aware, fetched lazily). */
function KeyLimitUsage({ keyId, planId }: { keyId: string; planId: string }) {
  const api = useAdminApi();
  const { data } = useQuery({
    queryKey: qk.limitStatus('key', keyId),
    queryFn: () => api.listLimitStatus('key', keyId, planId),
    staleTime: 30_000,
  });
  return <LimitUsageBars rules={data ?? []} />;
}
