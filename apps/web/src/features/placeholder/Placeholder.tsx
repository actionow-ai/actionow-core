import { ArrowLeftIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

import { AppBackground } from '../../components/glass/AppBackground';
import { Button } from '../../components/ui/Button';

export function Placeholder() {
  const { t } = useTranslation();
  return (
    <>
      <AppBackground />
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          minHeight: '100dvh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 'var(--s-4)',
        }}
      >
        <div className="glass" style={{ borderRadius: 'var(--r-lg)', padding: 'var(--s-10)', textAlign: 'center', maxWidth: 420 }}>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{t('comingSoon')}</div>
          <p style={{ fontSize: 13.5, color: 'var(--muted)', marginTop: 'var(--s-3)' }}>{t('comingSoonHint')}</p>
          <div style={{ marginTop: 'var(--s-5)', display: 'flex', justifyContent: 'center' }}>
            <Button to="/" variant="ghost">
              <ArrowLeftIcon size={16} /> {t('backHome')}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
