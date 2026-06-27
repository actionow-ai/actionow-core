import { GlobeIcon, PencilSimpleIcon, PlusIcon, TrashIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSetConsoleAction } from '../../components/console/ConsoleChrome';
import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { StatusBadge, statusTone } from '../../components/data/StatusBadge';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Drawer } from '../../components/ui/Drawer';
import { Pill } from '../../components/ui/Pill';
import { RowAction } from '../../components/ui/RowAction';
import { SelectField } from '../../components/ui/SelectField';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { ProxyView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';

/** Health pill from the nullable `healthy` verdict (null = never probed). */
function HealthPill({ p }: { p: ProxyView }) {
  const { t } = useTranslation('console');
  if (p.healthy === null) return <Pill tone="idle">{t('proxies.health.unknown')}</Pill>;
  if (p.healthy)
    return (
      <Pill tone="ok" dot>
        {p.last_latency_ms === null ? t('proxies.health.ok') : `${String(p.last_latency_ms)}ms`}
      </Pill>
    );
  return (
    <Pill tone="fail" dot title={p.last_error ?? undefined}>
      {t('proxies.health.fail')}
    </Pill>
  );
}

/**
 * The 代理 (managed egress proxies) console page — wired to `/admin/proxies`. A
 * `DataTable` of named proxies (scheme · host · status · health), a create/edit
 * `Drawer` (the URL is write-only — encrypted at rest, never shown back), a
 * per-row health PROBE, and delete. Bind a proxy to a channel from the channel
 * editor's proxy selector.
 */
export function ProxiesPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: qk.proxies(),
    queryFn: api.listProxies,
  });

  const [editId, setEditId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [delTarget, setDelTarget] = useState<ProxyView | undefined>(undefined);

  const del = useMutation({
    mutationFn: (row: ProxyView) => api.deleteProxy(row.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.proxies() });
      toast(t('proxies.deleted'));
      setDelTarget(undefined);
    },
    onError: mutationError(t),
  });

  const probe = useMutation({
    mutationFn: (row: ProxyView) => api.probeProxy(row.id),
    onSuccess: async (res) => {
      await qc.invalidateQueries({ queryKey: qk.proxies() });
      toast(res.healthy ? t('proxies.probeOk') : t('proxies.probeFail'));
    },
    onError: mutationError(t),
  });

  useSetConsoleAction(
    () => (
      <Button variant="ghost" onClick={() => setCreateOpen(true)}>
        <PlusIcon size={14} weight="bold" /> {t('proxies.new')}
      </Button>
    ),
    [t],
  );

  const cols: Column<ProxyView>[] = [
    {
      key: 'name',
      header: t('proxies.cols.name'),
      sortable: true,
      sortValue: (r) => r.name,
      cell: (r) => <strong>{r.name}</strong>,
      width: '200px',
    },
    {
      key: 'scheme',
      header: t('proxies.cols.scheme'),
      cell: (r) => <span className="mono">{r.scheme}</span>,
      width: '110px',
    },
    {
      key: 'host',
      header: t('proxies.cols.host'),
      grow: true,
      cell: (r) => <span className="mono">{r.host}</span>,
    },
    {
      key: 'status',
      header: t('proxies.cols.status'),
      noClip: true,
      cell: (r) => (
        <StatusBadge tone={statusTone(r.status)} label={t('status.' + r.status, r.status)} />
      ),
      width: '100px',
    },
    {
      key: 'health',
      header: t('proxies.cols.health'),
      noClip: true,
      cell: (r) => <HealthPill p={r} />,
      width: '120px',
    },
  ];

  return (
    // Matches the sibling list pages (Plugins): no own scroll/padding wrapper and
    // no in-page title — ConsoleLayout scrolls the view and the TopBar renders the
    // "代理" title + subtitle.
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
      <DataTable
        columns={cols}
        rows={data ?? []}
        rowKey={(r) => r.id}
        loading={isLoading}
        error={isError}
        onRetry={() => void refetch()}
        empty={t('proxies.empty')}
        searchable
        pageSize={20}
        actionsWidth="120px"
        rowActions={(r) => (
          <>
            <RowAction
              icon={GlobeIcon}
              label={t('proxies.probe')}
              onClick={() => probe.mutate(r)}
            />
            <RowAction
              icon={PencilSimpleIcon}
              label={t('common.edit')}
              onClick={() => setEditId(r.id)}
            />
            <RowAction
              icon={TrashIcon}
              label={t('common.delete')}
              danger
              onClick={() => setDelTarget(r)}
            />
          </>
        )}
      />

      {createOpen && <ProxyEditor open onClose={() => setCreateOpen(false)} />}
      {editId !== null && (
        <ProxyEditor
          key={editId}
          row={(data ?? []).find((p) => p.id === editId)}
          open
          onClose={() => setEditId(null)}
        />
      )}

      <ConfirmDialog
        open={delTarget !== undefined}
        title={t('proxies.confirm.deleteTitle')}
        message={t('proxies.confirm.deleteMsg', { name: delTarget?.name ?? '' })}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        danger
        loading={del.isPending}
        onConfirm={() => {
          if (delTarget) del.mutate(delTarget);
        }}
        onClose={() => setDelTarget(undefined)}
      />
    </div>
  );
}

