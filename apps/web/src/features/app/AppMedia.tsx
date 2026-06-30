import { MusicNotesIcon, TrashIcon, UploadSimpleIcon } from '@phosphor-icons/react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSetConsoleAction, useSetConsoleFilters } from '../../components/console/ConsoleChrome';
import { CardCollection } from '../../components/data/CardCollection';
import { CopyField } from '../../components/data/CopyField';
import { LoadMore } from '../../components/data/LoadMore';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { IconButton } from '../../components/ui/IconButton';
import { SelectField } from '../../components/ui/SelectField';
import { toast } from '../../components/ui/toast';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { ConsoleFileView, StorageUsageView } from '../../lib/api/types';
import { useConsoleApi } from '../../lib/api/useConsoleApi';
import { useUrlState } from '../../lib/useUrlState';
import { AdminOnlyNote } from './AdminOnlyNote';
import { useTenantRole } from './useTenantRole';

/** Human-readable byte size (1 KB = 1024 B); `—` when the size is unknown. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i] ?? 'KB'}`;
}

/**
 * The tenant asset gallery (`/app/media`): a card grid of the tenant's READY
 * media files — uploaded assets and generated images/videos persisted to object
 * storage — newest-first, optionally narrowed to a media kind. Each card shows a
 * viewable preview (the image/first video frame), the size + date, and a
 * copy-URL field. Closes the loop on the relay: generated media is now browsable.
 */
export function AppMedia() {
  const { t } = useTranslation('console');
  const api = useConsoleApi();
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  // RBAC v1: upload is an admin-only write; a member browses the gallery read-only.
  const { isTenantAdmin } = useTenantRole();

  const [kind, setKind] = useUrlState('kind');
  const [deleteTarget, setDeleteTarget] = useState<ConsoleFileView | null>(null);
  const filter = kind === 'image' || kind === 'video' || kind === 'audio' ? kind : undefined;
  const files = useInfiniteQuery({
    queryKey: qk.consoleFiles(filter),
    queryFn: ({ pageParam }) => api.listFiles({ kind: filter, cursor: pageParam, limit: 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = files.data?.pages.flatMap((p) => p.rows) ?? [];

  // Object-storage usage + quota (drives the quota bar). Cheap single read.
  const usage = useQuery({
    queryKey: qk.consoleFilesUsage(),
    queryFn: () => api.filesUsage(),
  });

  // Invalidate both the file lists and the usage totals after a write.
  const refreshFiles = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: qk.consoleFiles() }),
      qc.invalidateQueries({ queryKey: qk.consoleFilesUsage() }),
    ]);

  // Upload: presign → PUT the bytes straight to object storage → confirm
  // (head → ready). The bytes never transit the API.
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const ct = file.type === '' ? 'application/octet-stream' : file.type;
      const grant = await api.presignUpload({
        filename: file.name,
        content_type: ct,
        size: file.size,
      });
      const put = await fetch(grant.upload_url, {
        method: 'PUT',
        body: file,
        headers: { 'content-type': ct },
      });
      if (!put.ok) throw new Error(`upload failed (${String(put.status)})`);
      await api.confirmFile(grant.file_id);
    },
    onSuccess: async () => {
      await refreshFiles();
      toast(t('app.media.uploaded'));
    },
    onError: mutationError(t),
  });

  // Delete a file (admin-only): tombstone the reference + remove the object.
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteFile(id),
    onSuccess: async () => {
      await refreshFiles();
      toast(t('app.media.deleted'));
      setDeleteTarget(null);
    },
    onError: mutationError(t),
  });

  useSetConsoleAction(
    () =>
      isTenantAdmin ? (
        <>
          <input
            ref={fileInput}
            type="file"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f !== undefined) upload.mutate(f);
              e.target.value = '';
            }}
          />
          <Button
            variant="ghost"
            onClick={() => fileInput.current?.click()}
            loading={upload.isPending}
          >
            <UploadSimpleIcon size={14} weight="bold" /> {t('app.media.upload')}
          </Button>
        </>
      ) : null,
    [t, upload.isPending, isTenantAdmin],
  );

  useSetConsoleFilters(
    () => (
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--s-2)' }}>
        <div style={{ width: 160 }}>
          <SelectField
            label={t('app.media.kindLabel')}
            value={kind}
            onChange={setKind}
            options={[
              { value: 'image', label: t('app.media.kind.image') },
              { value: 'video', label: t('app.media.kind.video') },
              { value: 'audio', label: t('app.media.kind.audio') },
            ]}
            placeholder={t('app.media.allKinds')}
          />
        </div>
        {filter && (
          <Button variant="ghost" size="sm" onClick={() => setKind('')}>
            {t('app.media.clearFilter')}
          </Button>
        )}
      </div>
    ),
    [t, kind, setKind],
  );

  return (
    <>
      {!isTenantAdmin && (
        <div style={{ marginBottom: 'var(--s-3)' }}>
          <AdminOnlyNote />
        </div>
      )}
      {usage.data !== undefined && <StorageQuotaBar usage={usage.data} />}
      <CardCollection
        rows={rows}
        loading={files.isLoading}
        error={files.isError}
        onRetry={() => void files.refetch()}
        empty={
          filter
            ? t('app.media.emptyKind', { kind: t(`app.media.kind.${filter}`) })
            : t('app.media.empty')
        }
        renderCard={(f) => {
          const ct = f.content_type;
          const isVideo = ct?.startsWith('video/') ?? false;
          const isImage = ct?.startsWith('image/') ?? false;
          const isAudio = ct?.startsWith('audio/') ?? false;
          const kindLabel = isVideo
            ? t('app.media.kind.video')
            : isAudio
              ? t('app.media.kind.audio')
              : isImage
                ? t('app.media.kind.image')
                : t('app.media.kind.file');

          const previewStyle = {
            aspectRatio: '1 / 1',
            background: 'var(--glass-bg)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
          } as const;
          const previewInner =
            f.url === null ? (
              <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--faint)' }}>
                {t('app.media.noPreview')}
              </span>
            ) : isVideo ? (
              <video
                src={f.url}
                muted
                playsInline
                preload="metadata"
                aria-label={kindLabel}
                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
              />
            ) : isAudio ? (
              <div
                style={{
                  width: '100%',
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 'var(--s-2)',
                  padding: 'var(--s-3)',
                }}
              >
                <MusicNotesIcon
                  size={40}
                  weight="duotone"
                  style={{ color: 'var(--faint)' }}
                  aria-hidden="true"
                />
                <audio
                  src={f.url}
                  controls
                  preload="none"
                  aria-label={kindLabel}
                  style={{ width: '100%', marginTop: 'auto' }}
                />
              </div>
            ) : (
              <img
                src={f.url}
                alt={kindLabel}
                loading="lazy"
                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
              />
            );

          return (
            <div
              key={f.id}
              style={{
                border: '1px solid var(--panel-bd)',
                borderRadius: 'var(--r-lg)',
                overflow: 'hidden',
                background: 'var(--panel-bg)',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              {f.url === null || isAudio ? (
                // Audio plays inline — don't wrap the controls in a click-to-open link.
                <div style={previewStyle}>{previewInner}</div>
              ) : (
                <a href={f.url} target="_blank" rel="noreferrer" style={previewStyle}>
                  {previewInner}
                </a>
              )}

              <div
                style={{
                  padding: 'var(--s-3)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--s-2)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 'var(--s-2)',
                  }}
                >
                  <span className="chip">{kindLabel}</span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-2)' }}>
                    <span
                      className="tabular"
                      style={{ fontSize: 'var(--fs-caption)', color: 'var(--faint)' }}
                    >
                      {formatBytes(f.size)}
                    </span>
                    {isTenantAdmin && (
                      <IconButton
                        icon={TrashIcon}
                        label={t('app.media.delete')}
                        bare
                        size={16}
                        onClick={() => setDeleteTarget(f)}
                      />
                    )}
                  </span>
                </div>
                <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--faint)' }}>
                  {new Date(f.created_at).toLocaleString()}
                </div>
                {f.url !== null && (
                  <CopyField
                    value={f.url}
                    copyLabel={t('app.media.copyUrl')}
                    copiedLabel={t('app.media.copied')}
                  />
                )}
              </div>
            </div>
          );
        }}
      />
      <LoadMore
        hasNextPage={files.hasNextPage}
        isFetchingNextPage={files.isFetchingNextPage}
        onLoadMore={() => void files.fetchNextPage()}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        title={t('app.media.confirmDeleteTitle')}
        message={t('app.media.confirmDeleteMsg')}
        confirmLabel={t('app.media.delete')}
        cancelLabel={t('common.cancel')}
        danger
        loading={remove.isPending}
        onConfirm={() => {
          if (deleteTarget !== null) remove.mutate(deleteTarget.id);
        }}
        onClose={() => setDeleteTarget(null)}
      />
    </>
  );
}

