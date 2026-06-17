import { TrashIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { TenantSelect } from '../../components/data/TenantSelect';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Drawer } from '../../components/ui/Drawer';
import { RowAction } from '../../components/ui/RowAction';
import { toast } from '../../components/ui/toast';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { ModelGrantView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { STALE_REFERENCE } from '../../lib/query';

/**
 * Manage a model's tenant grants. Public models are open to all tenants — grants
 * only gate `tenant`-visibility models (noted in the header). Add a grant via
 * the tenant picker; revoke via a per-row confirm. Grants are idempotent on
 * `(model, tenant)` (a duplicate add is a no-op) and hard-deleted on revoke.
 */
export function ModelGrantsDrawer({
  name,
  open,
  onClose,
}: {
  name: string;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();

  const grants = useQuery({
    queryKey: qk.modelGrants(name),
    queryFn: () => api.listModelGrants(name),
    enabled: open && name !== '',
  });
  const tenants = useQuery({
    queryKey: qk.tenants(),
    queryFn: () => api.listTenants(),
    staleTime: STALE_REFERENCE,
  });
  const tenantName = (id: string) => tenants.data?.find((tn) => tn.id === id)?.name ?? id;

  const [tenantId, setTenantId] = useState('');
  const [revokeTarget, setRevokeTarget] = useState<ModelGrantView | undefined>(undefined);

  const grant = useMutation({
    mutationFn: () => api.grantModel(name, { tenantId }, crypto.randomUUID()),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.modelGrants(name) });
      toast(t('models.grant.granted'));
      setTenantId('');
    },
    onError: mutationError(t),
  });

  const revoke = useMutation({
    mutationFn: (g: ModelGrantView) => api.revokeModelGrant(name, g.tenant_id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.modelGrants(name) });
      toast(t('models.grant.revoked'));
      setRevokeTarget(undefined);
    },
    onError: mutationError(t),
  });

  const cols: Column<ModelGrantView>[] = [
    {
      key: 'tenant',
      header: t('models.grant.colTenant'),
      cell: (g) => (
        <span style={{ display: 'inline-flex', flexDirection: 'column', minWidth: 0 }}>
          <span style={{ fontWeight: 'var(--fw-medium)' }}>{tenantName(g.tenant_id)}</span>
          <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--muted)' }}>{g.tenant_id}</span>
        </span>
      ),
    },
    {
      key: 'created',
      header: t('models.grant.colGranted'),
      cell: (g) => new Date(g.created_at).toLocaleDateString(),
      width: '120px',
    },
  ];

  return (
    <Drawer open={open} title={t('models.grant.title', { name })} onClose={onClose}>
      <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--muted)', lineHeight: 1.5 }}>
        {t('models.grant.note')}
      </p>

      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--s-2)' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <TenantSelect
            label={t('models.grant.tenant')}
            value={tenantId}
            onChange={setTenantId}
            placeholder={t('models.grant.tenantPlaceholder')}
          />
        </div>
        <Button
          variant="cta"
          onClick={() => grant.mutate()}
          loading={grant.isPending}
          disabled={tenantId === ''}
        >
          {t('models.grant.submit')}
        </Button>
      </div>

      <DataTable
        columns={cols}
        rows={grants.data ?? []}
        rowKey={(g) => g.id}
        loading={grants.isLoading}
        empty={t('models.grant.empty')}
        actionsWidth="56px"
        rowActions={(g) => (
          <RowAction
            icon={TrashIcon}
            label={t('models.grant.revoke')}
            danger
            loading={revoke.isPending && revoke.variables.id === g.id}
            onClick={() => setRevokeTarget(g)}
          />
        )}
      />

      <ConfirmDialog
        open={revokeTarget !== undefined}
        title={t('models.confirm.revokeTitle')}
        message={t('models.confirm.revokeMsg', {
          tenant: revokeTarget ? tenantName(revokeTarget.tenant_id) : '',
        })}
        confirmLabel={t('models.grant.revoke')}
        cancelLabel={t('common.cancel')}
        danger
        loading={revoke.isPending}
        onConfirm={() => {
          if (revokeTarget) revoke.mutate(revokeTarget);
        }}
        onClose={() => setRevokeTarget(undefined)}
      />
    </Drawer>
  );
}
