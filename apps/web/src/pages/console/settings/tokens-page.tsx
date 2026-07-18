import { useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
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

interface AdminTokenRow {
  id: string;
  name: string;
  created_by: string;
  status: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface TokenMintedView {
  id: string;
  plaintext: string;
}

const TOKENS_KEY = ['admin', 'tokens'] as const;

const tokenStatusVariant: Partial<Record<string, 'success' | 'neutral'>> = {
  active: 'success',
  revoked: 'neutral',
};

function MintTokenDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [expires, setExpires] = useState('');

  const create = useMutation({
    mutationFn: () =>
      apiFetch<TokenMintedView>('/admin/tokens', {
        method: 'POST',
        body: {
          name: name.trim(),
          expiresAt: expires === '' ? undefined : new Date(expires).toISOString(),
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TOKENS_KEY });
    },
  });

  const expiresInvalid = expires !== '' && Number.isNaN(new Date(expires).getTime());
  const minted = create.data;

  const close = (next: boolean) => {
    if (!next) {
      setName('');
      setExpires('');
      create.reset();
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {minted ? t('platformPages.tokenCreatedTitle') : t('platformPages.mintTokenTitle')}
          </DialogTitle>
          <DialogDescription>
            {minted
              ? t('platformPages.tokenCreatedWarning')
              : t('platformPages.mintTokenDescription')}
          </DialogDescription>
        </DialogHeader>
        {minted ? (
          <>
            <div className="flex items-center gap-2 rounded-xl bg-surface-subtle p-3">
              <code className="min-w-0 flex-1 font-mono text-sm break-all">{minted.plaintext}</code>
              <CopyButton value={minted.plaintext} label={t('common.copy')} />
            </div>
            <DialogFooter>
              <Button
                onClick={() => {
                  close(false);
                }}
              >
                {t('common.close')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="grid gap-4">
              <FormField label={t('common.name')}>
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
                label={t('platformPages.expiresLabel')}
                hint={t('platformPages.expiresHint')}
                error={expiresInvalid ? t('platformPages.expiresInvalid') : undefined}
              >
                {(id) => (
                  <Input
                    id={id}
                    type="datetime-local"
                    value={expires}
                    onChange={(event) => {
                      setExpires(event.target.value);
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
                disabled={name.trim() === '' || expiresInvalid || create.isPending}
                onClick={() => {
                  create.mutate();
                }}
              >
                {t('common.create')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function AdminTokensPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [mintOpen, setMintOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<AdminTokenRow | null>(null);

  const list = useCursorQuery<AdminTokenRow>({ key: TOKENS_KEY, path: '/admin/tokens' });

  const revoke = useMutation({
    mutationFn: (id: string) => apiFetch<undefined>(`/admin/tokens/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setRevokeTarget(null);
      void queryClient.invalidateQueries({ queryKey: TOKENS_KEY });
    },
  });

  const statusLabel = (status: string) =>
    status === 'active'
      ? t('platformPages.statusActive')
      : status === 'revoked'
        ? t('platformPages.statusRevoked')
        : status;

  const query = search.trim().toLowerCase();
  const filtered =
    query === '' ? list.rows : list.rows.filter((row) => row.name.toLowerCase().includes(query));

  return (
    <PageTransition>
      <PageHeader
        title={t('platformPages.tokensTitle')}
        description={t('platformPages.tokensDescription')}
        actions={
          <Button
            onClick={() => {
              setMintOpen(true);
            }}
          >
            <Plus className="size-4" />
            {t('platformPages.mintToken')}
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
            icon={KeyRound}
            title={t('platformPages.tokensEmptyTitle')}
            description={t('platformPages.tokensEmptyDescription')}
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <DataTable>
                <DataTableHeader>
                  <DataTableRow>
                    <DataTableHead>{t('common.name')}</DataTableHead>
                    <DataTableHead>{t('platformPages.colCreatedBy')}</DataTableHead>
                    <DataTableHead>{t('common.status')}</DataTableHead>
                    <DataTableHead>{t('platformPages.colExpires')}</DataTableHead>
                    <DataTableHead>{t('common.createdAt')}</DataTableHead>
                    <DataTableHead>{t('common.actions')}</DataTableHead>
                  </DataTableRow>
                </DataTableHeader>
                <DataTableBody>
                  {filtered.map((row) => (
                    <DataTableRow key={row.id}>
                      <DataTableCell className="font-medium">{row.name}</DataTableCell>
                      <DataTableCell className="font-mono text-sm">
                        {row.created_by.slice(0, 8)}
                      </DataTableCell>
                      <DataTableCell>
                        <Badge variant={tokenStatusVariant[row.status] ?? 'neutral'}>
                          {statusLabel(row.status)}
                        </Badge>
                      </DataTableCell>
                      <DataTableCell>
                        {row.expires_at ? (
                          <DateTimeText
                            value={row.expires_at}
                            className="text-xs text-muted-foreground"
                          />
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {t('platformPages.neverExpires')}
                          </span>
                        )}
                      </DataTableCell>
                      <DataTableCell>
                        <DateTimeText
                          value={row.created_at}
                          className="text-xs text-muted-foreground"
                        />
                      </DataTableCell>
                      <DataTableCell>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('platformPages.revokeTokenTitle')}
                          onClick={() => {
                            setRevokeTarget(row);
                          }}
                        >
                          <Trash2 className="size-4" />
                        </Button>
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

      <MintTokenDialog open={mintOpen} onOpenChange={setMintOpen} />
      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(next) => {
          if (!next) setRevokeTarget(null);
        }}
        title={t('platformPages.revokeTokenTitle')}
        description={t('platformPages.revokeTokenDescription', { name: revokeTarget?.name ?? '' })}
        confirmLabel={t('platformPages.revokeTokenTitle')}
        pending={revoke.isPending}
        onConfirm={() => {
          if (revokeTarget) revoke.mutate(revokeTarget.id);
        }}
      />
    </PageTransition>
  );
}
