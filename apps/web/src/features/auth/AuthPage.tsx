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
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { config } from '../../config';
import { ApiError } from '../../lib/api/errors';
import { useAuth } from '../../lib/auth/AuthProvider';
import { BP } from '../../lib/breakpoints';
import { gsap, useGSAP } from '../../lib/motion/gsap';
import { DUR, EASE } from '../../lib/motion/tokens';
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
  const cardRef = useRef<HTMLFormElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const submitRef = useRef<HTMLDivElement>(null);
  const isFirstMode = useRef(true);

  useGSAP(
    () => {
      const el = root.current;
      if (!el) return;
      const mm = gsap.matchMedia();
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        // fromTo (explicit start+end) so a re-run can't strand the reveal.
        gsap.fromTo(
          el.querySelectorAll('[data-reveal]'),
          { opacity: 0, y: 24 },
          { opacity: 1, y: 0, duration: DUR.slow, ease: EASE.out, stagger: 0.07 },
        );
        // live tail in the brand panel
        gsap.fromTo(
          el.querySelectorAll('[data-log]'),
          { opacity: 0.25 },
          { opacity: 1, duration: DUR.base, ease: 'none', delay: 0.5, stagger: { each: 0.45, repeat: -1, yoyo: true, repeatDelay: 1.4 } },
        );
      });
    },
    { scope: root, dependencies: [] },
  );

  // Mode cross-fade: the differing body (autoComplete + submit label + footer)
  // settles in when login↔register toggles. Skips the very first render so the
  // initial page reveal (above) owns the entrance.
  useGSAP(
    () => {
      if (isFirstMode.current) {
        isFirstMode.current = false;
        return;
      }
      const body = bodyRef.current;
      if (!body) return;
      const mm = gsap.matchMedia();
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        gsap.fromTo(body, { opacity: 0.4, y: 6 }, { opacity: 1, y: 0, duration: DUR.base, ease: EASE.out });
      });
    },
    { scope: cardRef, dependencies: [mode] },
  );

  const shake = () => {
    const card = cardRef.current;
    if (!card || !window.matchMedia('(prefers-reduced-motion: no-preference)').matches) return;
    gsap.fromTo(card, { x: -8 }, { x: 0, duration: DUR.slow, ease: 'elastic.out(1, 0.4)' });
    // Brief fail-border pulse, then settle back to the glass border. Resolve the
    // tokens to concrete colors so GSAP can interpolate between them. clearProps
    // drops the inline borderColor at the end so it can't shadow the theme var
    // (and stay stale) after a later theme switch — the CSS rule takes over again.
    const styles = getComputedStyle(card);
    const fail = styles.getPropertyValue('--fail').trim();
    const rest = styles.getPropertyValue('--glass-bd').trim();
    gsap.fromTo(card, { borderColor: fail }, { borderColor: rest, duration: DUR.slower, ease: EASE.out, clearProps: 'borderColor' });
  };

  // Brief success scale on the submit button before navigating. Resolves when
  // the cue finishes (≤ DUR.base) so it's perceptible without delaying nav; a
  // no-op (instant resolve) under reduced-motion.
  const successCue = (): Promise<void> => {
    const btn = submitRef.current;
    if (!btn || !window.matchMedia('(prefers-reduced-motion: no-preference)').matches) return Promise.resolve();
    return new Promise<void>((resolve) => {
      gsap.fromTo(btn, { scale: 1 }, { scale: 1.04, duration: DUR.instant, ease: EASE.out, yoyo: true, repeat: 1, onComplete: resolve });
    });
  };

  const submit = async () => {
    setBusy(true);
    try {
      const user = mode === 'login' ? await login(email, password) : await register(email, password);
      toast(mode === 'register' ? t('auth.registered') : t('auth.loggedIn'));
      await successCue();
      void navigate(user.role === 'admin' ? '/console/dashboard' : '/app', { replace: true });
    } catch (err) {
      shake();
      if (err instanceof ApiError) toast(t(`errors.${err.code}`, t('auth.failed')), 'error');
      else toast(t('errors.network'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const card = (
    <div data-reveal style={{ width: 'min(400px, 92vw)' }}>
      <form
        ref={cardRef}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="glass auth-form"
        style={{ padding: 'var(--s-6)', borderRadius: 'var(--r-lg)', display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}
      >
        {!isDesktop && <Logo size={28} />}

        {/* segmented login / register switch */}
        <SegmentedControl
          value={mode}
          onChange={(v) => setMode(v as Mode)}
          options={[
            { value: 'login', label: t('auth.loginTab') },
            { value: 'register', label: t('auth.registerTab') },
          ]}
        />

        {/* mode-dependent body: cross-fades when login↔register toggles */}
        <div ref={bodyRef} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
          <TextField label={t('auth.email')} type="email" autoComplete="username" value={email} onChange={setEmail} required />
          <TextField
            label={t('auth.password')}
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            value={password}
            onChange={setPassword}
            required
          />

          <div ref={submitRef} style={{ display: 'flex', flexDirection: 'column' }}>
            <Button variant="cta" size="lg" type="submit" loading={busy}>
              {t(mode === 'login' ? 'auth.loginSubmit' : 'auth.registerSubmit')} <ArrowRightIcon size={16} weight="bold" />
            </Button>
          </div>

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
            <Button variant="link" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
              {mode === 'login' ? t('auth.toRegisterCta') : t('auth.toLoginCta')}
            </Button>
          </div>
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
