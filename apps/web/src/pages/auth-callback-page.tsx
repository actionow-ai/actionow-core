import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { setSession } from '@/api/auth';
import { AuthShell } from '@/components/shell/auth-shell';
import { Button } from '@/components/ui/components/buttons/button';
import { Skeleton } from '@/components/ui/data-display';

import { postLoginPath } from './login-page';

/** OAuth hand-off: the provider callback 302s here with `#token=<jwt>`. */
export function AuthCallbackPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const token = params.get('token');
    if (!token) {
      setFailed(true);
      return;
    }
    setSession({ accessToken: token, refreshToken: null });
    window.history.replaceState(null, '', window.location.pathname);
    void navigate(postLoginPath(), { replace: true });
  }, [navigate]);

  return (
    <AuthShell
      title={failed ? t('auth.callbackFailed') : t('auth.callbackPending')}
      description={failed ? '' : t('common.loading')}
    >
      {failed ? (
        <Button className="w-full" onClick={() => void navigate('/login', { replace: true })}>
          {t('auth.backToLogin')}
        </Button>
      ) : (
        <div className="space-y-3">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-2/3" />
        </div>
      )}
    </AuthShell>
  );
}
