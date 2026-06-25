import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckCircleIcon,
  ProhibitIcon,
  UserPlusIcon,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSetConsoleAction } from '../../components/console/ConsoleChrome';
import { CopyField } from '../../components/data/CopyField';
import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { StatusBadge, statusTone } from '../../components/data/StatusBadge';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Modal } from '../../components/ui/Modal';
import { Pill } from '../../components/ui/Pill';
import { RowAction } from '../../components/ui/RowAction';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { ConsoleUserView } from '../../lib/api/types';
import { useConsoleApi } from '../../lib/api/useConsoleApi';
import { useTenantRole } from './useTenantRole';

/** A tenant-org seat (`tenant_role`) → a labelled pill (admin highlighted). */
function RolePill({ role }: { role: string }) {
  const { t } = useTranslation('console');
  return (
    <Pill tone={role === 'admin' ? 'ok' : 'idle'}>
      {t(`app.members.roles.${role}`, role)}
    </Pill>
  );
}

/**
 * 成员管理 (Members) — the tenant-admin-only operator-team surface (RBAC v1). A
 * `DataTable` of the tenant's operator seats (a sub-user is a normal USER row,
 * `role='user'`, never an end-user `subject`): email, role, status, created. The
 * admin can invite a sub-user (email + initial password, shown once via
 * `CopyField`), promote/demote (`tenant_role`), and disable/re-enable (`status`).
 *
 * A member who reaches this route sees an admin-only empty state (the nav item is
 * hidden for them); the backend `TenantAdminGuard` 403s every write regardless —
 * the gate here is UX, never the security boundary.
 */
