import { TrashIcon, UserPlusIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSetConsoleAction } from '../../components/console/ConsoleChrome';
import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { StatusBadge, statusTone } from '../../components/data/StatusBadge';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Drawer } from '../../components/ui/Drawer';
import { Modal } from '../../components/ui/Modal';
import { RowAction } from '../../components/ui/RowAction';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { CreateSubjectBody, SubjectView } from '../../lib/api/types';
import { useConsoleApi } from '../../lib/api/useConsoleApi';
import { STALE_REFERENCE } from '../../lib/query';
import { AppSubjectDetailPanel } from './AppSubjectDetailPanel';
import { useTenantRole } from './useTenantRole';

/**
 * 端用户 (End-users / subjects) — the tenant-admin-only Part-A surface of the
 * end-user data plane. A `DataTable` of the tenant's own end-users, each
 * openable into a `Drawer` (mirroring the operator `SubjectDetailPanel`) that
 * binds a 额度套餐, manages the HARD sub-wallet (open / top-up / transfer with
 * the tenant pool), and mints subject-scoped API keys — all tenant-scoped via the
 * console plane (the token scopes the tenant; a cross-tenant id → 404).
 *
 * A member who deep-links here sees an admin-only note (the nav item is hidden);
 * the backend `TenantAdminGuard` 403s every write regardless — the gate here is
 * UX, never the security boundary.
 */
export function AppSubjects() {
  const { t } = useTranslation('console');
  const api = useConsoleApi();
  const qc = useQueryClient();
  const { isTenantAdmin, isLoading: roleLoading } = useTenantRole();

  const subjects = useQuery({
    queryKey: qk.consoleSubjects(),
    queryFn: () => api.listSubjects(),
    enabled: isTenantAdmin,
  });
  // 额度套餐 options for the per-subject plan-binding select (in the drawer).
  const plans = useQuery({
    queryKey: qk.consoleLimitPlans(),
    queryFn: () => api.listLimitPlans(),
    enabled: isTenantAdmin,
    staleTime: STALE_REFERENCE,
  });
  const planOptions = (plans.data ?? []).map((p) => ({ value: p.id, label: p.name }));

  const [formOpen, setFormOpen] = useState(false);
  const [externalId, setExternalId] = useState('');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SubjectView | undefined>(undefined);

  const invalidate = () => qc.invalidateQueries({ queryKey: qk.consoleSubjects() });
  const selected = (subjects.data ?? []).find((s) => s.id === selectedId);

  const create = useMutation({
    mutationFn: () => {
      const body: CreateSubjectBody = {};
      const ext = externalId.trim();
      const mail = email.trim();
      const name = displayName.trim();
      if (ext !== '') body.externalId = ext;
      if (mail !== '') body.email = mail;
      if (name !== '') body.displayName = name;
      return api.createSubject(body);
    },
    onSuccess: async () => {
      await invalidate();
      setFormOpen(false);
      setExternalId('');
      setEmail('');
      setDisplayName('');
    },
    onError: mutationError(t),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteSubject(id),
    onSuccess: async () => {
      await invalidate();
      toast(t('app.subjects.deleted'));
      setDeleteTarget(undefined);
      setSelectedId((cur) => (cur === deleteTarget?.id ? null : cur));
    },
    onError: mutationError(t),
  });

  useSetConsoleAction(
    () =>
      isTenantAdmin ? (
        <Button variant="ghost" onClick={() => setFormOpen(true)}>
          <UserPlusIcon size={14} weight="bold" /> {t('app.subjects.add')}
        </Button>
      ) : null,
    [t, isTenantAdmin],
  );

  // At least one identity is required (externalId OR email — schema-enforced).
  const canSubmit = externalId.trim() !== '' || /.+@.+\..+/.test(email.trim());

  const cols: Column<SubjectView>[] = [
    {
      key: 'name',
      header: t('app.subjects.cols.name'),
      grow: true,
      cell: (r) => r.display_name ?? <span className="muted">{t('app.subjects.unnamed')}</span>,
    },
    {
      key: 'identity',
      header: t('app.subjects.cols.identity'),
      cell: (r) => <span className="mono">{r.external_id ?? r.email ?? '—'}</span>,
      grow: true,
    },
    {
      key: 'status',
      header: t('app.subjects.cols.status'),
      noClip: true,
      cell: (r) => (
        <StatusBadge tone={statusTone(r.status)} label={t('status.' + r.status, r.status)} />
      ),
      width: '110px',
    },
    {
      key: 'created',
      header: t('app.subjects.cols.created'),
      cell: (r) => new Date(r.created_at).toLocaleDateString(),
      width: '120px',
    },
  ];

  if (!isTenantAdmin) {
    // Still resolving the seat: render nothing rather than flashing the admin-only
    // notice to an admin who hard-refreshes directly on this route.
    if (roleLoading) return null;
    return (
      <div
        role="note"
        style={{
          padding: 'var(--s-5)',
          textAlign: 'center',
          color: 'var(--muted)',
          fontSize: 'var(--fs-sm)',
        }}
      >
        {t('app.subjects.adminOnly')}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
      <DataTable
        columns={cols}
        rows={subjects.data ?? []}
        rowKey={(r) => r.id}
        loading={subjects.isLoading}
        error={subjects.isError}
        onRetry={() => void subjects.refetch()}
        empty={t('app.subjects.empty')}
        searchable
        pageSize={20}
        onRowClick={(r) => setSelectedId(r.id)}
        selectedKey={selectedId ?? undefined}
        actionsWidth="56px"
        rowActions={(r) => (
          <RowAction
            icon={TrashIcon}
            label={t('app.subjects.delete')}
            danger
            onClick={() => setDeleteTarget(r)}
          />
        )}
      />

      <Drawer
        open={selected !== undefined}
        title={
          selected?.display_name ?? selected?.external_id ?? selected?.email ?? t('app.subjects.title')
        }
        onClose={() => setSelectedId(null)}
      >
        {selected !== undefined && (
          <AppSubjectDetailPanel
            key={selected.id}
            subject={selected}
            planOptions={planOptions}
            onClose={() => setSelectedId(null)}
          />
        )}
      </Drawer>

      <Modal
        open={formOpen}
        title={t('app.subjects.add')}
        subtitle={t('app.subjects.addHint')}
        onClose={() => setFormOpen(false)}
        footer={
          <Button
            variant="cta"
            onClick={() => create.mutate()}
            loading={create.isPending}
            disabled={!canSubmit}
          >
            {t('app.subjects.create')}
          </Button>
        }
      >
        <TextField
          label={t('app.subjects.form.externalId')}
          hint={t('app.subjects.form.externalIdHint')}
          value={externalId}
          onChange={setExternalId}
          maxLength={256}
        />
        <TextField
          type="email"
          autoComplete="off"
          label={t('app.subjects.form.email')}
          hint={t('app.subjects.form.emailHint')}
          value={email}
          onChange={setEmail}
          maxLength={256}
        />
        <TextField
          label={t('app.subjects.form.displayName')}
          value={displayName}
          onChange={setDisplayName}
          maxLength={256}
        />
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== undefined}
        title={t('app.subjects.confirm.deleteTitle')}
        message={t('app.subjects.confirm.deleteMsg', {
          name:
            deleteTarget?.display_name ??
            deleteTarget?.external_id ??
            deleteTarget?.email ??
            deleteTarget?.id ??
            '',
        })}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        danger
        loading={remove.isPending}
        onConfirm={() => {
          if (deleteTarget !== undefined) remove.mutate(deleteTarget.id);
        }}
        onClose={() => setDeleteTarget(undefined)}
      />
    </div>
  );
}