type Status = 'active' | 'disabled';

/**
 * Create/edit `Drawer` for a managed proxy. `row === undefined` → create. The
 * URL is WRITE-ONLY (encrypted at rest, never returned) — on edit it shows a
 * placeholder and is only sent when re-entered. Create carries an Idempotency-Key.
 */
function ProxyEditor({
  row,
  open,
  onClose,
}: {
  row?: ProxyView;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();
  const editing = row !== undefined;

  const [name, setName] = useState(row?.name ?? '');
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState<Status>((row?.status as Status | undefined) ?? 'active');
  const [description, setDescription] = useState(row?.description ?? '');
  const [attempted, setAttempted] = useState(false);

  // Fresh idempotency key per create-intent — regenerated each open-for-create,
  // stable while open so a double-submit replays (dedupes). The editor stays
  // mounted across opens (reseeds via the effect below), so a plain useState
  // initializer would never refresh.
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID());
  useEffect(() => {
    if (open && !editing) setIdemKey(crypto.randomUUID());
  }, [open, editing]);

  useEffect(() => {
    if (row === undefined) return;
    setName(row.name);
    setStatus((row.status as Status | undefined) ?? 'active');
    setDescription(row.description ?? '');
  }, [row]);

  const nameMissing = name.trim() === '';
  const urlMissing = !editing && url.trim() === '';

  const save = useMutation({
    mutationFn: () => {
      if (editing) {
        return api.updateProxy(row.id, {
          name: name.trim(),
          status,
          description: description.trim() === '' ? null : description.trim(),
          ...(url.trim() === '' ? {} : { url: url.trim() }), // only re-encrypt when re-entered
        });
      }
      return api.createProxy(
        {
          name: name.trim(),
          url: url.trim(),
          status,
          description: description.trim() === '' ? undefined : description.trim(),
        },
        idemKey,
      );
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.proxies() });
      toast(t(editing ? 'proxies.updated' : 'proxies.created'));
      onClose();
    },
    onError: mutationError(t),
  });

  const onSave = () => {
    setAttempted(true);
    if (!nameMissing && !urlMissing) save.mutate();
  };

  return (
    <Drawer
      open={open}
      title={t(editing ? 'proxies.editTitle' : 'proxies.new')}
      onClose={onClose}
      footer={
        <Button variant="cta" onClick={onSave} loading={save.isPending}>
          {t('proxies.save')}
        </Button>
      }
    >
      <TextField
        label={t('proxies.form.name')}
        value={name}
        onChange={setName}
        required
        error={attempted && nameMissing ? t('proxies.form.nameRequired') : undefined}
      />
      <TextField
        label={t('proxies.form.url')}
        tooltip={t('proxies.tip.url')}
        hint={editing ? t('proxies.tip.urlEdit') : t('proxies.tip.urlNew')}
        value={url}
        onChange={setUrl}
        type="password"
        placeholder={editing ? t('proxies.form.urlKeepPlaceholder') : 'http://user:pass@host:port'}
        error={attempted && urlMissing ? t('proxies.form.urlRequired') : undefined}
      />
      <SelectField
        label={t('proxies.form.status')}
        value={status}
        onChange={(v) => setStatus(v as Status)}
        options={[
          { value: 'active', label: t('status.active') },
          { value: 'disabled', label: t('status.disabled') },
        ]}
      />
      <TextField
        label={t('proxies.form.description')}
        value={description}
        onChange={setDescription}
      />
    </Drawer>
  );
}