/**
 * The asset-gallery storage usage/quota bar. Shows live bytes + file count, the
 * effective per-tenant quota (a progress bar that escalates ok → amber at 80% →
 * red at/over cap; or "no quota" when uncapped), and the opt-in file-lifecycle
 * TTL ("retain forever" when unset).
 */
function StorageQuotaBar({ usage }: { usage: StorageUsageView }) {
  const { t } = useTranslation('console');
  const quota = usage.quota_bytes;
  const capped = quota !== null && quota > 0;
  const ratio = quota !== null && quota > 0 ? Math.min(1, usage.bytes / quota) : 0;
  const pct = Math.round(ratio * 100);
  const tone = ratio >= 1 ? 'var(--fail)' : ratio >= 0.8 ? 'var(--run)' : 'var(--ok)';

  return (
    <div
      className="panel"
      style={{
        borderRadius: 'var(--r-md)',
        padding: 'var(--s-3)',
        marginBottom: 'var(--s-3)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--s-2)',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 'var(--s-2)',
          fontSize: 'var(--fs-caption)',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ color: 'var(--muted)' }}>
          {t('app.media.storage')}
          <span style={{ color: 'var(--faint)' }}>
            {' · '}
            {t('app.media.fileCount', { n: usage.count })}
          </span>
        </span>
        <span className="tabular" style={{ color: 'var(--text)' }}>
          {formatBytes(usage.bytes)}
          {capped ? (
            <>
              {' / '}
              {formatBytes(usage.quota_bytes)}
              <span style={{ color: 'var(--faint)' }}> ({pct}%)</span>
            </>
          ) : (
            <span style={{ color: 'var(--faint)' }}> · {t('app.media.noQuota')}</span>
          )}
        </span>
      </div>
      {capped && (
        <div
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          style={{
            height: 6,
            borderRadius: 999,
            background: 'var(--hairline)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${String(Math.max(2, pct))}%`,
              height: '100%',
              background: tone,
              borderRadius: 999,
              transition: 'width .3s ease',
            }}
          />
        </div>
      )}
      <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--faint)' }}>
        {usage.effective_ttl_days === null
          ? t('app.media.ttlForever')
          : t('app.media.ttlDays', { days: usage.effective_ttl_days })}
      </div>
    </div>
  );
}
