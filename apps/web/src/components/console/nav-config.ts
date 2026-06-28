import type { Icon } from '@phosphor-icons/react';
import {
  BuildingsIcon,
  CoinsIcon,
  CubeIcon,
  KeyIcon,
  PlugsConnectedIcon,
  SquaresFourIcon,
} from '@phosphor-icons/react';

export interface NavItem {
  to: string;
  labelKey: string;
  /** Reachable + group-owning for active-state, but NOT rendered in the nav (contextual entry). */
  hidden?: boolean;
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
 * - models (模型): the model CATALOG — a flat faceted list of every model (browse
 *   "what we serve"). The wiring lives in 接入设置.
 * - access (接入设置): 模型接入 (平台·通道·模型 management) / 插件 / 代理 / Dify / 凭据
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
      { to: '/console/status', labelKey: 'status' },
      { to: '/console/breakers', labelKey: 'breakers' },
      { to: '/console/relay-traces', labelKey: 'relayTraces' },
      { to: '/console/audit-log', labelKey: 'auditLog' },
    ],
  },
  {
    key: 'models',
    icon: CubeIcon,
    items: [{ to: '/console/models', labelKey: 'models' }],
  },
  {
    key: 'access',
    icon: PlugsConnectedIcon,
    items: [
      // 模型接入: the 3-pane plugin→通道→模型 management (插件 folds in here; platform
      // + pricing live on the secondary /console/platforms view).
      { to: '/console/catalog', labelKey: 'modelAccess' },
      // 平台与定价 is a contextual/advanced surface entered from inside 模型接入
      // (header link) — owns its active-state but is hidden from the nav.
      { to: '/console/platforms', labelKey: 'platforms', hidden: true },
      { to: '/console/proxies', labelKey: 'proxies' },
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
      { to: '/console/limit-plans', labelKey: 'limitPlans' },
      { to: '/console/fault-policies', labelKey: 'faultPolicies' },
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
  const match = groups.find((g) => g.items.some((it) => pathname.startsWith(it.to)));
  if (match !== undefined) return match;
  const first = groups[0];
  if (first === undefined) throw new Error('nav config has no groups');
  return first;
}

/** The active leaf for `pathname` within `groups`, else its group’s first item. */
export function activeItem(pathname: string, groups: NavGroup[]): NavItem {
  const g = groupForPath(pathname, groups);
  const match = g.items.find((it) => pathname.startsWith(it.to));
  if (match !== undefined) return match;
  const first = g.items[0];
  if (first === undefined) throw new Error('nav group has no items');
  return first;
}

/** Flattened leaf items for the mobile bottom tab bar (phone-app pattern). */
export interface MobileTab {
  to: string;
  labelKey: string;
  icon: Icon;
}
export const ADMIN_MOBILE_TABS: MobileTab[] = [
  { to: '/console/overview', labelKey: 'opsOverview', icon: SquaresFourIcon },
  { to: '/console/models', labelKey: 'models', icon: CubeIcon },
  { to: '/console/tenants', labelKey: 'tenants', icon: BuildingsIcon },
  { to: '/console/api-keys', labelKey: 'apiKeys', icon: KeyIcon },
];

/** The admin console nav set (default for `ConsoleLayout`). */
export const ADMIN_NAV_CONFIG: NavConfig = { groups: ADMIN_NAV, mobileTabs: ADMIN_MOBILE_TABS };
