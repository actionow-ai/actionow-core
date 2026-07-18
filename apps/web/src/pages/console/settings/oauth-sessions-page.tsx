import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Fingerprint, PencilLine, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { apiFetch, toApiStateError } from '@/api/client';
import { useCursorQuery } from '@/api/hooks';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { CopyButton } from '@/components/common/copy-button';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface OauthSessionRow {
  id: string;
  provider_kind: string;
  account_label: string | null;
  account_id: string | null;
  name: string | null;
  notes: string | null;
  group: string | null;
  status: string;
  expires_at: string | null;
  last_refresh_at: string | null;
}

interface OauthSessionCreatedView {
  id: string;
  provider_kind: string;
  account_label: string | null;
  account_id: string | null;
}

interface CodexLoginStartView {
  authorize_url: string;
  state: string;
}

const OAUTH_KEY = ['admin', 'oauth-sessions'] as const;

const sessionStatusVariant: Partial<Record<string, 'success' | 'warning'>> = {
  active: 'success',
  needs_reauth: 'warning',
};

function ImportSessionDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [authJson, setAuthJson] = useState('');

  const parsed = useMemo(() => {
    if (authJson.trim() === '') return { value: null, invalid: false };
    try {
      const value: unknown = JSON.parse(authJson);
      if (
        value !== null &&
        typeof value === 'object' &&
        typeof (value as Record<string, unknown>).access_token === 'string' &&
        typeof (value as Record<string, unknown>).refresh_token === 'string'
      ) {
        return { value: value as Record<string, unknown>, invalid: false };
      }
      return { value: null, invalid: true };
    } catch {
      return { value: null, invalid: true };
    }
  }, [authJson]);

  const create = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      apiFetch<OauthSessionCreatedView>('/admin/oauth-sessions', {
        method: 'POST',
        body: {
          providerKind: 'codex-oauth',
          authJson: payload,
          acknowledgeUpstreamTos: true,
          name: name.trim() === '' ? undefined : name.trim(),
        },
      }),
    onSuccess: () => {
      setName('');
      setAuthJson('');
      onOpenChange(false);
      void queryClient.invalidateQueries({ queryKey: OAUTH_KEY });
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
          <DialogTitle>{t('platformPages.importSessionTitle')}</DialogTitle>
          <DialogDescription>{t('platformPages.importSessionDescription')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <FormField label={t('platformPages.providerKindLabel')}>
            {() => (
              <Select value="codex-oauth">
                <SelectTrigger aria-label={t('platformPages.providerKindLabel')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="codex-oauth">codex-oauth</SelectItem>
                </SelectContent>
              </Select>
            )}
          </FormField>
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
            label={t('platformPages.authJsonLabel')}
            hint={t('platformPages.authJsonHint')}
            error={parsed.invalid ? t('platformPages.authJsonInvalid') : undefined}
          >
            {(id) => (
              <Textarea
                id={id}
                className="font-mono"
                rows={5}
                value={authJson}
                onChange={(event) => {
                  setAuthJson(event.target.value);
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
            disabled={parsed.value === null || create.isPending}
            onClick={() => {
              if (parsed.value) create.mutate(parsed.value);
            }}
          >
            {t('common.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CodexLoginDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');

  const start = useMutation({
    mutationFn: () =>
      apiFetch<CodexLoginStartView>('/admin/oauth-sessions/codex/login/start', {
        method: 'POST',
        body: { acknowledgeUpstreamTos: true },
      }),
  });
  const complete = useMutation({
    mutationFn: (state: string) =>
      apiFetch<OauthSessionCreatedView>('/admin/oauth-sessions/codex/login/complete', {
        method: 'POST',
        body: {
          acknowledgeUpstreamTos: true,
          code: code.trim(),
          state,
          name: name.trim() === '' ? undefined : name.trim(),
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: OAUTH_KEY });
    },
  });

  const { mutate: startLogin } = start;
  useEffect(() => {
    startLogin();
  }, [startLogin]);

  const session = complete.data;
  const startData = start.data;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('platformPages.codexLoginTitle')}</DialogTitle>
          <DialogDescription>{t('platformPages.codexLoginDescription')}</DialogDescription>
        </DialogHeader>
        {session ? (
          <>
            <div className="flex items-start gap-3 rounded-xl bg-success/12 p-4 text-sm">
              <ShieldCheck className="mt-0.5 size-4 text-success" />
              <div className="min-w-0">
                <p className="font-medium">{t('platformPages.codexSuccess')}</p>
                <p className="mt-1 font-mono text-xs text-muted-foreground break-all">
                  {session.account_label ?? session.account_id ?? session.id}
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button onClick={onClose}>{t('common.close')}</Button>
            </DialogFooter>
          </>
        ) : start.isPending ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : start.isError ? (
          <>
            <ApiErrorNotice
              error={toApiStateError(start.error)}
              title={t('platformPages.codexStartFailed')}
              onRetry={() => {
                start.mutate();
              }}
            />
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                {t('common.close')}
              </Button>
            </DialogFooter>
          </>
        ) : startData ? (
          <>
            <div className="grid gap-4">
              <div className="space-y-1.5">
                <p className="text-sm font-medium">{t('platformPages.authorizeUrlLabel')}</p>
                <div className="flex items-center gap-2 rounded-xl bg-surface-subtle p-3">
                  <code className="min-w-0 flex-1 font-mono text-xs break-all">
                    {startData.authorize_url}
                  </code>
                  <CopyButton value={startData.authorize_url} />
                </div>
                <Button variant="outline" size="sm" asChild>
                  <a href={startData.authorize_url} target="_blank" rel="noreferrer">
                    <ExternalLink className="size-4" />
                    {t('platformPages.openAuthorize')}
                  </a>
                </Button>
              </div>
              <FormField label={t('platformPages.codeLabel')} hint={t('platformPages.codeHint')}>
                {(id) => (
                  <Input
                    id={id}
                    className="font-mono"
                    value={code}
                    onChange={(event) => {
                      setCode(event.target.value);
                    }}
                  />
                )}
              </FormField>
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
              {complete.isError ? (
                <p className="text-sm text-danger">{toApiStateError(complete.error).message}</p>
              ) : null}
            </div>
            <DialogFooter>
              <Button variant="outline" disabled={complete.isPending} onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button
                disabled={code.trim() === '' || complete.isPending}
                onClick={() => {
                  complete.mutate(startData.state);
                }}
              >
                {t('platformPages.completeLogin')}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function EditSessionDialog({ row, onClose }: { row: OauthSessionRow; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState(row.name ?? '');
  const [notes, setNotes] = useState(row.notes ?? '');
  const [group, setGroup] = useState(row.group ?? '');

  const update = useMutation({
    mutationFn: () =>
      apiFetch<OauthSessionRow>(`/admin/oauth-sessions/${row.id}`, {
        method: 'PATCH',
        body: {
          name: name.trim() === '' ? null : name.trim(),
          notes: notes.trim() === '' ? null : notes.trim(),
          group: group.trim() === '' ? null : group.trim(),
        },
      }),
    onSuccess: () => {
      onClose();
      void queryClient.invalidateQueries({ queryKey: OAUTH_KEY });
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
          <DialogTitle>{t('platformPages.editSessionTitle')}</DialogTitle>
          <DialogDescription>{t('platformPages.editMetaDescription')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <p className="font-mono text-sm text-muted-foreground">
            {row.account_label ?? row.account_id ?? row.id}
          </p>
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

export function OauthSessionsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [codexOpen, setCodexOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<OauthSessionRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<OauthSessionRow | null>(null);

  const list = useCursorQuery<OauthSessionRow>({ key: OAUTH_KEY, path: '/admin/oauth-sessions' });

  const remove = useMutation({
    mutationFn: (id: string) =>
      apiFetch<undefined>(`/admin/oauth-sessions/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: OAUTH_KEY });
    },
  });

  const statusLabel = (status: string) =>
    status === 'active'
      ? t('platformPages.statusActive')
      : status === 'needs_reauth'
        ? t('platformPages.statusNeedsReauth')
        : status;

  const query = search.trim().toLowerCase();
  const filtered =
    query === ''
      ? list.rows
      : list.rows.filter((row) =>
          [row.name, row.account_label, row.account_id, row.provider_kind, row.group].some(
            (field) => field?.toLowerCase().includes(query) ?? false,
          ),
        );

  return (
    <PageTransition>
      <PageHeader
        title={t('platformPages.oauthTitle')}
        description={t('platformPages.oauthDescription')}
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => {
                setImportOpen(true);
              }}
            >
              <Plus className="size-4" />
              {t('platformPages.importSession')}
            </Button>
            <Button
              onClick={() => {
                setCodexOpen(true);
              }}
            >
              <Fingerprint className="size-4" />
              {t('platformPages.codexLogin')}
            </Button>
          </>
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
            icon={Fingerprint}
            title={t('platformPages.oauthEmptyTitle')}
            description={t('platformPages.oauthEmptyDescription')}
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <DataTable>
                <DataTableHeader>
                  <DataTableRow>
                    <DataTableHead>{t('common.name')}</DataTableHead>
                    <DataTableHead>{t('platformPages.colProvider')}</DataTableHead>
                    <DataTableHead>{t('platformPages.colAccount')}</DataTableHead>
                    <DataTableHead>{t('common.status')}</DataTableHead>
                    <DataTableHead>{t('platformPages.colExpires')}</DataTableHead>
                    <DataTableHead>{t('platformPages.colLastRefresh')}</DataTableHead>
                    <DataTableHead>{t('common.actions')}</DataTableHead>
                  </DataTableRow>
                </DataTableHeader>
                <DataTableBody>
                  {filtered.map((row) => (
                    <DataTableRow key={row.id}>
                      <DataTableCell className="font-medium">
                        {row.name ?? row.account_label ?? '—'}
                      </DataTableCell>
                      <DataTableCell>
                        <Badge variant="neutral">{row.provider_kind}</Badge>
                      </DataTableCell>
                      <DataTableCell className="max-w-56 truncate font-mono text-sm">
                        {row.account_label ?? row.account_id ?? '—'}
                      </DataTableCell>
                      <DataTableCell>
                        <Badge variant={sessionStatusVariant[row.status] ?? 'neutral'}>
                          {statusLabel(row.status)}
                        </Badge>
                      </DataTableCell>
                      <DataTableCell>
                        <DateTimeText
                          value={row.expires_at}
                          className="text-xs text-muted-foreground"
                        />
                      </DataTableCell>
                      <DataTableCell>
                        <DateTimeText
                          value={row.last_refresh_at}
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

      <ImportSessionDialog open={importOpen} onOpenChange={setImportOpen} />
      {codexOpen ? (
        <CodexLoginDialog
          onClose={() => {
            setCodexOpen(false);
          }}
        />
      ) : null}
      {editTarget ? (
        <EditSessionDialog
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
        title={t('platformPages.deleteSessionTitle')}
        description={t('platformPages.deleteSessionDescription', {
          name: deleteTarget?.name ?? deleteTarget?.account_label ?? deleteTarget?.id ?? '',
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
