import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';

import { AuthError, login, register, sessionPayload } from '@/api/auth';
import { FormField } from '@/components/common/form-field';
import { AuthShell } from '@/components/shell/auth-shell';
import { Button } from '@/components/ui/components/buttons/button';
import { Input } from '@/components/ui/input';
import { config } from '@/config';

type Mode = 'login' | 'register';

/** Destination after a successful sign-in, by role claim. */
export function postLoginPath(from?: string): string {
  if (from && (from.startsWith('/console') || from.startsWith('/app'))) return from;
  return sessionPayload()?.role === 'admin' ? '/console/overview' : '/app/overview';
}

export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  // Landing "Create account" CTAs link to /login?mode=register so the form opens
  // in the mode the button promised instead of always defaulting to sign-in.
  const [mode, setMode] = useState<Mode>(() =>
    new URLSearchParams(location.search).get('mode') === 'register' ? 'register' : 'login',
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const from = (location.state as { from?: string } | null)?.from;

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      if (mode === 'login') await login(email, password);
      else await register(email, password);
      void navigate(postLoginPath(from), { replace: true });
    } catch (cause) {
      setError(cause instanceof AuthError ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthShell
      eyebrow={t('auth.eyebrow')}
      title={mode === 'login' ? t('auth.signInTitle') : t('auth.registerTitle')}
      description={mode === 'login' ? t('auth.signInDescription') : t('auth.registerDescription')}
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <FormField label={t('auth.email')}>
          {(id) => (
            <Input
              id={id}
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          )}
        </FormField>
        <FormField
          label={t('auth.password')}
          hint={mode === 'register' ? t('auth.passwordHint') : undefined}
          error={error ?? undefined}
        >
          {(id) => (
            <Input
              id={id}
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
              minLength={8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          )}
        </FormField>
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? t('common.loading') : mode === 'login' ? t('auth.signIn') : t('auth.register')}
        </Button>
      </form>
      {config.oauthEnabled ? (
        <div className="mt-4 grid gap-2">
          <Button
            variant="outline"
            onClick={() => {
              window.location.href = `${config.apiBaseUrl}/auth/oauth/google`;
            }}
          >
            {t('auth.oauthGoogle')}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              window.location.href = `${config.apiBaseUrl}/auth/oauth/github`;
            }}
          >
            {t('auth.oauthGithub')}
          </Button>
        </div>
      ) : null}
      <div className="mt-6 text-center">
        <Button
          variant="link"
          onClick={() => {
            setMode(mode === 'login' ? 'register' : 'login');
            setError(null);
          }}
        >
          {mode === 'login' ? t('auth.switchToRegister') : t('auth.switchToLogin')}
        </Button>
      </div>
    </AuthShell>
  );
}
