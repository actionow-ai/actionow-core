import { PlusIcon, ProhibitIcon } from '@phosphor-icons/react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { useSetConsoleAction, useSetConsoleFilters } from '../../components/console/ConsoleChrome';
import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { StatusBadge, statusTone } from '../../components/data/StatusBadge';
import { TenantSelect } from '../../components/data/TenantSelect';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Modal } from '../../components/ui/Modal';
import { NumberField } from '../../components/ui/NumberField';
import { RowAction } from '../../components/ui/RowAction';
import { SecretRevealModal } from '../../components/ui/SecretRevealModal';
import { SelectField } from '../../components/ui/SelectField';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { ApiKeyView, CreateApiKeyBody } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { STALE_REFERENCE } from '../../lib/query';
import { useUrlState } from '../../lib/useUrlState';

/**
 * The API-key directory (`/console/api-keys`): a tenant-scoped `DataTable` of
 * keys — id, end-user (subject), bound route group + limit plan (resolved by
 * name from the reference lists), status, created. Row-click navigates to the
 * routed `/console/api-keys/:id?tenant=…` detail page (where the per-key
 * routing/governance binding + usage + revoke live). The tenant-select gate
 * stays in the filter slot; the 签发 Key action stays in the action slot.
 */
export function ApiKeysPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();
  const navigate = useNavigate();

  const [tenantId, setTenantId] = useUrlState('tenant');
  const keys = useQuery({
    queryKey: qk.apiKeys(tenantId),
    queryFn: () => api.listApiKeys(tenantId),
    enabled: tenantId !== '',
    placeholderData: keepPreviousData,
  });
  // Route groups drive the per-key billing/routing binding (and the create picker).
  const groups = useQuery({
    queryKey: qk.routeGroups(),
    queryFn: () => api.listRouteGroups(),
    staleTime: STALE_REFERENCE,
  });
  const groupOptions = (groups.data ?? []).map((g) => ({ value: g.id, label: g.name }));
  const groupName = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of groups.data ?? []) m.set(g.id, g.name);
    return m;
  }, [groups.data]);
  // Limit plans drive the per-key governance binding (额度套餐).
  const plans = useQuery({
    queryKey: qk.limitPlans(),
    queryFn: () => api.listLimitPlans(),
    staleTime: STALE_REFERENCE,
  });
  const planName = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of plans.data ?? []) m.set(p.id, p.name);
    return m;
  }, [plans.data]);
  // Subjects (end-users) of the selected tenant — optional scope for a minted key.
  const subjects = useQuery({
    queryKey: qk.subjects(tenantId),
    queryFn: () => api.listSubjects(tenantId),
    enabled: tenantId !== '',
    staleTime: STALE_REFERENCE,
  });
  const subjectOptions = (subjects.data ?? []).map((s) => ({
    value: s.id,
    label: s.display_name ?? s.external_id ?? s.email ?? s.id.slice(0, 8),
  }));

  const [formOpen, setFormOpen] = useState(false);
  const [allowlist, setAllowlist] = useState('');
  const [rateLimit, setRateLimit] = useState(0);
  const [routeGroupId, setRouteGroupId] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyView | undefined>(undefined);

  const create = useMutation({
    mutationFn: () => {
      const body: CreateApiKeyBody = { tenantId };
      const allow = allowlist
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (allow.length) body.resourceAllowlist = allow;
      if (rateLimit > 0) body.rateLimit = rateLimit;
      // Empty = leave on the `default` group (the schema rejects an empty string).
      if (routeGroupId !== '') body.routeGroupId = routeGroupId;
      // Empty = a tenant-level key (no end-user scope).
      if (subjectId !== '') body.subjectId = subjectId;
      return api.createApiKey(body);
    },
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: qk.apiKeys(tenantId) });
      setFormOpen(false);
      setAllowlist('');
      setRateLimit(0);
      setRouteGroupId('');
      setSubjectId('');
      setPlaintext(r.plaintext);
    },
    onError: mutationError(t),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.deleteApiKey(id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.apiKeys(tenantId) });
      toast(t('apiKeys.revoked'));
      setRevokeTarget(undefined);
    },
    onError: mutationError(t),
  });

  useSetConsoleAction(
    () => (
      <Button variant="ghost" onClick={() => setFormOpen(true)}>
        <PlusIcon size={14} weight="bold" /> {t('apiKeys.new')}
      </Button>
    ),
    [t],
  );

  useSetConsoleFilters(
    () => (
      <div style={{ width: 200 }}>
        <TenantSelect
          value={tenantId}
          onChange={setTenantId}
          placeholder={t('apiKeys.form.tenant')}
        />
      </div>
    ),
    [t, tenantId, setTenantId],
  );

  const cols: Column<ApiKeyView>[] = [
    {
      key: 'id',
      header: t('apiKeys.cols.id'),
      grow: true,
      noClip: true,
      cell: (r) => <code style={{ fontSize: 'var(--fs-sm)' }}>{r.id}</code>,
    },
    {
      key: 'subject',
      header: t('apiKeys.subject.label'),
      width: '140px',
      cell: (r) =>
        r.subject_id !== null ? (
          <span className="mono" style={{ fontSize: 'var(--fs-caption)' }} title={r.subject_id}>
            {r.subject_id.slice(0, 8)}
          </span>
        ) : (
          <span style={{ color: 'var(--faint)' }}>—</span>
        ),
    },
    {
      key: 'group',
      header: t('apiKeys.group.label'),
      width: '160px',
      cell: (r) =>
        r.route_group_id !== null
          ? (groupName.get(r.route_group_id) ?? r.route_group_id)
          : t('apiKeys.group.default'),
    },
    {
      key: 'plan',
      header: t('apiKeys.plan.label'),
      width: '160px',
      cell: (r) =>
        r.limit_plan_id !== null
          ? (planName.get(r.limit_plan_id) ?? r.limit_plan_id)
          : t('apiKeys.plan.none'),
    },
    {
      key: 'status',
      header: t('apiKeys.cols.status'),
      noClip: true,
      width: '120px',
      cell: (r) => (
        <StatusBadge tone={statusTone(r.status)} label={t('status.' + r.status, r.status)} />
      ),
    },
    {
      key: 'created',
      header: t('apiKeys.cols.created'),
      align: 'right',
      width: '140px',
      cell: (r) => new Date(r.created_at).toLocaleDateString(),
    },
  ];

  return (
    <div style={{ height: '100%' }}>
      <DataTable
        columns={cols}
        rows={tenantId === '' ? [] : (keys.data ?? [])}
        rowKey={(r) => r.id}
        loading={tenantId !== '' && keys.isLoading}
        error={tenantId !== '' && keys.isError}
        onRetry={() => void keys.refetch()}
        empty={t('apiKeys.empty')}
        onRowClick={(r) => {
          void navigate(`/console/api-keys/${r.id}?tenant=${encodeURIComponent(tenantId)}`);
        }}
        actionsWidth="56px"
        rowActions={(r) => (
          <RowAction
            icon={ProhibitIcon}
            label={t('apiKeys.revoke')}
            danger
            onClick={() => setRevokeTarget(r)}
          />
        )}
      />

      <Modal
        open={formOpen}
        title={t('apiKeys.new')}
        onClose={() => setFormOpen(false)}
        footer={
          <Button variant="cta" onClick={() => create.mutate()} loading={create.isPending}>
            {t('apiKeys.submit')}
          </Button>
        }
      >
        <TextField label={t('apiKeys.form.allowlist')} value={allowlist} onChange={setAllowlist} />
        <NumberField
          label={t('apiKeys.form.rateLimit')}
          value={rateLimit}
          onChange={setRateLimit}
          min={1}
        />
        <SelectField
          label={t('apiKeys.group.label')}
          tooltip={t('apiKeys.group.tip')}
          value={routeGroupId}
          onChange={setRouteGroupId}
          options={groupOptions}
          placeholder={t('apiKeys.group.default')}
        />
        <SelectField
          label={t('apiKeys.subject.label')}
          tooltip={t('apiKeys.subject.tip')}
          value={subjectId}
          onChange={setSubjectId}
          options={subjectOptions}
          placeholder={t('apiKeys.subject.none')}
        />
      </Modal>

      <SecretRevealModal
        open={plaintext !== null}
        title={t('apiKeys.reveal.title')}
        onClose={() => setPlaintext(null)}
        value={plaintext ?? ''}
        warn={t('apiKeys.reveal.warn')}
        copyLabel={t('apiKeys.reveal.copy')}
        copiedLabel={t('apiKeys.reveal.copied')}
        doneLabel={t('apiKeys.reveal.done')}
      />

      <ConfirmDialog
        open={revokeTarget !== undefined}
        title={t('apiKeys.revokeConfirm.title')}
        message={t('apiKeys.revokeConfirm.msg', { id: revokeTarget?.id ?? '' })}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        danger
        loading={revoke.isPending}
        onConfirm={() => {
          if (revokeTarget) revoke.mutate(revokeTarget.id);
        }}
        onClose={() => setRevokeTarget(undefined)}
      />
    </div>
  );
}
