import { PencilSimpleIcon, TrashIcon } from '@phosphor-icons/react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { LoadMore } from '../../components/data/LoadMore';
import { SecretSelect } from '../../components/data/SecretSelect';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Drawer } from '../../components/ui/Drawer';
import { JsonField } from '../../components/ui/JsonField';
import { RowAction } from '../../components/ui/RowAction';
import { SectionHeader } from '../../components/ui/SectionHeader';
import { SelectField } from '../../components/ui/SelectField';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { Toggle } from '../../components/ui/Toggle';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { DifyBindingView, DifyImportView, DifyPricingModel } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';

export function DifyImportPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();

  const [tenantId, setTenantId] = useState('');
  const [resourceId, setResourceId] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [yaml, setYaml] = useState('');
  const [pricingModel, setPricingModel] = useState<DifyPricingModel>('fixed');
  const [serviceKeyRef, setServiceKeyRef] = useState('');
  const [allowBlockers, setAllowBlockers] = useState(false);
  const [report, setReport] = useState<DifyImportView | null>(null);
  const [editing, setEditing] = useState<DifyBindingView | null>(null);
  const [deleting, setDeleting] = useState<DifyBindingView | null>(null);

  const refreshBindings = () => qc.invalidateQueries({ queryKey: qk.difyBindings() });

  const submit = useMutation({
    mutationFn: () =>
      api.difyImport({
        tenantId,
        resourceId,
        yaml,
        endpoint,
        pricingModel,
        // Optional service-key binding (a stored secret) + allow blocked
        // workflows (the backend 422s a blocked import otherwise).
        serviceKeyRef: serviceKeyRef === '' ? undefined : serviceKeyRef,
        allowBlockers,
      }),
    onSuccess: async (r) => {
      setReport(r);
      toast(t('dify.imported'));
      await refreshBindings();
    },
    onError: mutationError(t),
  });

  const bindings = useInfiniteQuery({
    queryKey: qk.difyBindings(),
    queryFn: ({ pageParam }) => api.listDify({ cursor: pageParam, limit: 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = bindings.data?.pages.flatMap((p) => p.rows) ?? [];

  const del = useMutation({
    mutationFn: (resourceId_: string) => api.deleteDify(resourceId_),
    onSuccess: async () => {
      await refreshBindings();
      toast(t('dify.deleted'));
      setDeleting(null);
    },
    onError: mutationError(t),
  });

  const cols: Column<DifyBindingView>[] = [
    {
      key: 'resource',
      header: t('dify.cols.resource'),
      cell: (r) => <span className="mono">{r.resource_id}</span>,
    },
    { key: 'mode', header: t('dify.cols.mode'), cell: (r) => r.mode, width: '96px' },
    {
      key: 'endpoint',
      header: t('dify.cols.endpoint'),
      cell: (r) => (
        <span className="mono" style={{ color: 'var(--muted)' }}>
          {r.endpoint}
        </span>
      ),
    },
    {
      key: 'pricing',
      header: t('dify.cols.pricing'),
      cell: (r) => r.pricing_model,
      width: '96px',
    },
    {
      key: 'created',
      header: t('dify.cols.created'),
      cell: (r) => new Date(r.created_at).toLocaleDateString(),
      width: '110px',
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-5)' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)', maxWidth: 640 }}>
        <SectionHeader title={t('dify.title')} />
        <TextField label={t('dify.form.tenant')} value={tenantId} onChange={setTenantId} />
        <TextField label={t('dify.form.resourceId')} value={resourceId} onChange={setResourceId} />
        <TextField label={t('dify.form.endpoint')} value={endpoint} onChange={setEndpoint} />
        <JsonField label={t('dify.form.yaml')} value={yaml} onChange={(v) => setYaml(v)} placeholder="app: ..." />
        <SelectField
          label={t('dify.form.pricingModel')}
          value={pricingModel}
          onChange={(v) => setPricingModel(v as DifyPricingModel)}
          options={[
            { value: 'fixed', label: t('dify.pricing.fixed') },
            { value: 'matrix', label: t('dify.pricing.matrix') },
            { value: 'metered', label: t('dify.pricing.metered') },
          ]}
        />
        <SecretSelect
          label={t('dify.form.serviceKeyRef')}
          value={serviceKeyRef}
          onChange={setServiceKeyRef}
          placeholder={t('dify.form.serviceKeyNone')}
        />
        <Toggle
          label={t('dify.form.allowBlockers')}
          checked={allowBlockers}
          onChange={setAllowBlockers}
        />
        <div>
          <Button variant="cta" onClick={() => submit.mutate()} loading={submit.isPending}>
            {t('dify.submit')}
          </Button>
        </div>
        {report && (
          <div className="panel" style={{ borderRadius: 'var(--r-md)', padding: 'var(--s-4)' }}>
            <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginBottom: 6 }}>
              {t('dify.report')}
            </div>
            <pre className="mono" style={{ margin: 0, fontSize: 'var(--fs-sm)', whiteSpace: 'pre-wrap', color: 'var(--text)' }}>
              {JSON.stringify(report.compat_report, null, 2)}
            </pre>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
        <SectionHeader title={t('dify.bindings.title')} />
        <DataTable
          columns={cols}
          rows={rows}
          rowKey={(r) => r.resource_id}
          loading={bindings.isLoading}
          error={bindings.isError}
          onRetry={() => void bindings.refetch()}
          empty={t('dify.bindings.empty')}
          searchable
          actionsWidth="92px"
          rowActions={(r) => (
            <div style={{ display: 'flex', gap: 'var(--s-1)' }}>
              <RowAction icon={PencilSimpleIcon} label={t('common.edit')} onClick={() => setEditing(r)} />
              <RowAction icon={TrashIcon} label={t('common.delete')} danger onClick={() => setDeleting(r)} />
            </div>
          )}
        />
        <LoadMore
          hasNextPage={bindings.hasNextPage}
          isFetchingNextPage={bindings.isFetchingNextPage}
          onLoadMore={() => void bindings.fetchNextPage()}
        />
      </div>

      {editing !== null && (
        <DifyBindingEditor
          key={editing.resource_id}
          binding={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            void refreshBindings();
            setEditing(null);
          }}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        title={t('dify.delete.title')}
        message={t('dify.delete.message', { resource: deleting?.resource_id ?? '' })}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        danger
        loading={del.isPending}
        onConfirm={() => {
          if (deleting !== null) del.mutate(deleting.resource_id);
        }}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}

/** Edit one dify binding (endpoint / service key / pricing model). */
function DifyBindingEditor({
  binding,
  onClose,
  onSaved,
}: {
  binding: DifyBindingView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation('console');
  const api = useAdminApi();

  const [endpoint, setEndpoint] = useState(binding.endpoint);
  const [serviceKeyRef, setServiceKeyRef] = useState(binding.service_key_ref ?? '');
  const [pricingModel, setPricingModel] = useState(binding.pricing_model as DifyPricingModel);

  const save = useMutation({
    mutationFn: () =>
      api.updateDify(binding.resource_id, {
        endpoint: endpoint.trim() === '' ? undefined : endpoint.trim(),
        // '' clears the binding (null); a uuid sets it.
        serviceKeyRef: serviceKeyRef === '' ? null : serviceKeyRef,
        pricingModel,
      }),
    onSuccess: () => {
      toast(t('dify.updated'));
      onSaved();
    },
    onError: mutationError(t),
  });

  return (
    <Drawer
      open
      title={t('dify.editTitle')}
      onClose={onClose}
      footer={
        <Button variant="cta" onClick={() => save.mutate()} loading={save.isPending}>
          {t('common.save')}
        </Button>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
        <TextField label={t('dify.form.endpoint')} value={endpoint} onChange={setEndpoint} />
        <SecretSelect
          label={t('dify.form.serviceKeyRef')}
          value={serviceKeyRef}
          onChange={setServiceKeyRef}
          placeholder={t('dify.form.serviceKeyNone')}
        />
        <SelectField
          label={t('dify.form.pricingModel')}
          value={pricingModel}
          onChange={(v) => setPricingModel(v as DifyPricingModel)}
          options={[
            { value: 'fixed', label: t('dify.pricing.fixed') },
            { value: 'matrix', label: t('dify.pricing.matrix') },
            { value: 'metered', label: t('dify.pricing.metered') },
          ]}
        />
      </div>
    </Drawer>
  );
}
