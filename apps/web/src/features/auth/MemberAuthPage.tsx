import { ArrowRightIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { Logo } from '../../components/brand/Logo';
import { AppBackground } from '../../components/glass/AppBackground';
import { LanguageSwitch } from '../../components/layout/LanguageSwitch';
import { ThemeToggle } from '../../components/layout/ThemeToggle';
import { Button } from '../../components/ui/Button';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { ApiError } from '../../lib/api/errors';
import { useAuth } from '../../lib/auth/AuthProvider';
import { homePath } from '../../lib/auth/homePath';

type Mode = 'login' | 'register';

/**
 * The MEMBER (end-user) auth screen — `/member/login` (unified tenancy G-F,
 * Model-A actionow-hosted end-user login). Distinct from the operator
 * {@link AuthPage}: a member belongs to ONE tenant, so the form takes a tenant id
 * alongside email + password and posts to `/auth/(login|register)-member`. On
 * success the member JWT (`typ:'subject'`) is stored and we route to the member
 * portal (`homePath` sends `role:'member'` → `/portal`).
 */
export function MemberAuthPage() {
  const { t } = useTranslation('console');
  const { loginMember, registerMember } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>('login');
  const [tenantId, setTenantId] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const user =
        mode === 'login'
          ? await loginMember(tenantId.trim(), email, password)
          : await registerMember(tenantId.trim(), email, password);
      toast(mode === 'register' ? t('member.auth.registered') : t('member.auth.loggedIn'));
      void navigate(homePath(user), { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(
          err.status === 401
            ? t('member.auth.failed')
            : err.code === 'invalid_input'
              ? err.message
              : t(`errors.${err.code}`, t('member.auth.failed')),
        );
      } else {
        setError(t('errors.network'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <AppBackground grid />
      <div
        style={{
          position: 'absolute',
          top: 'var(--s-4)',
          right: 'var(--s-4)',
          zIndex: 2,
          display: 'flex',
          gap: 'var(--s-2)',
        }}
      >
        <LanguageSwitch />
        <ThemeToggle />
      </div>
      <div
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
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="glass"
          style={{
            width: 'min(400px, 92vw)',
            padding: 'var(--s-6)',
            borderRadius: 'var(--r-lg)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--s-4)',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)', alignItems: 'center' }}>
            <Logo size={28} />
            <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
              {t('member.auth.subtitle')}
            </span>
          </div>

          <div style={{ alignSelf: 'center' }}>
            <SegmentedControl
              value={mode}
              onChange={(v) => {
                setMode(v as Mode);
                setError(null);
              }}
              options={[
                { value: 'login', label: t('auth.loginTab') },
                { value: 'register', label: t('auth.registerTab') },
              ]}
            />
          </div>

          <TextField
            label={t('member.auth.tenantId')}
            hint={t('member.auth.tenantHint')}
            value={tenantId}
            onChange={(v) => {
              setTenantId(v);
              if (error !== null) setError(null);
            }}
            required
          />
          <TextField
            label={t('auth.email')}
            type="email"
            autoComplete="username"
            value={email}
            onChange={(v) => {
              setEmail(v);
              if (error !== null) setError(null);
            }}
            required
          />
          <TextField
            label={t('auth.password')}
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            value={password}
            onChange={(v) => {
              setPassword(v);
              if (error !== null) setError(null);
            }}
            required
            error={error ?? undefined}
            minLength={mode === 'register' ? 8 : undefined}
            maxLength={mode === 'register' ? 256 : undefined}
            hint={mode === 'register' ? t('auth.passwordPolicy') : undefined}
          />

          <Button variant="cta" size="lg" type="submit" loading={busy}>
            {t(mode === 'login' ? 'auth.loginSubmit' : 'auth.registerSubmit')}{' '}
            <ArrowRightIcon size={16} weight="bold" />
          </Button>

          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', textAlign: 'center' }}>
            {t('member.auth.operatorHint')}{' '}
            <Button variant="link" onClick={() => void navigate('/login')}>
              {t('member.auth.operatorCta')}
            </Button>
          </div>
        </form>
      </div>
    </>
  );
}
