import { ArrowRightIcon, BookOpenIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

import { Button } from '../ui/Button';

/** Clean code panel showing a real /v1/run call (no fake-terminal chrome). */
function CodePanel() {
  const { t } = useTranslation('landing');
  return (
    <div className="glass" style={{ borderRadius: 'var(--r-lg)', padding: 'var(--s-4)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--s-3)' }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.04em',
            color: 'var(--ink)',
            background: 'var(--accent)',
            padding: '3px 9px',
            borderRadius: 'var(--r-pill)',
          }}
        >
          POST /v1/run
        </span>
        <span style={{ fontSize: 11, color: 'var(--faint)' }}>{t('hero.codeCaption')}</span>
      </div>
      <pre className="mono" style={{ margin: 0, fontSize: 12.5, lineHeight: 1.75, color: 'var(--text)', overflowX: 'auto' }}>
        <code>
          <span style={{ color: 'var(--accent)' }}>curl</span> -X POST https://api.actionow.ai
          <span style={{ color: 'var(--accent-2)' }}>/v1/run/gpt-4o</span> {'\\'}
          {'\n'}  -H <span style={{ color: '#9bdcb0' }}>"Authorization: Bearer ak_•••"</span> {'\\'}
          {'\n'}  -d <span style={{ color: '#9bdcb0' }}>{'\'{"inputs":{"prompt":"你好"},'}</span>
          {'\n'}     <span style={{ color: '#9bdcb0' }}>{'"exec_mode":"stream"}\''}</span>
          {'\n'}
          {'\n'}<span style={{ color: 'var(--faint)' }}>→ delta… usage… done {'{'}cost:{'{'}credits{'}}'}</span>
        </code>
      </pre>
    </div>
  );
}

export function Hero() {
  const { t } = useTranslation('landing');
  return (
    <section
      style={{
        position: 'relative',
        zIndex: 1,
        maxWidth: 1200,
        margin: '0 auto',
        padding: 'var(--s-10) var(--s-4) var(--s-8)',
      }}
    >
      <div className="hero-grid" style={{ display: 'grid', gap: 'var(--s-10)', alignItems: 'center', width: '100%' }}>
        <div>
          <span
            className="glass"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              fontSize: 12,
              color: 'var(--text)',
              padding: '6px 13px',
              borderRadius: 'var(--r-pill)',
            }}
          >
            {t('hero.eyebrow')}
          </span>
          <h1
            style={{
              fontSize: 'clamp(34px, 5vw, 58px)',
              lineHeight: 1.1,
              fontWeight: 800,
              letterSpacing: '-0.025em',
              margin: 'var(--s-4) 0 0',
            }}
          >
            {t('hero.title1')}
            <span
              style={{
                background: 'linear-gradient(120deg, var(--accent), var(--accent-2))',
                WebkitBackgroundClip: 'text',
                backgroundClip: 'text',
                color: 'transparent',
              }}
            >
              {t('hero.titleHl')}
            </span>
            {t('hero.title2')}
          </h1>
          <p style={{ fontSize: 16, lineHeight: 1.6, color: 'var(--muted)', marginTop: 'var(--s-4)', maxWidth: 460 }}>
            {t('hero.lead')}
          </p>
          <div style={{ display: 'flex', gap: 'var(--s-3)', marginTop: 'var(--s-6)', flexWrap: 'wrap' }}>
            <Button to="/login" variant="cta" size="lg">
              {t('hero.ctaPrimary')} <ArrowRightIcon size={16} weight="bold" />
            </Button>
            <Button href="#" variant="ghost" size="lg">
              <BookOpenIcon size={16} /> {t('hero.ctaSecondary')}
            </Button>
          </div>
        </div>
        <CodePanel />
      </div>
    </section>
  );
}
