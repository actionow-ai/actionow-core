import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, UserPlus, Users, UserX } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { apiFetch, toApiStateError } from '@/api/client';
import { useCursorQuery } from '@/api/hooks';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { DateTimeText } from '@/components/common/date-time-text';
import { FormField } from '@/components/common/form-field';
import { LoadMore } from '@/components/common/load-more';
import { ApiErrorNotice, ResourceLoading } from '@/components/shell/api-state';
import { EmptyState, PageHeader, PageTransition } from '@/components/shell/page';
import { Button } from '@/components/ui/components/buttons/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/components/radix/dialog';
import {
  Badge,
  Card,
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
  DataTableToolbar,
} from '@/components/ui/data-display';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

// Mirrors `consoleUserViewSchema` (packages/contracts/src/console-views.ts).
interface TeamUserRow {
  id: string;
  email: string;
  status: string;
  tenant_role: string;
  created_at: string;
}

const roleVariant: Record<string, 'primary' | 'neutral'> = {
  admin: 'primary',
  member: 'neutral',
};

const USERS_KEY = ['console', 'users'] as const;

function RoleBadge({ role }: { role: string }) {
  const { t } = useTranslation();
  const label =
    role === 'admin'
      ? t('tenantUsers.roleAdmin')
      : role === 'member'
        ? t('tenantUsers.roleMember')
        : role;
  return <Badge variant={roleVariant[role] ?? 'neutral'}>{label}</Badge>;
}

function MutationErrorText({ error }: { error: unknown }) {
  return <p className="text-sm text-danger">{toApiStateError(error).message}</p>;
}

function InviteMemberDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const invite = useMutation({
    mutationFn: (body: { email: string; password: string }) =>
      apiFetch<{ id: string; email: string }>('/console/users', { method: 'POST', body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: USERS_KEY });
      onClose();
    },
  });

  const canSubmit = /\S+@\S+\.\S+/.test(email.trim()) && password.length >= 8;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('tenantUsers.inviteTitle')}</DialogTitle>
          <DialogDescription>{t('tenantUsers.inviteDescription')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <FormField label={t('tenantUsers.colEmail')}>
            {(id) => (
              <Input
                id={id}
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            )}
          </FormField>
          <FormField label={t('tenantUsers.passwordLabel')} hint={t('tenantUsers.passwordHint')}>
            {(id) => (
              <Input
                id={id}
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            )}
          </FormField>
        </div>
        {invite.isError ? <MutationErrorText error={invite.error} /> : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={invite.isPending}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={() => invite.mutate({ email: email.trim(), password })}
            disabled={!canSubmit || invite.isPending}
          >
            {t('tenantUsers.inviteMember')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditMemberDialog({ user, onClose }: { user: TeamUserRow; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [tenantRole, setTenantRole] = useState(user.tenant_role === 'admin' ? 'admin' : 'member');
  const [status, setStatus] = useState(user.status === 'disabled' ? 'disabled' : 'active');

  const update = useMutation({
    mutationFn: (body: { tenantRole: string; status: string }) =>
      apiFetch<TeamUserRow>(`/console/users/${user.id}`, { method: 'PATCH', body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: USERS_KEY });
      onClose();
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('tenantUsers.editMemberTitle')}</DialogTitle>
          <DialogDescription>{t('tenantUsers.editMemberDescription')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <FormField label={t('tenantUsers.colEmail')}>
            {(id) => <Input id={id} value={user.email} disabled />}
          </FormField>
          <FormField label={t('tenantUsers.roleLabel')}>
            {(id) => (
              <Select value={tenantRole} onValueChange={setTenantRole}>
                <SelectTrigger id={id}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">{t('tenantUsers.roleAdmin')}</SelectItem>
                  <SelectItem value="member">{t('tenantUsers.roleMember')}</SelectItem>
                </SelectContent>
              </Select>
            )}
          </FormField>
          <FormField label={t('common.status')}>
            {(id) => (
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger id={id}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">{t('common.active')}</SelectItem>
                  <SelectItem value="disabled">{t('common.disabled')}</SelectItem>
                </SelectContent>
              </Select>
            )}
          </FormField>
        </div>
        {update.isError ? <MutationErrorText error={update.error} /> : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={update.isPending}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => update.mutate({ tenantRole, status })} disabled={update.isPending}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function TeamPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editing, setEditing] = useState<TeamUserRow | null>(null);
  const [disabling, setDisabling] = useState<TeamUserRow | null>(null);

  const users = useCursorQuery<TeamUserRow>({ key: USERS_KEY, path: '/console/users' });

  const disable = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ id: string; status: string }>(`/console/users/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: USERS_KEY });
    },
    onSettled: () => setDisabling(null),
  });

  const term = search.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      term === '' ? users.rows : users.rows.filter((row) => row.email.toLowerCase().includes(term)),
    [users.rows, term],
  );

  return (
    <PageTransition>
      <PageHeader
        title={t('tenantUsers.teamTitle')}
        description={t('tenantUsers.teamDescription')}
      />

      {disable.isError ? (
        <ApiErrorNotice error={toApiStateError(disable.error)} className="mb-4" />
      ) : null}

      <Card>
        <DataTableToolbar
          search={{
            value: search,
            onChange: setSearch,
            placeholder: t('tenantUsers.searchMembers'),
          }}
          onRefresh={() => void users.refetch()}
          refreshing={users.isRefetching}
        >
          <Button onClick={() => setInviteOpen(true)}>
            <UserPlus />
            {t('tenantUsers.inviteMember')}
          </Button>
        </DataTableToolbar>
        {users.isLoading ? (
          <div className="p-4">
            <ResourceLoading rows={3} />
          </div>
        ) : users.isError ? (
          <div className="p-4">
            <ApiErrorNotice
              error={toApiStateError(users.error)}
              onRetry={() => void users.refetch()}
            />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Users}
            title={t('tenantUsers.teamEmptyTitle')}
            description={t('tenantUsers.teamEmptyDescription')}
            action={
              <Button onClick={() => setInviteOpen(true)}>
                <UserPlus />
                {t('tenantUsers.inviteMember')}
              </Button>
            }
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <DataTable>
                <DataTableHeader>
                  <DataTableRow>
                    <DataTableHead>{t('tenantUsers.colEmail')}</DataTableHead>
                    <DataTableHead>{t('tenantUsers.colRole')}</DataTableHead>
                    <DataTableHead>{t('common.status')}</DataTableHead>
                    <DataTableHead>{t('common.createdAt')}</DataTableHead>
                    <DataTableHead className="text-right">{t('common.actions')}</DataTableHead>
                  </DataTableRow>
                </DataTableHeader>
                <DataTableBody>
                  {filtered.map((row) => (
                    <DataTableRow key={row.id}>
                      <DataTableCell>{row.email}</DataTableCell>
                      <DataTableCell>
                        <RoleBadge role={row.tenant_role} />
                      </DataTableCell>
                      <DataTableCell>
                        <Badge variant={row.status === 'active' ? 'success' : 'neutral'}>
                          {row.status === 'active' ? t('common.active') : t('common.disabled')}
                        </Badge>
                      </DataTableCell>
                      <DataTableCell>
                        <DateTimeText value={row.created_at} className="text-sm" />
                      </DataTableCell>
                      <DataTableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('common.edit')}
                            onClick={() => setEditing(row)}
                          >
                            <Pencil />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('tenantUsers.disableMember')}
                            onClick={() => setDisabling(row)}
                          >
                            <UserX />
                          </Button>
                        </div>
                      </DataTableCell>
                    </DataTableRow>
                  ))}
                </DataTableBody>
              </DataTable>
            </div>
            <div className="px-4 pb-4">
              <LoadMore
                count={users.rows.length}
                hasMore={users.hasNextPage}
                loading={users.isFetchingNextPage}
                onLoadMore={() => void users.fetchNextPage()}
              />
            </div>
          </>
        )}
      </Card>

      {inviteOpen ? <InviteMemberDialog onClose={() => setInviteOpen(false)} /> : null}
      {editing !== null ? (
        <EditMemberDialog user={editing} onClose={() => setEditing(null)} />
      ) : null}
      <ConfirmDialog
        open={disabling !== null}
        onOpenChange={(open) => {
          if (!open) setDisabling(null);
        }}
        title={t('tenantUsers.disableMemberTitle')}
        description={t('tenantUsers.disableMemberDescription')}
        confirmLabel={t('common.disable')}
        pending={disable.isPending}
        onConfirm={() => {
          if (disabling !== null) disable.mutate(disabling.id);
        }}
      />
    </PageTransition>
  );
}
