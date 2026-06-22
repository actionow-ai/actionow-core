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
/** A full nav set for one console shell (admin or tenant) — desktop groups + the mobile bottom tabs. */
export interface NavConfig {
  groups: NavGroup[];
  mobileTabs: MobileTab[];
}

/**
 * The ADMIN nav grouped by responsibility (职责分组):
 * - ops: dashboard / analytics / relay traces
 * - catalog (接入与供给): resources catalog (relay models nest inside each
 *   resource detail) / Dify import / credentials
 * - billing (计费与路由): groups / official prices / pricing modifiers
 * - tenants (租户): tenants (hub — account balance/top-up lives in the tenant
 *   detail drawer) / API keys
 */
export const ADMIN_NAV: NavGroup[] = [
  {
    key: 'ops',
    icon: SquaresFourIcon,
    items: [
      // dashboard + analytics merged into a single overview·analytics surface.
      { to: '/console/overview', labelKey: 'opsOverview' },
      { to: '/console/relay-traces', labelKey: 'relayTraces' },
    ],
  },
  {
    key: 'catalog',
    icon: StackIcon,
    items: [
      { to: '/console/catalog', labelKey: 'resources' },
      { to: '/console/plugins', labelKey: 'plugins' },
      { to: '/console/dify', labelKey: 'dify' },
      { to: '/console/oauth-sessions', labelKey: 'oauthSessions' },
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
      { to: '/console/api-keys', labelKey: 'apiKeys' },
      { to: '/console/tokens', labelKey: 'serviceTokens' },
      { to: '/console/redemption-codes', labelKey: 'redemptionCodes' },
    ],
  },
];

/** The group owning `pathname` within `groups`, else the first group. */
export function groupForPath(pathname: string, groups: NavGroup[]): NavGroup {
  return groups.find((g) => g.items.some((it) => pathname.startsWith(it.to))) ?? groups[0];
}

/** The active leaf for `pathname` within `groups`, else its group’s first item. */
export function activeItem(pathname: string, groups: NavGroup[]): NavItem {
  const g = groupForPath(pathname, groups);
  return g.items.find((it) => pathname.startsWith(it.to)) ?? g.items[0];
}

/** Flattened leaf items for the mobile bottom tab bar (phone-app pattern). */
export interface MobileTab {
  to: string;
  labelKey: string;
  icon: Icon;
}
export const ADMIN_MOBILE_TABS: MobileTab[] = [
  { to: '/console/overview', labelKey: 'opsOverview', icon: SquaresFourIcon },
  { to: '/console/catalog', labelKey: 'resources', icon: StackIcon },
  { to: '/console/tenants', labelKey: 'tenants', icon: BuildingsIcon },
  { to: '/console/api-keys', labelKey: 'apiKeys', icon: KeyIcon },
];

/** The admin console nav set (default for `ConsoleLayout`). */
export const ADMIN_NAV_CONFIG: NavConfig = { groups: ADMIN_NAV, mobileTabs: ADMIN_MOBILE_TABS };
