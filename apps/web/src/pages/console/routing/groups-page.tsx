import type {
  AddGroupChannelBody,
  CreateRouteGroupBody,
  RouteGroupChannelView,
  RouteGroupView,
  UpdateRouteGroupBody,
} from '@actionow/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ListTree, Network, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { apiFetch, toApiStateError } from '@/api/client';
import { useCursorQuery } from '@/api/hooks';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/components/radix/sheet';
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
import { Input, Textarea } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const NONE = '__none__';

function intFrom(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
}

function formatRatio(bps: number): string {
  return `×${String(bps / 10000)}`;
}

interface GroupFormState {
  name: string;
  ratioBps: string;
  fallbackGroupId: string;
  requireParams: string;
  status: string;
  description: string;
}

function groupFormFrom(group: RouteGroupView | null): GroupFormState {
  return {
    name: group?.name ?? '',
    ratioBps: group ? String(group.group_ratio_bps) : '10000',
    fallbackGroupId: group?.fallback_group_id ?? NONE,
    requireParams: group?.require_params ? 'true' : 'false',
    status: group?.status === 'disabled' ? 'disabled' : 'active',
    description: group?.description ?? '',
  };
}

function GroupFormDialog({
  open,
  onOpenChange,
  group,
  groups,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  group: RouteGroupView | null;
  groups: RouteGroupView[];
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<GroupFormState>(() => groupFormFrom(group));

  useEffect(() => {
    if (open) setForm(groupFormFrom(group));
  }, [open, group]);

  const mutation = useMutation({
    mutationFn: () => {
      const fallback = form.fallbackGroupId === NONE ? null : form.fallbackGroupId;
      const description = form.description.trim();
      const status = form.status === 'disabled' ? ('disabled' as const) : ('active' as const);
      if (group) {
        const body: UpdateRouteGroupBody = {
          name: form.name.trim(),
          groupRatioBps: intFrom(form.ratioBps),
          fallbackGroupId: fallback,
          requireParams: form.requireParams === 'true',
          status,
          description: description === '' ? null : description,
        };
        return apiFetch<RouteGroupView>(`/admin/route-groups/${group.id}`, {
          method: 'PATCH',
          body,
        });
      }
      const body: CreateRouteGroupBody = {
        name: form.name.trim(),
        groupRatioBps: intFrom(form.ratioBps),
        fallbackGroupId: fallback,
        requireParams: form.requireParams === 'true',
        status,
        ...(description === '' ? {} : { description }),
      };
      return apiFetch<RouteGroupView>('/admin/route-groups', { method: 'POST', body });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'route-groups'] });
      onOpenChange(false);
    },
  });

  const fallbackOptions = groups.filter((item) => item.id !== group?.id);
  const canSave = form.name.trim() !== '' && !mutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{group ? t('routing.editGroup') : t('routing.createGroup')}</DialogTitle>
        </DialogHeader>
        {mutation.isError ? <ApiErrorNotice error={toApiStateError(mutation.error)} /> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={t('common.name')} className="sm:col-span-2">
            {(id) => (
              <Input
                id={id}
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            )}
          </FormField>
          <FormField label={t('routing.colRatio')} hint={t('routing.ratioHint')}>
            {(id) => (
              <Input
                id={id}
                type="number"
                inputMode="numeric"
                value={form.ratioBps}
                onChange={(event) => setForm({ ...form, ratioBps: event.target.value })}
              />
            )}
          </FormField>
          <FormField label={t('common.status')}>
            {(id) => (
              <Select
                value={form.status}
                onValueChange={(value) => setForm({ ...form, status: value })}
              >
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
          <FormField label={t('routing.fieldFallback')}>
            {(id) => (
              <Select
                value={form.fallbackGroupId}
                onValueChange={(value) => setForm({ ...form, fallbackGroupId: value })}
              >
                <SelectTrigger id={id}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t('routing.fallbackNone')}</SelectItem>
                  {fallbackOptions.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>
          <FormField label={t('routing.fieldRequireParams')} hint={t('routing.requireParamsHint')}>
            {(id) => (
              <Select
                value={form.requireParams}
                onValueChange={(value) => setForm({ ...form, requireParams: value })}
              >
                <SelectTrigger id={id}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="false">{t('routing.requireParamsOff')}</SelectItem>
                  <SelectItem value="true">{t('routing.requireParamsOn')}</SelectItem>
                </SelectContent>
              </Select>
            )}
          </FormField>
          <FormField label={t('common.description')} className="sm:col-span-2">
            {(id) => (
              <Textarea
                id={id}
                value={form.description}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
              />
            )}
          </FormField>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            {t('common.cancel')}
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={!canSave}>
            {group ? t('common.save') : t('common.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MemberEditDialog({
  member,
  pending,
  onOpenChange,
  onSave,
}: {
  member: RouteGroupChannelView | null;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (priority: number, weight: number) => void;
}) {
  const { t } = useTranslation();
  const [priority, setPriority] = useState('0');
  const [weight, setWeight] = useState('1');

  useEffect(() => {
    if (member) {
      setPriority(String(member.priority));
      setWeight(String(member.weight));
    }
  }, [member]);

  return (
    <Dialog open={member !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('routing.editMember')}</DialogTitle>
          <DialogDescription className="break-all font-mono text-xs">
            {member?.channel_id}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <FormField label={t('routing.colPriority')} hint={t('routing.priorityHint')}>
            {(id) => (
              <Input
                id={id}
                type="number"
                inputMode="numeric"
                value={priority}
                onChange={(event) => setPriority(event.target.value)}
              />
            )}
          </FormField>
          <FormField label={t('routing.colWeight')} hint={t('routing.weightHint')}>
            {(id) => (
              <Input
                id={id}
                type="number"
                inputMode="numeric"
                value={weight}
                onChange={(event) => setWeight(event.target.value)}
              />
            )}
          </FormField>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={() => onSave(intFrom(priority) ?? 0, intFrom(weight) ?? 1)}
            disabled={pending}
          >
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GroupMembersPanel({ group }: { group: RouteGroupView }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const members = useCursorQuery<RouteGroupChannelView>({
    key: ['admin', 'route-groups', group.id, 'channels'],
    path: `/admin/route-groups/${group.id}/channels`,
  });
  const [addForm, setAddForm] = useState({ channelId: '', priority: '0', weight: '1' });
  const [editing, setEditing] = useState<RouteGroupChannelView | null>(null);
  const [removing, setRemoving] = useState<RouteGroupChannelView | null>(null);

  const upsert = useMutation({
    mutationFn: (input: { channelId: string; body: AddGroupChannelBody }) =>
      apiFetch<RouteGroupChannelView>(
        `/admin/route-groups/${group.id}/channels/${input.channelId}`,
        { method: 'PUT', body: input.body },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['admin', 'route-groups', group.id, 'channels'],
      });
      setEditing(null);
      setAddForm({ channelId: '', priority: '0', weight: '1' });
    },
  });

  const remove = useMutation({
    mutationFn: (channelId: string) =>
      apiFetch<undefined>(`/admin/route-groups/${group.id}/channels/${channelId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['admin', 'route-groups', group.id, 'channels'],
      });
      setRemoving(null);
    },
  });

  return (
    <>
      <SheetHeader>
        <SheetTitle>{t('routing.membersTitle')}</SheetTitle>
        <SheetDescription>{t('routing.membersDescription', { name: group.name })}</SheetDescription>
      </SheetHeader>
      <div className="flex-1 space-y-4 overflow-y-auto px-4 pb-4">
        {upsert.isError ? <ApiErrorNotice error={toApiStateError(upsert.error)} /> : null}
        {remove.isError ? <ApiErrorNotice error={toApiStateError(remove.error)} /> : null}
        <div className="rounded-xl bg-surface-subtle p-4">
          <p className="text-sm font-semibold">{t('routing.addMember')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('routing.addMemberHint')}</p>
          <div className="mt-3 grid gap-3">
            <FormField label={t('routing.colChannelId')}>
              {(id) => (
                <Input
                  id={id}
                  className="font-mono"
                  placeholder={t('routing.channelIdPlaceholder')}
                  value={addForm.channelId}
                  onChange={(event) => setAddForm({ ...addForm, channelId: event.target.value })}
                />
              )}
            </FormField>
            <div className="grid grid-cols-2 gap-3">
              <FormField label={t('routing.colPriority')} hint={t('routing.priorityHint')}>
                {(id) => (
                  <Input
                    id={id}
                    type="number"
                    inputMode="numeric"
                    value={addForm.priority}
                    onChange={(event) => setAddForm({ ...addForm, priority: event.target.value })}
                  />
                )}
              </FormField>
              <FormField label={t('routing.colWeight')} hint={t('routing.weightHint')}>
                {(id) => (
                  <Input
                    id={id}
                    type="number"
                    inputMode="numeric"
                    value={addForm.weight}
                    onChange={(event) => setAddForm({ ...addForm, weight: event.target.value })}
                  />
                )}
              </FormField>
            </div>
            <div className="flex justify-end">
              <Button
                size="sm"
                disabled={addForm.channelId.trim() === '' || upsert.isPending}
                onClick={() =>
                  upsert.mutate({
                    channelId: addForm.channelId.trim(),
                    body: {
                      priority: intFrom(addForm.priority) ?? 0,
                      weight: intFrom(addForm.weight) ?? 1,
                    },
                  })
                }
              >
                <Plus />
                {t('routing.addMember')}
              </Button>
            </div>
          </div>
        </div>
        {members.isLoading ? (
          <ResourceLoading rows={3} />
        ) : members.isError ? (
          <ApiErrorNotice
            error={toApiStateError(members.error)}
            onRetry={() => void members.refetch()}
          />
        ) : members.rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t('routing.membersEmpty')}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <DataTable className="min-w-full">
              <DataTableHeader>
                <DataTableRow>
                  <DataTableHead>{t('routing.colChannelId')}</DataTableHead>
                  <DataTableHead>{t('routing.colPriority')}</DataTableHead>
                  <DataTableHead>{t('routing.colWeight')}</DataTableHead>
                  <DataTableHead className="text-right">{t('common.actions')}</DataTableHead>
                </DataTableRow>
              </DataTableHeader>
              <DataTableBody>
                {members.rows.map((member) => (
                  <DataTableRow key={member.channel_id}>
                    <DataTableCell className="break-all font-mono text-xs">
                      {member.channel_id}
                    </DataTableCell>
                    <DataTableCell className="font-mono tabular-nums">
                      {member.priority}
                    </DataTableCell>
                    <DataTableCell className="font-mono tabular-nums">
                      {member.weight}
                    </DataTableCell>
                    <DataTableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('routing.editMember')}
                          onClick={() => setEditing(member)}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('routing.removeMember')}
                          onClick={() => setRemoving(member)}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </DataTableCell>
                  </DataTableRow>
                ))}
              </DataTableBody>
            </DataTable>
            <LoadMore
              count={members.rows.length}
              hasMore={members.hasNextPage}
              loading={members.isFetchingNextPage}
              onLoadMore={() => void members.fetchNextPage()}
            />
          </div>
        )}
      </div>
      <MemberEditDialog
        member={editing}
        pending={upsert.isPending}
        onOpenChange={(next) => {
          if (!next) setEditing(null);
        }}
        onSave={(priority, weight) => {
          if (editing) {
            upsert.mutate({ channelId: editing.channel_id, body: { priority, weight } });
          }
        }}
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(next) => {
          if (!next) setRemoving(null);
        }}
        title={t('routing.removeMember')}
        description={removing ? t('routing.removeMemberConfirm', { id: removing.channel_id }) : ''}
        confirmLabel={t('common.delete')}
        pending={remove.isPending}
        onConfirm={() => {
          if (removing) remove.mutate(removing.channel_id);
        }}
      />
    </>
  );
}

export function RouteGroupsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<RouteGroupView | null>(null);
  const [deleting, setDeleting] = useState<RouteGroupView | null>(null);
  const [managing, setManaging] = useState<RouteGroupView | null>(null);

  const query = useCursorQuery<RouteGroupView>({
    key: ['admin', 'route-groups'],
    path: '/admin/route-groups',
  });

  const nameById = useMemo(
    () => new Map(query.rows.map((row) => [row.id, row.name])),
    [query.rows],
  );

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (keyword === '') return query.rows;
    return query.rows.filter((row) => row.name.toLowerCase().includes(keyword));
  }, [query.rows, search]);

  const removeMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<undefined>(`/admin/route-groups/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'route-groups'] });
      setDeleting(null);
    },
  });

  return (
    <PageTransition>
      <PageHeader
        title={t('routing.groupsTitle')}
        description={t('routing.groupsDescription')}
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus />
            {t('routing.createGroup')}
          </Button>
        }
      />
      {removeMutation.isError ? (
        <ApiErrorNotice error={toApiStateError(removeMutation.error)} className="mb-4" />
      ) : null}
      <Card>
        <DataTableToolbar
          search={{ value: search, onChange: setSearch, placeholder: t('routing.groupsSearch') }}
          onRefresh={() => void query.refetch()}
          refreshing={query.isRefetching}
        />
        {query.isLoading ? (
          <div className="p-4">
            <ResourceLoading rows={4} />
          </div>
        ) : query.isError ? (
          <div className="p-4">
            <ApiErrorNotice
              error={toApiStateError(query.error)}
              onRetry={() => void query.refetch()}
            />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Network}
            title={t('routing.groupsEmptyTitle')}
            description={t('routing.groupsEmptyDescription')}
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <DataTable>
                <DataTableHeader>
                  <DataTableRow>
                    <DataTableHead>{t('common.name')}</DataTableHead>
                    <DataTableHead>{t('routing.colRatio')}</DataTableHead>
                    <DataTableHead>{t('routing.colFallback')}</DataTableHead>
                    <DataTableHead>{t('routing.colRequireParams')}</DataTableHead>
                    <DataTableHead>{t('common.status')}</DataTableHead>
                    <DataTableHead className="text-right">{t('common.actions')}</DataTableHead>
                  </DataTableRow>
                </DataTableHeader>
                <DataTableBody>
                  {filtered.map((row) => (
                    <DataTableRow key={row.id}>
                      <DataTableCell>
                        <p className="font-medium">{row.name}</p>
                        {row.description === null ? null : (
                          <p className="mt-0.5 max-w-64 truncate text-xs text-muted-foreground">
                            {row.description}
                          </p>
                        )}
                      </DataTableCell>
                      <DataTableCell className="font-mono tabular-nums">
                        {formatRatio(row.group_ratio_bps)}
                      </DataTableCell>
                      <DataTableCell>
                        {row.fallback_group_id === null ? (
                          <span className="text-muted-foreground">{t('common.none')}</span>
                        ) : (
                          (nameById.get(row.fallback_group_id) ?? (
                            <span className="font-mono text-xs">
                              {row.fallback_group_id.slice(0, 8)}
                            </span>
                          ))
                        )}
                      </DataTableCell>
                      <DataTableCell>
                        {row.require_params ? (
                          <Badge variant="neutral">{t('routing.requireParamsOn')}</Badge>
                        ) : (
                          <span className="text-muted-foreground">
                            {t('routing.requireParamsOff')}
                          </span>
                        )}
                      </DataTableCell>
                      <DataTableCell>
                        <Badge variant={row.status === 'active' ? 'success' : 'neutral'}>
                          {row.status === 'active' ? t('common.active') : t('common.disabled')}
                        </Badge>
                      </DataTableCell>
                      <DataTableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('routing.manageChannels')}
                            onClick={() => setManaging(row)}
                          >
                            <ListTree />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('routing.editGroup')}
                            onClick={() => setEditing(row)}
                          >
                            <Pencil />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('routing.deleteGroup')}
                            onClick={() => setDeleting(row)}
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      </DataTableCell>
                    </DataTableRow>
                  ))}
                </DataTableBody>
              </DataTable>
            </div>
            <div className="border-t px-4 pb-3">
              <LoadMore
                count={filtered.length}
                hasMore={query.hasNextPage}
                loading={query.isFetchingNextPage}
                onLoadMore={() => void query.fetchNextPage()}
              />
            </div>
          </>
        )}
      </Card>

      <GroupFormDialog
        open={createOpen || editing !== null}
        group={editing}
        groups={query.rows}
        onOpenChange={(next) => {
          if (!next) {
            setCreateOpen(false);
            setEditing(null);
          }
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(next) => {
          if (!next) setDeleting(null);
        }}
        title={t('routing.deleteGroup')}
        description={deleting ? t('routing.deleteGroupConfirm', { name: deleting.name }) : ''}
        confirmLabel={t('common.delete')}
        pending={removeMutation.isPending}
        onConfirm={() => {
          if (deleting) removeMutation.mutate(deleting.id);
        }}
      />
      <Sheet
        open={managing !== null}
        onOpenChange={(next) => {
          if (!next) setManaging(null);
        }}
      >
        <SheetContent side="right" className="w-full sm:w-[600px] sm:max-w-[600px]">
          {managing ? <GroupMembersPanel group={managing} /> : null}
        </SheetContent>
      </Sheet>
    </PageTransition>
  );
}
