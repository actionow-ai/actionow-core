import { useTranslation } from 'react-i18next';

import { Pill } from '../../components/ui/Pill';
import type { ModelTestResult } from '../../lib/api/types';

/**
 * Renders the two-leg model probe result (connectivity + functional) inside the
 * {@link ModelEditor} add flow. `functional.ok` is the gate the editor keys on;
 * this is purely the visual summary — a Pill per leg, the upstream message, and
 * a success sample (text excerpt or an image thumbnail).
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
        <img
          src={result.sample.url}
          alt={t('models.test.sample')}
          style={{
            maxWidth: '100%',
            maxHeight: 160,
            borderRadius: 'var(--r-md)',
            objectFit: 'contain',
          }}
        />
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
