import type {
  ConsoleFileView,
  FileView,
  PresignUploadResult,
  StorageUsageView,
} from '@actionow/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Database, ExternalLink, Files, HardDrive, Timer, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { apiFetch, toApiStateError } from '@/api/client';
import { useCursorQuery } from '@/api/hooks';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { DateTimeText } from '@/components/common/date-time-text';
import { LoadMore } from '@/components/common/load-more';
import { ApiErrorNotice, ResourceLoading } from '@/components/shell/api-state';
import { EmptyState, PageHeader, PageTransition, StatCard } from '@/components/shell/page';
import { Button } from '@/components/ui/components/buttons/button';
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
import { FileInput } from '@/components/ui/input';

const fileStatusVariant: Record<string, 'success' | 'warning' | 'neutral'> = {
  ready: 'success',
  pending: 'warning',
};

const fileStatusKey: Record<string, string> = {
  ready: 'tenantOps.fileStatusReady',
  pending: 'tenantOps.fileStatusPending',
};

function formatBytes(size: number | null | undefined): string {
  if (size === null || size === undefined) return '—';
  if (size < 1024) return `${String(size)} B`;
  const kb = size / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

export function FilesPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);

  const usage = useQuery({
    queryKey: ['console', 'files', 'usage'],
    queryFn: () => apiFetch<StorageUsageView>('/console/files/usage'),
  });
  const files = useCursorQuery<ConsoleFileView>({
    key: ['console', 'files', 'list'],
    path: '/console/files',
    limit: 20,
  });

  const [uploading, setUploading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ConsoleFileView | null>(null);

  const remove = useMutation({
    mutationFn: (id: string) => apiFetch<undefined>(`/console/files/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ['console', 'files'] });
    },
    onError: (error) => {
      setActionError(toApiStateError(error).message);
    },
    onSettled: () => {
      setPendingDelete(null);
    },
  });

  const uploadFile = async (file: File) => {
    setUploading(true);
    setActionError(null);
    try {
      const contentType = file.type || 'application/octet-stream';
      const presign = await apiFetch<PresignUploadResult>('/console/files/presign-upload', {
        method: 'POST',
        body: { filename: file.name, content_type: contentType, size: file.size },
      });
      const put = await fetch(presign.upload_url, {
        method: 'PUT',
        headers: { 'content-type': contentType },
        body: file,
      });
      if (!put.ok) throw new Error(`${t('tenantOps.uploadFailed')}: HTTP ${String(put.status)}`);
      await apiFetch<FileView>(`/console/files/${presign.file_id}/confirm`, { method: 'POST' });
      await queryClient.invalidateQueries({ queryKey: ['console', 'files'] });
    } catch (error) {
      setActionError(toApiStateError(error).message);
    } finally {
      setUploading(false);
    }
  };

  const onFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void uploadFile(file);
  };

  const triggerUpload = () => {
    inputRef.current?.click();
  };

  return (
    <PageTransition>
      <PageHeader
        title={t('tenantOps.filesTitle')}
        description={t('tenantOps.filesDescription')}
        actions={
          <>
            <FileInput
              ref={inputRef}
              onChange={onFileChange}
              disabled={uploading}
              aria-label={t('tenantOps.upload')}
            />
            {uploading ? <Badge variant="warning">{t('tenantOps.uploading')}</Badge> : null}
            <Button onClick={triggerUpload} disabled={uploading}>
              <Upload />
              {uploading ? t('tenantOps.uploading') : t('tenantOps.upload')}
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title={t('tenantOps.statUsage')}
          detail={t('tenantOps.statUsageDetail')}
          value={usage.data ? formatBytes(usage.data.bytes) : '—'}
          icon={HardDrive}
          emphasis
          loading={usage.isLoading}
        />
        <StatCard
          title={t('tenantOps.statCount')}
          detail={t('tenantOps.statCountDetail')}
          value={usage.data ? String(usage.data.count) : '—'}
          icon={Files}
          loading={usage.isLoading}
        />
        <StatCard
          title={t('tenantOps.statQuota')}
          detail={t('tenantOps.statQuotaDetail')}
          value={
            usage.data
              ? usage.data.quota_bytes === null
                ? t('tenantOps.noQuota')
                : formatBytes(usage.data.quota_bytes)
              : '—'
          }
          icon={Database}
          loading={usage.isLoading}
        />
        <StatCard
          title={t('tenantOps.statTtl')}
          detail={t('tenantOps.statTtlDetail')}
          value={
            usage.data
              ? usage.data.effective_ttl_days === null
                ? t('tenantOps.retainForever')
                : t('tenantOps.ttlDays', { days: usage.data.effective_ttl_days })
              : '—'
          }
          icon={Timer}
          loading={usage.isLoading}
        />
      </div>

      {usage.isError ? (
        <ApiErrorNotice
          className="mt-4"
          error={toApiStateError(usage.error)}
          onRetry={() => void usage.refetch()}
        />
      ) : null}
      {actionError ? <ApiErrorNotice className="mt-4" error={{ message: actionError }} /> : null}

      <Card className="mt-6">
        <DataTableToolbar
          title={t('tenantOps.filesList')}
          onRefresh={() => {
            void usage.refetch();
            void files.refetch();
          }}
          refreshing={files.isRefetching}
        />
        {files.isLoading ? (
          <div className="p-4">
            <ResourceLoading rows={4} />
          </div>
        ) : files.isError ? (
          <div className="p-4">
            <ApiErrorNotice
              error={toApiStateError(files.error)}
              onRetry={() => void files.refetch()}
            />
          </div>
        ) : files.rows.length === 0 ? (
          <EmptyState
            icon={Files}
            title={t('tenantOps.filesEmptyTitle')}
            description={t('tenantOps.filesEmptyDescription')}
            action={
              <Button onClick={triggerUpload} disabled={uploading}>
                <Upload />
                {uploading ? t('tenantOps.uploading') : t('tenantOps.upload')}
              </Button>
            }
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <DataTable>
                <DataTableHeader>
                  <DataTableRow>
                    <DataTableHead>{t('tenantOps.colFile')}</DataTableHead>
                    <DataTableHead>{t('tenantOps.colType')}</DataTableHead>
                    <DataTableHead>{t('tenantOps.colSize')}</DataTableHead>
                    <DataTableHead>{t('common.status')}</DataTableHead>
                    <DataTableHead>{t('common.createdAt')}</DataTableHead>
                    <DataTableHead className="text-right">{t('common.actions')}</DataTableHead>
                  </DataTableRow>
                </DataTableHeader>
                <DataTableBody>
                  {files.rows.map((row) => {
                    const statusKey = fileStatusKey[row.status];
                    return (
                      <DataTableRow key={row.id}>
                        <DataTableCell className="font-mono text-sm">
                          {row.id.slice(0, 8)}
                        </DataTableCell>
                        <DataTableCell className="text-muted-foreground">
                          {row.content_type ?? '—'}
                        </DataTableCell>
                        <DataTableCell className="font-mono tabular-nums">
                          {formatBytes(row.size)}
                        </DataTableCell>
                        <DataTableCell>
                          <Badge variant={fileStatusVariant[row.status] ?? 'neutral'}>
                            {statusKey ? t(statusKey) : row.status}
                          </Badge>
                        </DataTableCell>
                        <DataTableCell>
                          <DateTimeText value={row.created_at} className="text-muted-foreground" />
                        </DataTableCell>
                        <DataTableCell className="text-right">
                          <div className="inline-flex items-center gap-1">
                            {row.url ? (
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                asChild
                                aria-label={t('tenantOps.openFile')}
                              >
                                <a href={row.url} target="_blank" rel="noreferrer">
                                  <ExternalLink />
                                </a>
                              </Button>
                            ) : null}
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={t('common.delete')}
                              onClick={() => setPendingDelete(row)}
                            >
                              <Trash2 />
                            </Button>
                          </div>
                        </DataTableCell>
                      </DataTableRow>
                    );
                  })}
                </DataTableBody>
              </DataTable>
            </div>
            <div className="border-t px-4 pb-3">
              <LoadMore
                count={files.rows.length}
                hasMore={files.hasNextPage}
                loading={files.isFetchingNextPage}
                onLoadMore={() => void files.fetchNextPage()}
              />
            </div>
          </>
        )}
      </Card>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title={t('tenantOps.deleteFileTitle')}
        description={t('tenantOps.deleteFileDescription')}
        confirmLabel={t('common.delete')}
        pending={remove.isPending}
        onConfirm={() => {
          if (pendingDelete) remove.mutate(pendingDelete.id);
        }}
      />
    </PageTransition>
  );
}
