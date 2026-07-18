import {
  Boxes,
  Building2,
  ChartColumn,
  CreditCard,
  Gauge,
  GitFork,
  Globe,
  PackageCheck,
  PlugZap,
  ReceiptText,
  Scale,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  Ticket,
  Wallet,
  Waves,
  Waypoints,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { logout } from '@/api/auth';
import { AppShell, type ShellNavGroup } from '@/components/shell/app-shell';
import { Button } from '@/components/ui/components/buttons/button';
import { Badge } from '@/components/ui/data-display';
import { ActivityIcon } from '@/components/ui/icons/activity';
import { KeyIcon } from '@/components/ui/icons/key';
import { LayoutDashboardIcon } from '@/components/ui/icons/layout-dashboard';
import { RefreshCwIcon } from '@/components/ui/icons/refresh-cw';
import { SettingsIcon } from '@/components/ui/icons/settings';
import { UsersIcon } from '@/components/ui/icons/users';

import { useConsoleMe } from './console-me';

const iconClass = 'size-[18px]';

/** Platform-admin console shell: `/console/*`, backed by the `/admin/*` plane. */
export function ConsoleShell() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const me = useConsoleMe();

  const navigation: ShellNavGroup[] = [
    {
      items: [
        {
          label: t('nav.overview'),
          to: '/console/overview',
          icon: <LayoutDashboardIcon animateOnHover size={18} />,
        },
      ],
    },
    {
      title: t('nav.groupSupply'),
      items: [
        {
          label: t('nav.providers'),
          to: '/console/supply/providers',
          icon: <Building2 className={iconClass} />,
        },
        {
          label: t('nav.channels'),
          to: '/console/supply/channels',
          icon: <Waypoints className={iconClass} />,
        },
        {
          label: t('nav.models'),
          to: '/console/supply/models',
          icon: <Boxes className={iconClass} />,
        },
        {
          label: t('nav.offerings'),
          to: '/console/supply/offerings',
          icon: <PackageCheck className={iconClass} />,
        },
        {
          label: t('nav.priceCards'),
          to: '/console/supply/price-cards',
          icon: <ReceiptText className={iconClass} />,
        },
      ],
    },
    {
      title: t('nav.groupRouting'),
      items: [
        {
          label: t('nav.routingGroups'),
          to: '/console/routing/groups',
          icon: <GitFork className={iconClass} />,
        },
        {
          label: t('nav.faultPolicies'),
          to: '/console/routing/fault-policies',
          icon: <ShieldAlert className={iconClass} />,
        },
        {
          label: t('nav.proxies'),
          to: '/console/routing/proxies',
          icon: <Globe className={iconClass} />,
        },
        {
          label: t('nav.breakers'),
          to: '/console/routing/breakers',
          icon: <PlugZap className={iconClass} />,
        },
      ],
    },
    {
      title: t('nav.groupTenants'),
      items: [
        {
          label: t('nav.tenants'),
          to: '/console/tenants',
          icon: <UsersIcon animateOnHover size={18} />,
        },
        {
          label: t('nav.ledger'),
          to: '/console/billing/ledger',
          icon: <Wallet className={iconClass} />,
        },
        {
          label: t('nav.payments'),
          to: '/console/billing/payments',
          icon: <CreditCard className={iconClass} />,
        },
        {
          label: t('nav.redemptionCodes'),
          to: '/console/billing/redemption-codes',
          icon: <Ticket className={iconClass} />,
        },
        {
          label: t('nav.officialPrices'),
          to: '/console/billing/official-prices',
          icon: <ReceiptText className={iconClass} />,
        },
        {
          label: t('nav.reconciliation'),
          to: '/console/billing/reconciliation',
          icon: <Scale className={iconClass} />,
        },
      ],
    },
    {
      title: t('nav.groupGovernance'),
      items: [
        {
          label: t('nav.limitPlans'),
          to: '/console/limits/plans',
          icon: <Gauge className={iconClass} />,
        },
        {
          label: t('nav.limitMonitor'),
          to: '/console/limits/monitor',
          icon: <ActivityIcon animateOnHover size={18} />,
        },
      ],
    },
    {
      title: t('nav.groupObservability'),
      items: [
        {
          label: t('nav.auditLog'),
          to: '/console/ops/audit-log',
          icon: <ScrollText className={iconClass} />,
        },
        {
          label: t('nav.relayTraces'),
          to: '/console/ops/relay-traces',
          icon: <Waves className={iconClass} />,
        },
        {
          label: t('nav.usageAnalytics'),
          to: '/console/ops/usage',
          icon: <ChartColumn className={iconClass} />,
        },
      ],
    },
    {
      title: t('nav.groupPlatform'),
      items: [
        {
          label: t('nav.platformSettings'),
          to: '/console/settings/platform',
          icon: <SettingsIcon animateOnHover size={18} />,
        },
        {
          label: t('nav.secrets'),
          to: '/console/settings/secrets',
          icon: <KeyIcon animateOnHover size={18} />,
        },
        {
          label: t('nav.adminTokens'),
          to: '/console/settings/tokens',
          icon: <ShieldCheck className={iconClass} />,
        },
        {
          label: t('nav.oauthSessions'),
          to: '/console/settings/oauth-sessions',
          icon: <RefreshCwIcon animateOnHover size={18} />,
        },
      ],
    },
  ];

  return (
    <AppShell
      navigation={navigation}
      headerStart={<Badge variant="primary">{t('shell.adminBadge')}</Badge>}
      headerActions={
        me.data?.tenant_id ? (
          <Button variant="ghost" size="sm" onClick={() => void navigate('/app/overview')}>
            {t('shell.goTenant')}
          </Button>
        ) : undefined
      }
      user={{
        name: me.data?.email ?? t('shell.platformAdmin'),
        detail: t('shell.adminBadge'),
      }}
      onLogout={() => {
        logout();
        void navigate('/login');
      }}
    />
  );
}
