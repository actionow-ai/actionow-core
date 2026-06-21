import { MusicNotesIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { useSetConsoleFilters } from '../../components/console/ConsoleChrome';
import { CardCollection } from '../../components/data/CardCollection';
import { CopyField } from '../../components/data/CopyField';
import { SelectField } from '../../components/ui/SelectField';
import { qk } from '../../lib/api/queryKeys';
import { useConsoleApi } from '../../lib/api/useConsoleApi';
import { useUrlState } from '../../lib/useUrlState';

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

  const [kind, setKind] = useUrlState('kind');
  const filter = kind === 'image' || kind === 'video' || kind === 'audio' ? kind : undefined;
  const files = useQuery({
    queryKey: qk.consoleFiles(filter),
    queryFn: () => api.listFiles(filter === undefined ? {} : { kind: filter }),
  });

  useSetConsoleFilters(
    () => (
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
    ),
    [t, kind, setKind],
  );

  return (
    <CardCollection
      rows={files.data?.rows ?? []}
      loading={files.isLoading}
      error={files.isError}
      onRetry={() => void files.refetch()}
      empty={t('app.media.empty')}
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
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : isAudio ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 'var(--s-3)',
                width: '100%',
                padding: 'var(--s-4)',
              }}
            >
              <MusicNotesIcon size={40} weight="duotone" style={{ color: 'var(--faint)' }} aria-hidden="true" />
              <audio src={f.url} controls preload="none" aria-label={kindLabel} style={{ width: '100%' }} />
            </div>
          ) : (
            <img
              src={f.url}
              alt={kindLabel}
              loading="lazy"
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
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
                <span
                  className="tabular"
                  style={{ fontSize: 'var(--fs-caption)', color: 'var(--faint)' }}
                >
                  {formatBytes(f.size)}
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
  );
}
