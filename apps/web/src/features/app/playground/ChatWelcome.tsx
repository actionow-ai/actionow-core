import { ArrowUpRightIcon, CubeIcon, SparkleIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import { RoseLoader } from '../../../components/ui/RoseLoader';

/** Four concrete starter prompts (i18n) shown as click-to-send chips. */
const EXAMPLE_KEYS = ['examples.0', 'examples.1', 'examples.2', 'examples.3'] as const;

/**
 * The chat canvas before any turn: a composed welcome (not a barren void). Three
 * states — `loading` while models resolve, `noModels` with a populate-path CTA,
 * and `ready` with a model-aware heading + click-to-send starter prompts.
 */
export function ChatWelcome({
  state,
  modelLabel,
  onPick,
}: {
  state: 'loading' | 'noModels' | 'ready';
  modelLabel: string;
  onPick: (prompt: string) => void;
}) {
  const { t } = useTranslation('console');

  if (state === 'loading') {
    return (
      <Center>
        <RoseLoader size={40} />
      </Center>
    );
  }

  if (state === 'noModels') {
    return (
      <Center>
        <Badge icon={<CubeIcon size={26} weight="duotone" />} />
        <h2 style={titleStyle}>{t('playground.welcome.noModelsTitle')}</h2>
        <p style={bodyStyle}>{t('playground.noModels')}</p>
        <Link
          to="/app/models"
          className="btn"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-1)' }}
        >
          {t('playground.welcome.browseModels')}
          <ArrowUpRightIcon size={14} weight="bold" aria-hidden="true" />
        </Link>
      </Center>
    );
  }

  return (
    <Center>
      <Badge icon={<SparkleIcon size={26} weight="fill" />} accent />
      <h2 style={titleStyle}>{t('playground.welcome.title', { model: modelLabel })}</h2>
      <p style={bodyStyle}>{t('playground.welcome.body')}</p>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: 'var(--s-2)',
          width: '100%',
          maxWidth: 540,
          marginTop: 'var(--s-2)',
        }}
      >
        {EXAMPLE_KEYS.map((k) => {
          const prompt = t(`playground.${k}`);
          return (
            <button
              key={k}
              type="button"
              onClick={() => onPick(prompt)}
              style={{
                textAlign: 'left',
                border: '1px solid var(--panel-bd)',
                background: 'var(--panel-bg)',
                borderRadius: 'var(--r-md)',
                padding: 'var(--s-2) var(--s-3)',
                color: 'var(--muted)',
                fontSize: 'var(--fs-sm)',
                lineHeight: 1.5,
                cursor: 'pointer',
                transition:
                  'border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--accent)';
                e.currentTarget.style.color = 'var(--text)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--panel-bd)';
                e.currentTarget.style.color = 'var(--muted)';
              }}
            >
              {prompt}
            </button>
          );
        })}
      </div>
    </Center>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ height: '100%', display: 'grid', placeItems: 'center', padding: 'var(--s-5)' }}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 'var(--s-3)',
          textAlign: 'center',
          maxWidth: 560,
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** The circular icon badge — a soft glass disc, optionally accent-tinted. */
function Badge({ icon, accent }: { icon: React.ReactNode; accent?: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 56,
        height: 56,
        borderRadius: 'var(--r-lg)',
        display: 'grid',
        placeItems: 'center',
        background: 'var(--glass-bg)',
        border: '1px solid var(--panel-bd)',
        color: accent === true ? 'var(--accent)' : 'var(--muted)',
      }}
    >
      {icon}
    </span>
  );
}

const titleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 'var(--fs-lg)',
  fontWeight: 'var(--fw-semibold)',
  color: 'var(--text)',
};
const bodyStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 'var(--fs-sm)',
  color: 'var(--faint)',
  maxWidth: '42ch',
  lineHeight: 1.6,
};
