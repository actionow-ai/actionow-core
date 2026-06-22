import { PencilSimpleIcon, PlusIcon, TrashIcon } from '@phosphor-icons/react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSetConsoleAction } from '../../components/console/ConsoleChrome';
import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { LoadMore } from '../../components/data/LoadMore';
import { SecretSelect } from '../../components/data/SecretSelect';
import { TenantSelect } from '../../components/data/TenantSelect';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Drawer } from '../../components/ui/Drawer';
import { JsonField } from '../../components/ui/JsonField';
import { Modal } from '../../components/ui/Modal';
import { RowAction } from '../../components/ui/RowAction';
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

  const [open, setOpen] = useState(false);
  const [tenantId, setTenantId] = useState('');
  const [resourceId, setResourceId] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [yaml, setYaml] = useState('');
  const [pricingModel, setPricingModel] = useState<DifyPricingModel>('fixed');
  const [serviceKeyRef, setServiceKeyRef] = useState('');
  const [allowBlockers, setAllowBlockers] = useState(false);
  const [report, setReport] = useState<DifyImportView | null>(null);
  // Set true on a submit attempt so required-field errors appear only after a
  // try, not on first paint of an empty form.
  const [attempted, setAttempted] = useState(false);
  const [editing, setEditing] = useState<DifyBindingView | null>(null);
  const [deleting, setDeleting] = useState<DifyBindingView | null>(null);

  // Open the import modal on a clean slate (a re-import shouldn't inherit the
  // previous run's form or compat report).
  const openCreate = () => {
    setTenantId('');
    setResourceId('');
    setEndpoint('');
    setYaml('');
    setPricingModel('fixed');
    setServiceKeyRef('');
    setAllowBlockers(false);
    setReport(null);
    setAttempted(false);
    setOpen(true);
  };

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
      // Keep the modal open and surface the compat report inline — the operator
      // reads it, then closes manually.
      setReport(r);
      toast(t('dify.imported'));
      await refreshBindings();
    },
    onError: mutationError(t),
  });

  // Required: a tenant to bill, a resource id to mount under, and the YAML to import.
  const tenantMissing = tenantId === '';
  const resourceMissing = resourceId.trim() === '';
  const yamlMissing = yaml.trim() === '';
  const canSubmit = !tenantMissing && !resourceMissing && !yamlMissing;
  const onSubmit = () => {
    setAttempted(true);
    if (canSubmit) submit.mutate();
  };

  useSetConsoleAction(
    () => (
      <Button variant="ghost" onClick={openCreate}>
        <PlusIcon size={14} weight="bold" /> {t('dify.new')}
      </Button>
    ),
    [t],
  );

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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
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
          <>
            <RowAction icon={PencilSimpleIcon} label={t('common.edit')} onClick={() => setEditing(r)} />
            <RowAction icon={TrashIcon} label={t('common.delete')} danger onClick={() => setDeleting(r)} />
          </>
        )}
      />
      <LoadMore
        hasNextPage={bindings.hasNextPage}
        isFetchingNextPage={bindings.isFetchingNextPage}
        onLoadMore={() => void bindings.fetchNextPage()}
      />

      <Modal
        open={open}
        title={t('dify.title')}
        onClose={() => setOpen(false)}
        footer={
          <Button variant="cta" onClick={onSubmit} loading={submit.isPending}>
            {t('dify.submit')}
          </Button>
        }
      >
        <TenantSelect
          label={t('dify.form.tenant')}
          value={tenantId}
          onChange={setTenantId}
          error={attempted && tenantMissing ? t('dify.form.tenantRequired') : undefined}
        />
        <TextField
          label={t('dify.form.resourceId')}
          value={resourceId}
          onChange={setResourceId}
          required
          error={attempted && resourceMissing ? t('dify.form.resourceRequired') : undefined}
        />
        <TextField label={t('dify.form.endpoint')} value={endpoint} onChange={setEndpoint} />
        <JsonField
          label={t('dify.form.yaml')}
          value={yaml}
          onChange={(v) => setYaml(v)}
          placeholder="app: ..."
          error={attempted && yamlMissing ? t('dify.form.yamlRequired') : undefined}
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
        {report && (
          <div className="panel" style={{ borderRadius: 'var(--r-md)', padding: 'var(--s-4)' }}>
            <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginBottom: 6 }}>
              {t('dify.report')}
            </div>
            <pre
              className="mono"
              style={{
                margin: 0,
                fontSize: 'var(--fs-sm)',
                whiteSpace: 'pre-wrap',
                color: 'var(--text)',
              }}
            >
              {JSON.stringify(report.compat_report, null, 2)}
            </pre>
          </div>
        )}
      </Modal>

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