export function MembersPage() {
  const { t } = useTranslation('console');
  const api = useConsoleApi();
  const qc = useQueryClient();
  const { isTenantAdmin } = useTenantRole();

  const users = useQuery({
    queryKey: qk.consoleUsers(),
    queryFn: () => api.listUsers(),
    enabled: isTenantAdmin,
  });

  const [formOpen, setFormOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null);
  const [disableTarget, setDisableTarget] = useState<ConsoleUserView | undefined>(undefined);

  const invalidate = () => qc.invalidateQueries({ queryKey: qk.consoleUsers() });

  const create = useMutation({
    mutationFn: () => api.createUser({ email: email.trim(), password }),
    onSuccess: async (r) => {
      await invalidate();
      setFormOpen(false);
      // Reveal the one-time credential pair so the admin can hand it off — the
      // server never echoes the password again.
      setCreated({ email: r.email, password });
      setEmail('');
      setPassword('');
    },
    onError: mutationError(t),
  });

  const setRole = useMutation({
    mutationFn: ({ id, tenantRole }: { id: string; tenantRole: 'admin' | 'member' }) =>
      api.updateUser(id, { tenantRole }),
    onSuccess: async () => {
      await invalidate();
      toast(t('app.members.roleChanged'));
    },
    onError: mutationError(t),
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'active' | 'disabled' }) =>
      api.updateUser(id, { status }),
    onSuccess: async (_r, vars) => {
      await invalidate();
      toast(t(vars.status === 'disabled' ? 'app.members.disabled' : 'app.members.enabled'));
      setDisableTarget(undefined);
    },
    onError: mutationError(t),
  });

  useSetConsoleAction(
    () =>
      isTenantAdmin ? (
        <Button variant="ghost" onClick={() => setFormOpen(true)}>
          <UserPlusIcon size={14} weight="bold" /> {t('app.members.invite')}
        </Button>
      ) : null,
    [t, isTenantAdmin],
  );

  const emailValid = /.+@.+\..+/.test(email.trim());
  const canSubmit = emailValid && password.length >= 8;

  const cols: Column<ConsoleUserView>[] = [
    {
      key: 'email',
      header: t('app.members.cols.email'),
      grow: true,
      cell: (r) => <span className="mono">{r.email}</span>,
    },
    {
      key: 'role',
      header: t('app.members.cols.role'),
      noClip: true,
      cell: (r) => <RolePill role={r.tenant_role} />,
      width: '120px',
    },
    {
      key: 'status',
      header: t('app.members.cols.status'),
      noClip: true,
      cell: (r) => <StatusBadge tone={statusTone(r.status)} label={t('status.' + r.status, r.status)} />,
      width: '110px',
    },
    {
      key: 'created',
      header: t('app.members.cols.created'),
      cell: (r) => new Date(r.created_at).toLocaleDateString(),
      width: '120px',
    },
  ];

  if (!isTenantAdmin) {
    // A member who deep-links here: no list, no controls — just the admin-only
    // notice (matching the read-only gate on the other /app surfaces).
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
        {t('app.members.adminOnly')}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
      <DataTable
        columns={cols}
        rows={users.data ?? []}
        rowKey={(r) => r.id}
        loading={users.isLoading}
        error={users.isError}
        onRetry={() => void users.refetch()}
        empty={t('app.members.empty')}
        searchable
        pageSize={20}
        actionsWidth="96px"
        rowActions={(r) =>
          r.tenant_role === 'admin' ? (
            <RowAction
              icon={ArrowDownIcon}
              label={t('app.members.demote')}
              onClick={() => setRole.mutate({ id: r.id, tenantRole: 'member' })}
              loading={setRole.isPending && setRole.variables.id === r.id}
            />
          ) : (
            <>
              <RowAction
                icon={ArrowUpIcon}
                label={t('app.members.promote')}
                onClick={() => setRole.mutate({ id: r.id, tenantRole: 'admin' })}
                loading={setRole.isPending && setRole.variables.id === r.id}
              />
              {r.status === 'disabled' ? (
                <RowAction
                  icon={CheckCircleIcon}
                  label={t('app.members.enable')}
                  onClick={() => setStatus.mutate({ id: r.id, status: 'active' })}
                  loading={setStatus.isPending && setStatus.variables.id === r.id}
                />
              ) : (
                <RowAction
                  icon={ProhibitIcon}
                  label={t('app.members.disable')}
                  danger
                  onClick={() => setDisableTarget(r)}
                />
              )}
            </>
          )
        }
      />

      <Modal
        open={formOpen}
        title={t('app.members.invite')}
        subtitle={t('app.members.inviteHint')}
        onClose={() => setFormOpen(false)}
        footer={
          <Button
            variant="cta"
            onClick={() => create.mutate()}
            loading={create.isPending}
            disabled={!canSubmit}
          >
            {t('app.members.create')}
          </Button>
        }
      >
        <TextField
          type="email"
          autoComplete="off"
          label={t('app.members.form.email')}
          value={email}
          onChange={setEmail}
          required
          maxLength={256}
        />
        <TextField
          type="password"
          autoComplete="new-password"
          label={t('app.members.form.password')}
          value={password}
          onChange={setPassword}
          minLength={8}
          maxLength={256}
          hint={t('auth.passwordPolicy')}
        />
      </Modal>

      <Modal
        open={created !== null}
        title={t('app.members.created.title')}
        onClose={() => setCreated(null)}
        footer={
          <Button variant="cta" onClick={() => setCreated(null)}>
            {t('app.members.created.done')}
          </Button>
        }
      >
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--run)' }}>
          {t('app.members.created.warn')}
        </div>
        {created !== null && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
            <CopyField
              value={created.email}
              copyLabel={t('app.members.created.copyEmail')}
              copiedLabel={t('common.copied')}
            />
            <CopyField
              value={created.password}
              copyLabel={t('app.members.created.copyPassword')}
              copiedLabel={t('common.copied')}
            />
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={disableTarget !== undefined}
        title={t('app.members.confirm.disableTitle')}
        message={t('app.members.confirm.disableMsg', { email: disableTarget?.email ?? '' })}
        confirmLabel={t('app.members.disable')}
        cancelLabel={t('common.cancel')}
        danger
        loading={setStatus.isPending}
        onConfirm={() => {
          if (disableTarget !== undefined)
            setStatus.mutate({ id: disableTarget.id, status: 'disabled' });
        }}
        onClose={() => setDisableTarget(undefined)}
      />
    </div>
  );
}
