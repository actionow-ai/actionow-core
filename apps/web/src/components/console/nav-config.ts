import type { Icon } from '@phosphor-icons/react';
import { KeyIcon, SquaresFourIcon, WalletIcon } from '@phosphor-icons/react';

export interface NavItem {
  to: string;
  labelKey: string;
}
export interface NavGroup {
  key: string;
  icon: Icon;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  {
    key: 'ops',
    icon: SquaresFourIcon,
    items: [
      { to: '/console/dashboard', labelKey: 'dashboard' },
      { to: '/console/tenants', labelKey: 'tenants' },
    ],
  },
  {
    key: 'billing',
    icon: WalletIcon,
    items: [{ to: '/console/accounts', labelKey: 'accounts' }],
  },
  {
    key: 'access',
    icon: KeyIcon,
    items: [{ to: '/console/api-keys', labelKey: 'apiKeys' }],
  },
];

export function groupForPath(pathname: string): NavGroup {
  return NAV.find((g) => g.items.some((it) => pathname.startsWith(it.to))) ?? NAV[0];
}

export function activeItem(pathname: string): NavItem {
  const g = groupForPath(pathname);
  return g.items.find((it) => pathname.startsWith(it.to)) ?? g.items[0];
}
