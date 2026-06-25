import { SignOutIcon, UserCircleIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { Logo } from '../../components/brand/Logo';
import { CopyField } from '../../components/data/CopyField';
import { AppBackground } from '../../components/glass/AppBackground';
import { LanguageSwitch } from '../../components/layout/LanguageSwitch';
import { ThemeToggle } from '../../components/layout/ThemeToggle';
import { Button } from '../../components/ui/Button';
import { useAuth } from '../../lib/auth/AuthProvider';

/** One labelled identity row. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-1)' }}>
      <span
        style={{
          fontSize: 'var(--fs-caption)',
          textTransform: 'uppercase',
          letterSpacing: '.06em',
          color: 'var(--faint)',
        }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

/**
 * The MEMBER (end-user) portal — `/portal` (unified tenancy G-F). A member JWT is
 * rejected by the operator console/app planes (ConsoleGuard), so this portal
 * deliberately makes NO `/console/*` calls (which would 401→auto-logout); it
 * surfaces the member's identity from the token and explains that data-plane
 * access is via an operator-issued API key. A richer self-service surface awaits
 * a dedicated member data plane (a future backend sub-project).
 */
export function MemberPortal() {
  const { t } = useTranslation('console');
  const { user, logout } = useAuth();
  const navigate = useNavigate();

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
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            logout();
            void navigate('/member/login', { replace: true });
          }}
        >
          <SignOutIcon size={14} weight="bold" /> {t('topbar.logout')}
        </Button>
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
        <div
          className="glass"
          style={{
            width: 'min(460px, 94vw)',
            padding: 'var(--s-6)',
            borderRadius: 'var(--r-lg)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--s-5)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-3)' }}>
            <Logo size={26} />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-3)' }}>
            <UserCircleIcon size={40} weight="duotone" style={{ color: 'var(--accent)' }} />
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <strong style={{ fontSize: 'var(--fs-h3)' }}>{t('member.portal.title')}</strong>
              <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
                {t('member.portal.subtitle')}
              </span>
            </div>
          </div>

          <Row label={t('member.portal.subjectId')}>
            <CopyField
              value={user?.id ?? ''}
              copyLabel={t('common.copy')}
              copiedLabel={t('common.copied')}
              failedLabel={t('common.copyFailed')}
            />
          </Row>
          {user?.tenantId !== undefined && (
            <Row label={t('member.portal.tenantId')}>
              <CopyField
                value={user.tenantId}
                copyLabel={t('common.copy')}
                copiedLabel={t('common.copied')}
                failedLabel={t('common.copyFailed')}
              />
            </Row>
          )}

          <div
            className="panel"
            style={{
              borderRadius: 'var(--r-md)',
              padding: 'var(--s-4)',
              fontSize: 'var(--fs-sm)',
              color: 'var(--muted)',
              lineHeight: 1.6,
            }}
          >
            {t('member.portal.apiNote')}
          </div>
        </div>
      </div>
    </>
  );
}
