import { ArrowRightIcon, CheckCircleIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { Logo } from '../../components/brand/Logo';
import { AppBackground } from '../../components/glass/AppBackground';
import { Reveal } from '../../components/landing/Reveal';
import { LanguageSwitch } from '../../components/layout/LanguageSwitch';
import { ThemeToggle } from '../../components/layout/ThemeToggle';
import { Button } from '../../components/ui/Button';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { config } from '../../config';
import { ApiError } from '../../lib/api/errors';
import { useAuth } from '../../lib/auth/AuthProvider';
import { useMediaQuery } from '../../lib/useMediaQuery';

type Mode = 'login' | 'register';

function BrandPanel() {
  const { t } = useTranslation('console');
  const bullets = ['auth.b1', 'auth.b2', 'auth.b3'];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: 'var(--s-10)', height: '100%' }}>
      <Logo size={30} />
      <h1 style={{ fontSize: 'clamp(26px, 2.6vw, 36px)', fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.15, margin: 'var(--s-6) 0 0', maxWidth: 420 }}>
        {t('auth.brandTitle')}
      </h1>
      <p style={{ fontSize: 15, lineHeight: 1.6, color: 'var(--muted)', marginTop: 'var(--s-3)', maxWidth: 400 }}>{t('auth.brandLead')}</p>
      <ul style={{ listStyle: 'none', padding: 0, margin: 'var(--s-6) 0 0', display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
        {bullets.map((b) => (
          <li key={b} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, color: 'var(--text)' }}>
            <CheckCircleIcon size={18} weight="fill" style={{ color: 'var(--accent)', flexShrink: 0 }} />
            {t(b)}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AuthPage() {
  const { t } = useTranslation('console');
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const isDesktop = useMediaQuery('(min-width: 880px)');
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const user = mode === 'login' ? await login(email, password) : await register(email, password);
      toast(mode === 'register' ? t('auth.registered') : t('auth.loggedIn'));
      void navigate(user.role === 'admin' ? '/console/dashboard' : '/app', { replace: true });
    } catch (err) {
      if (err instanceof ApiError) toast(t(`errors.${err.code}`, t('auth.failed')), 'error');
      else toast(t('errors.network'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const card = (
    <Reveal style={{ width: 'min(400px, 92vw)' }}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="glass"
        style={{ padding: 'var(--s-6)', borderRadius: 'var(--r-lg)', display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}
      >
        {!isDesktop && <Logo size={28} />}

        {/* segmented login / register switch */}
        <div className="panel" style={{ display: 'flex', gap: 4, padding: 4, borderRadius: 'var(--r-pill)' }}>
          {(['login', 'register'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              style={{
                flex: 1,
                padding: '8px 0',
                borderRadius: 'var(--r-pill)',
                fontSize: 13,
                fontWeight: 600,
                border: 'none',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                transition: 'color 0.2s, background 0.2s',
                color: mode === m ? 'var(--ink)' : 'var(--muted)',
                background: mode === m ? 'linear-gradient(135deg, var(--accent), var(--accent-2))' : 'transparent',
              }}
            >
              {t(m === 'login' ? 'auth.loginTab' : 'auth.registerTab')}
            </button>
          ))}
        </div>

        <TextField label={t('auth.email')} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <TextField
          label={t('auth.password')}
          type="password"
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />

        <button
          type="submit"
          disabled={busy}
          className="btn-tactile cta-shine"
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
            whiteSpace: 'nowrap',
            opacity: busy ? 0.7 : 1,
          }}
        >
          {t(mode === 'login' ? 'auth.loginSubmit' : 'auth.registerSubmit')} <ArrowRightIcon size={16} weight="bold" />
        </button>

        {config.oauthEnabled && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-3)', color: 'var(--faint)', fontSize: 11 }}>
              <span style={{ flex: 1, height: 1, background: 'var(--panel-bd)' }} />
              {t('auth.or')}
              <span style={{ flex: 1, height: 1, background: 'var(--panel-bd)' }} />
            </div>
            <Button href={`${config.authBase}/oauth/google`} variant="ghost" size="lg">
              {t('auth.oauthGoogle')}
            </Button>
            <Button href={`${config.authBase}/oauth/github`} variant="ghost" size="lg">
              {t('auth.oauthGithub')}
            </Button>
          </>
        )}

        <div style={{ fontSize: 12.5, color: 'var(--muted)', textAlign: 'center' }}>
          {mode === 'login' ? t('auth.toRegister') : t('auth.toLogin')}{' '}
          <button
            type="button"
            onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
            style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 12.5, padding: 0, whiteSpace: 'nowrap' }}
          >
            {mode === 'login' ? t('auth.toRegisterCta') : t('auth.toLoginCta')}
          </button>
        </div>
      </form>
    </Reveal>
  );

  return (
    <>
      <AppBackground grid />
      <div style={{ position: 'absolute', top: 'var(--s-4)', right: 'var(--s-4)', zIndex: 2, display: 'flex', gap: 'var(--s-2)' }}>
        <LanguageSwitch />
        <ThemeToggle />
      </div>
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          minHeight: '100dvh',
          display: 'grid',
          gridTemplateColumns: isDesktop ? '1.15fr 0.85fr' : '1fr',
          alignItems: 'center',
        }}
      >
        {isDesktop && <BrandPanel />}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--s-4)' }}>{card}</div>
      </div>
    </>
  );
}
