import type { ConsoleApiKeyView, ConsoleCreateApiKeyBody } from '@actionow/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, RotateCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
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
import { Input } from '@/components/ui/input';

interface MintedKey {
  id: string;
  plaintext: string;
}

export function AppKeysPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const list = useCursorQuery<ConsoleApiKeyView>({
    key: ['console', 'api-keys'],
    path: '/console/api-keys',
    limit: 50,
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [subjectId, setSubjectId] = useState('');
  const [rateLimit, setRateLimit] = useState('');
  const [allowlist, setAllowlist] = useState('');
  const [minted, setMinted] = useState<MintedKey | null>(null);
  const [rotateTarget, setRotateTarget] = useState<string | null>(null);
  const [disableTarget, setDisableTarget] = useState<string | null>(null);

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ['console', 'api-keys'] });

  const create = useMutation({
    mutationFn: (body: ConsoleCreateApiKeyBody) =>
      apiFetch<MintedKey>('/console/api-keys', { method: 'POST', body }),
    onSuccess: (result) => {
      setCreateOpen(false);
      setSubjectId('');
      setRateLimit('');
      setAllowlist('');
      setMinted(result);
      invalidate();
    },
  });
  const rotate = useMutation({
    mutationFn: (id: string) =>
      apiFetch<MintedKey>(`/console/api-keys/${id}/rotate`, { method: 'POST' }),
    onSuccess: (result) => {
      setMinted(result);
      invalidate();
    },
    onSettled: () => setRotateTarget(null),
  });
  const disable = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ id: string; status: string }>(`/console/api-keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidate(),
    onSettled: () => setDisableTarget(null),
  });

  const rateLimitTrimmed = rateLimit.trim();
  const rateLimitValue = rateLimitTrimmed === '' ? undefined : Number(rateLimitTrimmed);
  const rateLimitInvalid =
    rateLimitValue !== undefined && (!Number.isInteger(rateLimitValue) || rateLimitValue <= 0);

  const submitCreate = () => {
    if (rateLimitInvalid) return;
    const body: ConsoleCreateApiKeyBody = {};
    const subject = subjectId.trim();
    if (subject !== '') body.subjectId = subject;
    if (rateLimitValue !== undefined) body.rateLimit = rateLimitValue;
    const resources = allowlist
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '');
    if (resources.length > 0) body.resourceAllowlist = resources;
    create.mutate(body);
  };

  // Writes are tenant-admin only: a member seat gets a 403 which surfaces
  // through the mutation error notices below — no client-side gating.
  const actionError = rotate.error ?? disable.error;

  return (
    <PageTransition>
      <PageHeader
        title={t('tenantCore.keys.title')}
        description={t('tenantCore.keys.description')}
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus />
            {t('tenantCore.keys.create')}
          </Button>
        }
      />

      {actionError !== null ? (
        <ApiErrorNotice error={toApiStateError(actionError)} className="mb-4" />
      ) : null}

      <Card>
        <DataTableToolbar onRefresh={() => void list.refetch()} refreshing={list.isRefetching} />
        {list.isLoading ? (
          <div className="p-4">
            <ResourceLoading rows={4} />
          </div>
        ) : list.isError ? (
          <ApiErrorNotice
            error={toApiStateError(list.error)}
            onRetry={() => void list.refetch()}
            className="m-4"
          />
        ) : list.rows.length === 0 ? (
          <EmptyState
            icon={KeyRound}
            title={t('tenantCore.keys.empty')}
            description={t('tenantCore.keys.emptyDescription')}
            action={
              <Button onClick={() => setCreateOpen(true)}>
                <Plus />
                {t('tenantCore.keys.create')}
              </Button>
            }
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <DataTable>
                <DataTableHeader>
                  <DataTableRow>
                    <DataTableHead>{t('tenantCore.keys.colKey')}</DataTableHead>
                    <DataTableHead>{t('common.status')}</DataTableHead>
                    <DataTableHead>{t('tenantCore.keys.colSubject')}</DataTableHead>
                    <DataTableHead>{t('tenantCore.keys.colRateLimit')}</DataTableHead>
                    <DataTableHead>{t('tenantCore.keys.colAllowlist')}</DataTableHead>
                    <DataTableHead>{t('common.createdAt')}</DataTableHead>
                    <DataTableHead className="text-right">{t('common.actions')}</DataTableHead>
                  </DataTableRow>
                </DataTableHeader>
                <DataTableBody>
                  {list.rows.map((row) => (
                    <DataTableRow key={row.id}>
                      <DataTableCell>
                        <span className="inline-flex items-center gap-1">
                          <span className="font-mono text-sm">{row.id.slice(0, 8)}</span>
                          <CopyButton value={row.id} label={t('common.copy')} />
                        </span>
                      </DataTableCell>
                      <DataTableCell>
                        <Badge variant={row.status === 'active' ? 'success' : 'neutral'}>
                          {row.status === 'active'
                            ? t('tenantCore.keys.statusActive')
                            : t('tenantCore.keys.statusDisabled')}
                        </Badge>
                      </DataTableCell>
                      <DataTableCell>
                        {row.subject_id === null ? (
                          <span className="text-sm text-muted-foreground">
                            {t('tenantCore.keys.tenantLevel')}
                          </span>
                        ) : (
                          <span className="font-mono text-sm">{row.subject_id.slice(0, 8)}</span>
                        )}
                      </DataTableCell>
                      <DataTableCell className="font-mono tabular-nums">
                        {row.rate_limit === null
                          ? t('tenantCore.keys.rateDefault')
                          : `${String(row.rate_limit)}${t('tenantCore.keys.perMinute')}`}
                      </DataTableCell>
                      <DataTableCell className="font-mono tabular-nums">
                        {row.resource_allowlist.length === 0
                          ? t('tenantCore.keys.allowlistAll')
                          : String(row.resource_allowlist.length)}
                      </DataTableCell>
                      <DataTableCell>
                        <DateTimeText value={row.created_at} className="text-sm" />
                      </DataTableCell>
                      <DataTableCell>
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('tenantCore.keys.rotate')}
                            disabled={row.status !== 'active'}
                            onClick={() => setRotateTarget(row.id)}
                          >
                            <RotateCw />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('common.disable')}
                            disabled={row.status !== 'active'}
                            onClick={() => setDisableTarget(row.id)}
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
                count={list.rows.length}
                hasMore={list.hasNextPage}
                loading={list.isFetchingNextPage}
                onLoadMore={() => void list.fetchNextPage()}
              />
            </div>
          </>
        )}
      </Card>

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) create.reset();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('tenantCore.keys.createTitle')}</DialogTitle>
            <DialogDescription>{t('tenantCore.keys.createDescription')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <FormField
              label={t('tenantCore.keys.fieldSubject')}
              hint={t('tenantCore.keys.fieldSubjectHint')}
            >
              {(id) => (
                <Input
                  id={id}
                  value={subjectId}
                  onChange={(event) => setSubjectId(event.target.value)}
                  className="font-mono"
                />
              )}
            </FormField>
            <FormField
              label={t('tenantCore.keys.fieldRateLimit')}
              hint={t('tenantCore.keys.fieldRateLimitHint')}
              error={rateLimitInvalid ? t('tenantCore.keys.rateLimitInvalid') : undefined}
            >
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min={1}
                  value={rateLimit}
                  onChange={(event) => setRateLimit(event.target.value)}
                />
              )}
            </FormField>
            <FormField
              label={t('tenantCore.keys.fieldAllowlist')}
              hint={t('tenantCore.keys.fieldAllowlistHint')}
            >
              {(id) => (
                <Input
                  id={id}
                  value={allowlist}
                  onChange={(event) => setAllowlist(event.target.value)}
                  className="font-mono"
                />
              )}
            </FormField>
            {create.isError ? <ApiErrorNotice error={toApiStateError(create.error)} /> : null}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateOpen(false)}
              disabled={create.isPending}
            >
              {t('common.cancel')}
            </Button>
            <Button onClick={submitCreate} disabled={create.isPending || rateLimitInvalid}>
              {create.isPending ? t('common.loading') : t('common.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={minted !== null}
        onOpenChange={(open) => {
          if (!open) setMinted(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('tenantCore.keys.resultTitle')}</DialogTitle>
            <DialogDescription>{t('tenantCore.keys.resultWarning')}</DialogDescription>
          </DialogHeader>
          {minted !== null ? (
            <div className="flex items-center gap-2 rounded-xl bg-surface-subtle p-3">
              <code className="min-w-0 flex-1 break-all font-mono text-sm">{minted.plaintext}</code>
              <CopyButton value={minted.plaintext} label={t('tenantCore.keys.copyKey')} />
            </div>
          ) : null}
          <DialogFooter>
            <Button onClick={() => setMinted(null)}>{t('common.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={rotateTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRotateTarget(null);
        }}
        title={t('tenantCore.keys.rotateTitle')}
        description={t('tenantCore.keys.rotateDescription')}
        confirmLabel={t('tenantCore.keys.rotate')}
        destructive={false}
        pending={rotate.isPending}
        onConfirm={() => {
          if (rotateTarget !== null) rotate.mutate(rotateTarget);
        }}
      />
      <ConfirmDialog
        open={disableTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDisableTarget(null);
        }}
        title={t('tenantCore.keys.disableTitle')}
        description={t('tenantCore.keys.disableDescription')}
        confirmLabel={t('common.disable')}
        pending={disable.isPending}
        onConfirm={() => {
          if (disableTarget !== null) disable.mutate(disableTarget);
        }}
      />
    </PageTransition>
  );
}
