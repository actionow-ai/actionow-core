import { KeyIcon, PlusIcon, TrashIcon } from '@phosphor-icons/react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSetConsoleAction, useSetConsoleFilters } from '../../components/console/ConsoleChrome';
import { CardCollection } from '../../components/data/CardCollection';
import { CopyField } from '../../components/data/CopyField';
import { EntityCard } from '../../components/data/EntityCard';
import { StatusBadge, statusTone } from '../../components/data/StatusBadge';
import { TenantSelect } from '../../components/data/TenantSelect';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Modal } from '../../components/ui/Modal';
import { NumberField } from '../../components/ui/NumberField';
import { SelectField } from '../../components/ui/SelectField';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { ApiKeyView, CreateApiKeyBody } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { STALE_REFERENCE } from '../../lib/query';
import { useUrlState } from '../../lib/useUrlState';

export function ApiKeysPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();

  const [tenantId, setTenantId] = useUrlState('tenant');
  const { data, isLoading } = useQuery({
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

  const [formOpen, setFormOpen] = useState(false);
  const [allowlist, setAllowlist] = useState('');
  const [rateLimit, setRateLimit] = useState(0);
  const [routeGroupId, setRouteGroupId] = useState('');
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
      return api.createApiKey(body);
    },
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: qk.apiKeys(tenantId) });
      setFormOpen(false);
      setAllowlist('');
      setRateLimit(0);
      setRouteGroupId('');
      setPlaintext(r.plaintext);
    },
    onError: mutationError(t),
  });

  const bindGroup = useMutation({
    // `null` unbinds the key back to the `default` group.
    mutationFn: ({ id, routeGroupId: rg }: { id: string; routeGroupId: string | null }) =>
      api.updateApiKeyGroup(id, { routeGroupId: rg }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.apiKeys(tenantId) });
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
        <TenantSelect value={tenantId} onChange={setTenantId} placeholder={t('apiKeys.form.tenant')} />
      </div>
    ),
    [t, tenantId, setTenantId],
  );

  return (
    <div style={{ height: '100%' }}>
      <CardCollection
        rows={tenantId === '' ? [] : (data ?? [])}
        loading={tenantId !== '' && isLoading}
        empty={t('apiKeys.empty')}
        renderCard={(r) => (
          <EntityCard
            key={r.id}
            icon={KeyIcon}
            title={<code style={{ fontSize: 'var(--fs-sm)' }}>{r.id}</code>}
            badge={<StatusBadge tone={statusTone(r.status)} label={t('status.' + r.status, r.status)} />}
            chips={[
              ...(r.rate_limit !== null ? [`${String(r.rate_limit)}/min`] : []),
              ...(r.resource_allowlist.length > 0 ? r.resource_allowlist : []),
            ]}
            meta={[{ label: t('apiKeys.cols.created'), value: new Date(r.created_at).toLocaleDateString() }]}
            actions={
              <>
                <div style={{ width: 200 }}>
                  <SelectField
                    label={t('apiKeys.group.label')}
                    tooltip={t('apiKeys.group.tip')}
                    value={r.route_group_id ?? ''}
                    onChange={(v) => bindGroup.mutate({ id: r.id, routeGroupId: v === '' ? null : v })}
                    options={groupOptions}
                    placeholder={t('apiKeys.group.default')}
                  />
                </div>
                <Button variant="ghost" onClick={() => setRevokeTarget(r)}>
                  <TrashIcon size={14} weight="bold" aria-hidden="true" /> {t('apiKeys.revoke')}
                </Button>
              </>
            }
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
        <NumberField label={t('apiKeys.form.rateLimit')} value={rateLimit} onChange={setRateLimit} min={1} />
        <SelectField
          label={t('apiKeys.group.label')}
          tooltip={t('apiKeys.group.tip')}
          value={routeGroupId}
          onChange={setRouteGroupId}
          options={groupOptions}
          placeholder={t('apiKeys.group.default')}
        />
      </Modal>

      <Modal
        open={plaintext !== null}
        title={t('apiKeys.reveal.title')}
        onClose={() => setPlaintext(null)}
        footer={
          <Button variant="cta" onClick={() => setPlaintext(null)}>
            {t('apiKeys.reveal.done')}
          </Button>
        }
      >
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--run)' }}>{t('apiKeys.reveal.warn')}</div>
        {plaintext !== null && <CopyField value={plaintext} copyLabel={t('apiKeys.reveal.copy')} copiedLabel={t('apiKeys.reveal.copied')} />}
      </Modal>

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
