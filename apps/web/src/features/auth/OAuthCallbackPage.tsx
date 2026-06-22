import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';

import { LoadingScreen } from '../../components/ui/LoadingScreen';
import { useAuth } from '../../lib/auth/AuthProvider';
import { homePath } from '../../lib/auth/homePath';

/**
 * Receives the OAuth hand-off. The backend's `/auth/oauth/:provider/callback`
 * 302-redirects here with the JWT in the URL FRAGMENT (`#token=…`) — never the
 * query string, so it isn't sent to the server or logged. We read it once,
 * adopt the session, scrub the fragment from history, and route to the caller's
 * home. A missing/invalid token shows an error with a link back to login.
 */
export function OAuthCallbackPage() {
  const { t } = useTranslation('console');
  const { setSession } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const raw = window.location.hash.startsWith('#')
      ? window.location.hash.slice(1)
      : window.location.hash;
    const params = new URLSearchParams(raw);
    const err = params.get('error');
    const token = params.get('token');
    if (err !== null && err !== '') {
      setError(err);
      return;
    }
    if (token === null || token === '') {
      setError('missing_token');
      return;
    }
    try {
      const user = setSession(token);
      // Replace history so the token-bearing URL can't be revisited/bookmarked.
      void navigate(homePath(user), { replace: true });
    } catch {
      setError('invalid_token');
    }
  }, [setSession, navigate]);

  if (error === null) return <LoadingScreen />;
  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'grid',
        placeItems: 'center',
        padding: 'var(--s-6)',
        textAlign: 'center',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
        <h1 style={{ fontSize: 'var(--fs-h3)', margin: 0 }}>{t('auth.callback.failedTitle')}</h1>
        <p style={{ color: 'var(--muted)', fontSize: 'var(--fs-sm)', margin: 0 }}>
          {t('auth.callback.failedHint')}
        </p>
        <Link to="/login" style={{ color: 'var(--accent)', fontSize: 'var(--fs-sm)' }}>
          {t('auth.callback.backToLogin')}
        </Link>
      </div>
    </div>
  );
}
