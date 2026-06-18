import type { Icon } from '@phosphor-icons/react';
import {
  BuildingsIcon,
  CoinsIcon,
  KeyIcon,
  SquaresFourIcon,
  StackIcon,
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

/**
 * Nav grouped by responsibility (职责分组):
 * - ops: dashboard
 * - catalog (目录): the unified 模型|资源 catalog page + Dify import
 * - billing (计费与路由): groups / official prices / pricing modifiers
 * - tenants (租户): tenants / accounts / API keys
 *
 * The catalog page owns its own 模型|资源 tabs, so the nav holds a single
 * `/console/catalog` leaf. `分组`/`官方价格` are mock-skeleton pages (the
 * billing/routing backend is design-only; data lives in mockBilling.ts).
 */
export const NAV: NavGroup[] = [
  {
    key: 'ops',
    icon: SquaresFourIcon,
    items: [
      { to: '/console/dashboard', labelKey: 'dashboard' },
      { to: '/console/analytics', labelKey: 'analytics' },
    ],
  },
  {
    key: 'catalog',
    icon: StackIcon,
    items: [
      { to: '/console/catalog', labelKey: 'catalog' },
      { to: '/console/dify', labelKey: 'dify' },
    ],
  },
  {
    key: 'billing',
    icon: CoinsIcon,
    items: [
      // labelKey `routeGroups` (not `groups`) avoids colliding with the
      // `nav.groups.*` group-label namespace in the i18n bundle.
      { to: '/console/groups', labelKey: 'routeGroups' },
      { to: '/console/official-prices', labelKey: 'officialPrices' },
      { to: '/console/modifiers', labelKey: 'modifiers' },
    ],
  },
  {
    key: 'tenants',
    icon: BuildingsIcon,
    items: [
      { to: '/console/tenants', labelKey: 'tenants' },
      { to: '/console/accounts', labelKey: 'accounts' },
      { to: '/console/api-keys', labelKey: 'apiKeys' },
    ],
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
  { to: '/console/catalog', labelKey: 'catalog', icon: StackIcon },
  { to: '/console/tenants', labelKey: 'tenants', icon: BuildingsIcon },
  { to: '/console/api-keys', labelKey: 'apiKeys', icon: KeyIcon },
];
