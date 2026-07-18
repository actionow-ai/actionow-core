import { Boxes, ChartColumn, FolderOpen, Gauge, UsersRound, Wallet } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { logout, sessionPayload } from '@/api/auth';
import { AppShell, type ShellNavGroup } from '@/components/shell/app-shell';
import { Button } from '@/components/ui/components/buttons/button';
import { Badge } from '@/components/ui/data-display';
import { KeyIcon } from '@/components/ui/icons/key';
import { LayoutDashboardIcon } from '@/components/ui/icons/layout-dashboard';
import { SettingsIcon } from '@/components/ui/icons/settings';
import { UsersIcon } from '@/components/ui/icons/users';

import { useConsoleMe } from './console-me';

const iconClass = 'size-[18px]';

/** Tenant console shell: `/app/*`, backed by the `/console/*` plane. */
export function TenantShell() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const me = useConsoleMe();
  const isPlatformAdmin = sessionPayload()?.role === 'admin';

  const navigation: ShellNavGroup[] = [
    {
      title: t('nav.groupUse'),
      items: [
        {
          label: t('nav.appOverview'),
          to: '/app/overview',
          icon: <LayoutDashboardIcon animateOnHover size={18} />,
        },
        { label: t('nav.appKeys'), to: '/app/keys', icon: <KeyIcon animateOnHover size={18} /> },
        { label: t('nav.appModels'), to: '/app/models', icon: <Boxes className={iconClass} /> },
        { label: t('nav.appUsage'), to: '/app/usage', icon: <ChartColumn className={iconClass} /> },
      ],
    },
    {
      title: t('nav.groupEndUsers'),
      items: [
        {
          label: t('nav.appSubjects'),
          to: '/app/subjects',
          icon: <UsersIcon animateOnHover size={18} />,
        },
        {
          label: t('nav.appLimitPlans'),
          to: '/app/limit-plans',
          icon: <Gauge className={iconClass} />,
        },
      ],
    },
    {
      title: t('nav.groupManage'),
      items: [
        { label: t('nav.appTeam'), to: '/app/team', icon: <UsersRound className={iconClass} /> },
        { label: t('nav.appBilling'), to: '/app/billing', icon: <Wallet className={iconClass} /> },
        { label: t('nav.appFiles'), to: '/app/files', icon: <FolderOpen className={iconClass} /> },
        {
          label: t('nav.appSettings'),
          to: '/app/settings',
          icon: <SettingsIcon animateOnHover size={18} />,
        },
      ],
    },
  ];

  return (
    <AppShell
      navigation={navigation}
      headerStart={<Badge variant="neutral">{t('shell.tenantBadge')}</Badge>}
      headerActions={
        isPlatformAdmin ? (
          <Button variant="ghost" size="sm" onClick={() => void navigate('/console/overview')}>
            {t('shell.goAdmin')}
          </Button>
        ) : undefined
      }
      user={{
        name: me.data?.email ?? t('common.user'),
        detail: me.data?.tenant_role === 'admin' ? t('shell.tenantBadge') : undefined,
      }}
      onLogout={() => {
        logout();
        void navigate('/login');
      }}
    />
  );
}
