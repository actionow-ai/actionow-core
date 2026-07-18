import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PencilLine, Plus, Trash2, Vault } from 'lucide-react';
import { useState } from 'react';
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
import { Input, Textarea } from '@/components/ui/input';

interface SecretRow {
  id: string;
  provider: string;
  locator: string;
  name: string | null;
  notes: string | null;
  group: string | null;
  created_at: string;
  updated_at: string;
}

const SECRETS_KEY = ['admin', 'secrets'] as const;

function CreateSecretDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [locator, setLocator] = useState('');
  const [value, setValue] = useState('');

  const create = useMutation({
    mutationFn: () =>
      apiFetch<SecretRow>('/admin/secrets', {
        method: 'POST',
        body: {
          value,
          label: locator.trim() === '' ? undefined : locator.trim(),
          name: name.trim() === '' ? undefined : name.trim(),
        },
      }),
    onSuccess: () => {
      setName('');
      setLocator('');
      setValue('');
      onOpenChange(false);
      void queryClient.invalidateQueries({ queryKey: SECRETS_KEY });
    },
  });

  const close = (next: boolean) => {
    if (!next) create.reset();
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('platformPages.createSecretTitle')}</DialogTitle>
          <DialogDescription>{t('platformPages.createSecretDescription')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <FormField label={t('platformPages.nameOptional')}>
            {(id) => (
              <Input
                id={id}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            )}
          </FormField>
          <FormField
            label={t('platformPages.secretLocatorLabel')}
            hint={t('platformPages.secretLocatorHint')}
          >
            {(id) => (
              <Input
                id={id}
                className="font-mono"
                value={locator}
                onChange={(event) => {
                  setLocator(event.target.value);
                }}
              />
            )}
          </FormField>
          <FormField
            label={t('platformPages.secretValueLabel')}
            hint={t('platformPages.secretValueHint')}
          >
            {(id) => (
              <Textarea
                id={id}
                className="font-mono"
                rows={4}
                value={value}
                onChange={(event) => {
                  setValue(event.target.value);
                }}
              />
            )}
          </FormField>
          {create.isError ? (
            <p className="text-sm text-danger">{toApiStateError(create.error).message}</p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={create.isPending}
            onClick={() => {
              close(false);
            }}
          >
            {t('common.cancel')}
          </Button>
          <Button
            disabled={value.trim() === '' || create.isPending}
            onClick={() => {
              create.mutate();
            }}
          >
            {t('common.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditSecretDialog({ row, onClose }: { row: SecretRow; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState(row.name ?? '');
  const [notes, setNotes] = useState(row.notes ?? '');
  const [group, setGroup] = useState(row.group ?? '');

  const update = useMutation({
    mutationFn: () =>
      apiFetch<SecretRow>(`/admin/secrets/${row.id}`, {
        method: 'PATCH',
        body: {
          name: name.trim() === '' ? null : name.trim(),
          notes: notes.trim() === '' ? null : notes.trim(),
          group: group.trim() === '' ? null : group.trim(),
        },
      }),
    onSuccess: () => {
      onClose();
      void queryClient.invalidateQueries({ queryKey: SECRETS_KEY });
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('platformPages.editSecretTitle')}</DialogTitle>
          <DialogDescription>{t('platformPages.editMetaDescription')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <p className="font-mono text-sm text-muted-foreground">{row.locator}</p>
          <FormField label={t('common.name')} hint={t('platformPages.metaClearHint')}>
            {(id) => (
              <Input
                id={id}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            )}
          </FormField>
          <FormField label={t('platformPages.groupLabel')} hint={t('platformPages.metaClearHint')}>
            {(id) => (
              <Input
                id={id}
                value={group}
                onChange={(event) => {
                  setGroup(event.target.value);
                }}
              />
            )}
          </FormField>
          <FormField label={t('platformPages.notesLabel')} hint={t('platformPages.metaClearHint')}>
            {(id) => (
              <Textarea
                id={id}
                rows={3}
                value={notes}
                onChange={(event) => {
                  setNotes(event.target.value);
                }}
              />
            )}
          </FormField>
          {update.isError ? (
            <p className="text-sm text-danger">{toApiStateError(update.error).message}</p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={update.isPending} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={update.isPending}
            onClick={() => {
              update.mutate();
            }}
          >
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SecretsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<SecretRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SecretRow | null>(null);

  const list = useCursorQuery<SecretRow>({ key: SECRETS_KEY, path: '/admin/secrets' });

  const remove = useMutation({
    mutationFn: (id: string) => apiFetch<undefined>(`/admin/secrets/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: SECRETS_KEY });
    },
  });

  const query = search.trim().toLowerCase();
  const filtered =
    query === ''
      ? list.rows
      : list.rows.filter((row) =>
          [row.name, row.locator, row.group, row.provider].some(
            (field) => field?.toLowerCase().includes(query) ?? false,
          ),
        );

  return (
    <PageTransition>
      <PageHeader
        title={t('platformPages.secretsTitle')}
        description={t('platformPages.secretsDescription')}
        actions={
          <Button
            onClick={() => {
              setCreateOpen(true);
            }}
          >
            <Plus className="size-4" />
            {t('platformPages.createSecret')}
          </Button>
        }
      />

      <Card>
        <DataTableToolbar
          search={{ value: search, onChange: setSearch }}
          onRefresh={() => void list.refetch()}
          refreshing={list.isRefetching}
        />
        {list.isLoading ? (
          <div className="p-4">
            <ResourceLoading rows={4} />
          </div>
        ) : list.isError ? (
          <div className="p-4">
            <ApiErrorNotice
              error={toApiStateError(list.error)}
              onRetry={() => void list.refetch()}
            />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Vault}
            title={t('platformPages.secretsEmptyTitle')}
            description={t('platformPages.secretsEmptyDescription')}
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <DataTable>
                <DataTableHeader>
                  <DataTableRow>
                    <DataTableHead>{t('common.name')}</DataTableHead>
                    <DataTableHead>{t('platformPages.colProvider')}</DataTableHead>
                    <DataTableHead>{t('platformPages.colLocator')}</DataTableHead>
                    <DataTableHead>{t('platformPages.colGroup')}</DataTableHead>
                    <DataTableHead>{t('platformPages.colNotes')}</DataTableHead>
                    <DataTableHead>{t('common.createdAt')}</DataTableHead>
                    <DataTableHead>{t('common.actions')}</DataTableHead>
                  </DataTableRow>
                </DataTableHeader>
                <DataTableBody>
                  {filtered.map((row) => (
                    <DataTableRow key={row.id}>
                      <DataTableCell className="font-medium">{row.name ?? '—'}</DataTableCell>
                      <DataTableCell>
                        <Badge variant="neutral">{row.provider}</Badge>
                      </DataTableCell>
                      <DataTableCell className="font-mono text-sm">{row.locator}</DataTableCell>
                      <DataTableCell>{row.group ?? '—'}</DataTableCell>
                      <DataTableCell className="max-w-56 truncate text-muted-foreground">
                        {row.notes ?? '—'}
                      </DataTableCell>
                      <DataTableCell>
                        <DateTimeText
                          value={row.created_at}
                          className="text-xs text-muted-foreground"
                        />
                      </DataTableCell>
                      <DataTableCell>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('common.edit')}
                            onClick={() => {
                              setEditTarget(row);
                            }}
                          >
                            <PencilLine className="size-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('common.delete')}
                            onClick={() => {
                              setDeleteTarget(row);
                            }}
                          >
                            <Trash2 className="size-4" />
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
                count={list.rows.length}
                hasMore={list.hasNextPage}
                loading={list.isFetchingNextPage}
                onLoadMore={() => void list.fetchNextPage()}
              />
            </div>
          </>
        )}
      </Card>

      <CreateSecretDialog open={createOpen} onOpenChange={setCreateOpen} />
      {editTarget ? (
        <EditSecretDialog
          row={editTarget}
          onClose={() => {
            setEditTarget(null);
          }}
        />
      ) : null}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(null);
        }}
        title={t('platformPages.deleteSecretTitle')}
        description={t('platformPages.deleteSecretDescription', {
          name: deleteTarget?.name ?? deleteTarget?.locator ?? '',
        })}
        confirmLabel={t('common.delete')}
        pending={remove.isPending}
        onConfirm={() => {
          if (deleteTarget) remove.mutate(deleteTarget.id);
        }}
      />
    </PageTransition>
  );
}
