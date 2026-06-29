import { useTranslation } from 'react-i18next';

import { Pill } from '../../components/ui/Pill';
import type { ModelTestResult } from '../../lib/api/types';

/**
 * Renders the two-leg model probe result (connectivity + functional) inside the
 * {@link ModelEditor} add flow. `functional.ok` is the gate the editor keys on;
 * this is purely the visual summary — a Pill per leg, the upstream message, and
 * a success sample. The sample is modality-aware: an STT/text excerpt renders as
 * text, while an asset URL renders as an image / video / audio player keyed off
 * `result.modality` (an audio TTS sample is playable, not a broken `<img>`).
 */
export function ModelTestPanel({ result }: { result: ModelTestResult }) {
  const { t } = useTranslation('console');
  return (
    <div
      className="panel"
      style={{
        padding: 'var(--s-3)',
        borderRadius: 'var(--r-md)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--s-3)',
      }}
    >
      <Leg
        label={t('models.test.connectivity')}
        ok={result.connectivity.ok}
        message={result.connectivity.message}
      />
      <Leg
        label={t('models.test.functional')}
        ok={result.functional.ok}
        message={result.functional.message}
      />

      {result.sample?.text !== undefined && (
        <pre
          className="mono"
          style={{
            margin: 0,
            fontSize: 'var(--fs-sm)',
            whiteSpace: 'pre-wrap',
            color: 'var(--text)',
          }}
        >
          {result.sample.text}
        </pre>
      )}
      {result.sample?.url !== undefined && (
        <SampleAsset modality={result.modality} url={result.sample.url} />
      )}

      <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--muted)' }}>
        {t('models.test.meta', {
          provider: result.providerType,
          channel: result.channelId,
          ms: result.elapsedMs,
        })}
      </div>
    </div>
  );
}

/** The success sample asset, rendered per modality (image thumbnail / video / audio player). */
function SampleAsset({ modality, url }: { modality: string; url: string }) {
  const { t } = useTranslation('console');
  const box = {
    maxWidth: '100%',
    maxHeight: 160,
    borderRadius: 'var(--r-md)',
  } as const;
  if (modality === 'video') {
    return (
      <video
        src={url}
        controls
        preload="metadata"
        aria-label={t('models.test.sample')}
        style={box}
      />
    );
  }
  if (modality === 'audio') {
    return (
      <audio
        src={url}
        controls
        preload="none"
        aria-label={t('models.test.sample')}
        style={{ width: '100%' }}
      />
    );
  }
  return <img src={url} alt={t('models.test.sample')} style={{ ...box, objectFit: 'contain' }} />;
}

function Leg({ label, ok, message }: { label: string; ok: boolean; message: string }) {
  const { t } = useTranslation('console');
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--s-3)' }}>
      <span style={{ minWidth: 72, fontWeight: 'var(--fw-medium)' }}>{label}</span>
      <Pill tone={ok ? 'ok' : 'fail'} dot>
        {ok ? t('models.test.pass') : t('models.test.failLeg')}
      </Pill>
      <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--muted)' }}>{message}</span>
    </div>
  );
}
