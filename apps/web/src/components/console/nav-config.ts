import type { Icon } from '@phosphor-icons/react';
import {
  BuildingsIcon,
  KeyIcon,
  SquaresFourIcon,
  StackIcon,
  WalletIcon,
} from '@phosphor-icons/react';

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
    key: 'catalog',
    icon: StackIcon,
    items: [
      { to: '/console/resources', labelKey: 'resources' },
      { to: '/console/modifiers', labelKey: 'modifiers' },
      { to: '/console/dify', labelKey: 'dify' },
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

/** Flattened leaf items for the mobile bottom tab bar (phone-app pattern). */
export interface MobileTab {
  to: string;
  labelKey: string;
  icon: Icon;
}
export const MOBILE_TABS: MobileTab[] = [
  { to: '/console/dashboard', labelKey: 'dashboard', icon: SquaresFourIcon },
  { to: '/console/resources', labelKey: 'resources', icon: StackIcon },
  { to: '/console/tenants', labelKey: 'tenants', icon: BuildingsIcon },
  { to: '/console/api-keys', labelKey: 'apiKeys', icon: KeyIcon },
];
