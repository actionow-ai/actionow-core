import { SignOutIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { Logo } from '../../components/brand/Logo';
import { AppBackground } from '../../components/glass/AppBackground';
import { LanguageSwitch } from '../../components/layout/LanguageSwitch';
import { ThemeToggle } from '../../components/layout/ThemeToggle';
import { Button } from '../../components/ui/Button';
import { useAuth } from '../../lib/auth/AuthProvider';

export function UserHome() {
  const { t } = useTranslation('console');
  const { logout } = useAuth();
  const navigate = useNavigate();
  return (
    <>
      <AppBackground />
      <div style={{ position: 'absolute', top: 'var(--s-4)', left: 'var(--s-4)', zIndex: 2 }}>
        <Logo />
      </div>
      <div style={{ position: 'absolute', top: 'var(--s-4)', right: 'var(--s-4)', zIndex: 2, display: 'flex', gap: 'var(--s-2)' }}>
        <LanguageSwitch />
        <ThemeToggle />
      </div>
      <div style={{ position: 'relative', zIndex: 1, minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--s-4)' }}>
        <div className="glass" style={{ borderRadius: 'var(--r-lg)', padding: 'var(--s-8)', textAlign: 'center', maxWidth: 460 }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>{t('app.soon')}</div>
          <p style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--muted)', marginTop: 'var(--s-3)' }}>{t('app.hint')}</p>
          <div style={{ marginTop: 'var(--s-5)', display: 'flex', justifyContent: 'center', gap: 'var(--s-2)' }}>
            <Button href="/" variant="ghost">
              {t('app.backHome')}
            </Button>
            <Button
              variant="cta"
              onClick={() => {
                logout();
                void navigate('/login', { replace: true });
              }}
            >
              <SignOutIcon size={15} /> {t('app.logout')}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
