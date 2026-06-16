import { ArrowRightIcon, BookOpenIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

import { Button } from '../ui/Button';

/** OpenAI-compatible relay snippet: same SDK, your own base_url (no fake terminal). */
function CodePanel() {
  const { t } = useTranslation('landing');
  return (
    <div className="glass" style={{ borderRadius: 'var(--r-lg)', padding: 'var(--s-4)' }}>
      <div className="mono" style={{ fontSize: 11, color: 'var(--faint)', marginBottom: 'var(--s-3)' }}>openai-python</div>
      <pre className="mono" style={{ margin: 0, fontSize: 12.5, lineHeight: 1.8, color: 'var(--text)', overflowX: 'auto' }}>
        <code>
          <span style={{ color: 'var(--faint)' }}>from</span> openai <span style={{ color: 'var(--faint)' }}>import</span> OpenAI
          {'\n\n'}client = OpenAI(
          {'\n'}  base_url=<span style={{ color: 'var(--accent)' }}>"https://your-host/v1"</span>,
          {'\n'}  api_key=<span style={{ color: '#9bdcb0' }}>"ak_•••"</span>,
          {'\n'})
          {'\n'}client.chat.completions.create(
          {'\n'}  model=<span style={{ color: '#9bdcb0' }}>"gpt-4o"</span>, messages=[...],
          {'\n'})
        </code>
      </pre>
      <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 'var(--s-3)' }}>{t('hero.codeCaption')}</div>
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
          <h1
            style={{
              fontSize: 'clamp(32px, 5vw, 56px)',
              lineHeight: 1.12,
              fontWeight: 800,
              letterSpacing: '-0.025em',
              margin: 0,
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
          <p style={{ fontSize: 16, lineHeight: 1.6, color: 'var(--muted)', marginTop: 'var(--s-4)', maxWidth: 500 }}>
            {t('hero.lead')}
          </p>
          <div style={{ display: 'flex', gap: 'var(--s-3)', marginTop: 'var(--s-6)', flexWrap: 'wrap' }}>
            <Button to="/console" variant="cta" size="lg">
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
