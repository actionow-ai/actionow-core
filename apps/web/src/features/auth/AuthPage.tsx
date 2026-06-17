import { ArrowRightIcon, CheckCircleIcon } from '@phosphor-icons/react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { Logo } from '../../components/brand/Logo';
import { AppBackground } from '../../components/glass/AppBackground';
import { FlipWords } from '../../components/landing/FlipWords';
import { LanguageSwitch } from '../../components/layout/LanguageSwitch';
import { ThemeToggle } from '../../components/layout/ThemeToggle';
import { Button } from '../../components/ui/Button';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { config } from '../../config';
import { ApiError } from '../../lib/api/errors';
import { useAuth } from '../../lib/auth/AuthProvider';
import { BP } from '../../lib/breakpoints';
import { gsap, useGSAP } from '../../lib/motion/gsap';
import { useReducedMotion } from '../../lib/motion/useReducedMotion';
import { useMediaQuery } from '../../lib/useMediaQuery';

type Mode = 'login' | 'register';

/** Provider-agnostic, full-modal sample telemetry — the live tail in the brand panel. */
const LOG = [
  'chat.completions · gpt-4o · 200',
  'images.generations · flux · 200',
  'video.generations · veo · 202',
  'audio.speech · tts-1 · 200',
];

function BrandPanel() {
  const { t } = useTranslation(['console', 'landing']);
  const bullets = ['auth.b1', 'auth.b2', 'auth.b3'];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-5)' }}>
      <div data-reveal>
        <Logo size={30} />
      </div>
      <h1
        data-reveal
        className="headline-nowrap"
        style={{ fontSize: 'var(--fs-h1)', fontWeight: 850, letterSpacing: '-0.035em', lineHeight: 1.04, margin: 0 }}
      >
        {t('landing:hero.title1')}
        <FlipWords
          words={t('landing:hero.flip', { returnObjects: true }) as string[]}
          style={{
            background: 'linear-gradient(120deg, var(--accent), var(--accent-2))',
            WebkitBackgroundClip: 'text',
            backgroundClip: 'text',
            color: 'transparent',
          }}
        />
        {t('landing:hero.title2')}
      </h1>
      <p data-reveal style={{ fontSize: 'var(--fs-base)', lineHeight: 1.6, color: 'var(--muted)', margin: 0, maxWidth: 440 }}>
        {t('auth.brandLead')}
      </p>

      <ul data-reveal style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
        {bullets.map((b) => (
          <li key={b} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 'var(--fs-sm)', color: 'var(--text)' }}>
            <CheckCircleIcon size={17} weight="fill" style={{ color: 'var(--accent)', flexShrink: 0 }} />
            {t(b)}
          </li>
        ))}
      </ul>

      {/* live mini console — what you're signing into */}
      <div data-reveal className="glass" style={{ borderRadius: 'var(--r-lg)', padding: 'var(--s-4) var(--s-5)', maxWidth: 420 }}>
        <div style={{ fontSize: 'var(--fs-micro)', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--faint)', marginBottom: 'var(--s-3)' }}>
          {t('landing:live.logTitle')}
        </div>
        <div className="mono" style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 'var(--fs-sm)', lineHeight: 1.5, color: 'var(--log-ok)' }}>
          {LOG.map((l) => (
            <span data-log key={l} style={{ whiteSpace: 'nowrap' }}>
              <span style={{ color: 'var(--faint)' }}>POST </span>
              {l}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export function AuthPage() {
  const { t } = useTranslation('console');
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const isDesktop = useMediaQuery(BP.wide);
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();

  useGSAP(
    () => {
      if (reduced || !root.current) return;
      gsap.from(root.current.querySelectorAll('[data-reveal]'), {
        opacity: 0,
        y: 24,
        duration: 0.55,
        ease: 'power3.out',
        stagger: 0.07,
      });
      // live tail in the brand panel
      gsap.fromTo(
        root.current.querySelectorAll('[data-log]'),
        { opacity: 0.25 },
        { opacity: 1, duration: 0.3, ease: 'none', delay: 0.5, stagger: { each: 0.45, repeat: -1, yoyo: true, repeatDelay: 1.4 } },
      );
    },
    { scope: root, dependencies: [reduced] },
  );

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
    <div data-reveal style={{ width: 'min(400px, 92vw)' }}>
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
                fontSize: 'var(--fs-sm)',
                fontWeight: 600,
                border: 'none',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                transition: 'color 0.2s, background 0.2s',
                color: mode === m ? 'var(--ink)' : 'var(--muted)',
                background: mode === m ? 'var(--grad-accent)' : 'transparent',
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

        <Button variant="cta" size="lg" type="submit" disabled={busy} className="cta-shine">
          {t(mode === 'login' ? 'auth.loginSubmit' : 'auth.registerSubmit')} <ArrowRightIcon size={16} weight="bold" />
        </Button>

        {config.oauthEnabled && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-3)', color: 'var(--faint)', fontSize: 'var(--fs-caption)' }}>
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

        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', textAlign: 'center' }}>
          {mode === 'login' ? t('auth.toRegister') : t('auth.toLogin')}{' '}
          <button
            type="button"
            onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
            style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 'var(--fs-sm)', padding: 0, whiteSpace: 'nowrap' }}
          >
            {mode === 'login' ? t('auth.toRegisterCta') : t('auth.toLoginCta')}
          </button>
        </div>
      </form>
    </div>
  );

  return (
    <>
      <AppBackground grid />
      <div style={{ position: 'absolute', top: 'var(--s-4)', right: 'var(--s-4)', zIndex: 2, display: 'flex', gap: 'var(--s-2)' }}>
        <LanguageSwitch />
        <ThemeToggle />
      </div>
      <div
        ref={root}
        style={{
          position: 'relative',
          zIndex: 1,
          minHeight: '100dvh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 'var(--s-8) var(--s-5)',
        }}
      >
        <div
          style={{
            width: '100%',
            maxWidth: isDesktop ? 1040 : 440,
            display: 'grid',
            gridTemplateColumns: isDesktop ? '1.05fr 0.95fr' : '1fr',
            gap: isDesktop ? 'var(--s-10)' : 'var(--s-6)',
            alignItems: 'center',
          }}
        >
          {isDesktop && <BrandPanel />}
          <div style={{ display: 'flex', justifyContent: 'center' }}>{card}</div>
        </div>
      </div>
    </>
  );
}
