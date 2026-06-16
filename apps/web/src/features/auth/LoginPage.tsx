import { ArrowRightIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { AppBackground } from '../../components/glass/AppBackground';
import { LanguageSwitch } from '../../components/layout/LanguageSwitch';
import { ThemeToggle } from '../../components/layout/ThemeToggle';
import { toast } from '../../components/ui/toast';
import { ApiError, NotAdminError } from '../../lib/api/errors';
import { useAuth } from '../../lib/auth/AuthProvider';

export function LoginPage() {
  const { t } = useTranslation('console');
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await login(email, password);
      void navigate('/console/dashboard', { replace: true });
    } catch (err) {
      if (err instanceof NotAdminError) toast(t('auth.notAdmin'), 'error');
      else if (err instanceof ApiError) toast(t(`errors.${err.code}`, t('auth.failed')), 'error');
      else toast(t('errors.network'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <AppBackground />
      <div style={{ position: 'absolute', top: 'var(--s-4)', right: 'var(--s-4)', zIndex: 2, display: 'flex', gap: 'var(--s-2)' }}>
        <LanguageSwitch />
        <ThemeToggle />
      </div>
      <div style={{ position: 'relative', zIndex: 1, minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--s-4)' }}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="glass"
          style={{ width: 'min(380px, 92vw)', padding: 'var(--s-6)', borderRadius: 'var(--r-lg)', display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}
        >
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{t('auth.title')}</h1>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
            {t('auth.email')}
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="panel"
              style={{ fontSize: 13, color: 'var(--text)', padding: '10px 12px', borderRadius: 'var(--r-sm)', outline: 'none' }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
            {t('auth.password')}
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="panel"
              style={{ fontSize: 13, color: 'var(--text)', padding: '10px 12px', borderRadius: 'var(--r-sm)', outline: 'none' }}
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="btn-tactile"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              fontSize: 14,
              fontWeight: 650,
              color: 'var(--ink)',
              background: 'linear-gradient(135deg, var(--accent), var(--accent-2))',
              border: 'none',
              borderRadius: 'var(--r-pill)',
              padding: '12px 22px',
              cursor: 'pointer',
              boxShadow: '0 6px 18px rgba(255,176,10,.4)',
              opacity: busy ? 0.7 : 1,
            }}
          >
            {t('auth.submit')} <ArrowRightIcon size={16} weight="bold" />
          </button>
        </form>
      </div>
    </>
  );
}
