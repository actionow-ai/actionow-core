import {
  ChartLineIcon,
  CoinsIcon,
  KeyIcon,
  SparkleIcon,
  SquaresFourIcon,
} from '@phosphor-icons/react';

import type { NavConfig } from './nav-config';

/**
 * The TENANT self-service nav for the `/app` shell (rendered by `ConsoleLayout`
 * with `nav={TENANT_NAV_CONFIG}`). Routes are distinct prefixes — overview lives
 * at `/app/overview` (not the `/app` index) so it isn't a prefix of the others,
 * which would defeat `groupForPath`'s `startsWith` matching.
 */
export const TENANT_NAV_CONFIG: NavConfig = {
  groups: [
    {
      key: 'home',
      icon: SquaresFourIcon,
      items: [
        { to: '/app/overview', labelKey: 'overview' },
        { to: '/app/usage', labelKey: 'tusage' },
        { to: '/app/media', labelKey: 'tmedia' },
        { to: '/app/models', labelKey: 'tmodels' },
      ],
    },
    {
      // Playground is its own primary entry; the sub-nav switches modality
      // (对话 / 图片 / 视频 / 音频). Only Chat is live; the rest are coming-soon pages.
      key: 'playground',
      icon: SparkleIcon,
      items: [
        { to: '/app/playground/chat', labelKey: 'pgChat' },
        { to: '/app/playground/image', labelKey: 'pgImage' },
        { to: '/app/playground/video', labelKey: 'pgVideo' },
        { to: '/app/playground/audio', labelKey: 'pgAudio' },
      ],
    },
    {
      key: 'account',
      icon: KeyIcon,
      items: [
        { to: '/app/keys', labelKey: 'tkeys' },
        { to: '/app/billing', labelKey: 'billing' },
        // 端用户 (End-users / subjects) — tenant-admin-only (end-user data plane);
        // hidden for members via `filterTenantNav`.
        { to: '/app/subjects', labelKey: 'tsubjects' },
        // 额度套餐 (Limit plans) — tenant-admin-only (end-user data plane); hidden
        // for members via `filterTenantNav`.
        { to: '/app/plans', labelKey: 'tplans' },
        // 成员管理 (Members) — tenant-admin-only (RBAC v1); hidden for members
        // via `filterTenantNav`.
        { to: '/app/members', labelKey: 'tmembers' },
        { to: '/app/settings', labelKey: 'tsettings' },
      ],
    },
  ],
  // 4 primary mobile destinations; the reference Models list stays desktop-SubNav-only.
  mobileTabs: [
    { to: '/app/overview', labelKey: 'overview', icon: SquaresFourIcon },
    { to: '/app/usage', labelKey: 'tusage', icon: ChartLineIcon },
    { to: '/app/keys', labelKey: 'tkeys', icon: KeyIcon },
    { to: '/app/billing', labelKey: 'billing', icon: CoinsIcon },
  ],
};

/**
 * Nav `to` paths that are tenant-admin-only (RBAC v1). A `tenant_role='member'`
 * seat never sees these nav items (the route + page also self-gate, and the
 * backend 403s — this only hides the link). `filterTenantNav` strips them.
 */
const ADMIN_ONLY_PATHS = new Set(['/app/subjects', '/app/plans', '/app/members']);

/**
 * The tenant nav narrowed to what the caller's seat may see. Members lose the
 * admin-only items (成员管理); admins (and a `null` system operator) keep the full
 * set. Empty groups are dropped so the rail never shows a switcher with no items.
 */
export function filterTenantNav(isTenantAdmin: boolean): NavConfig {
  if (isTenantAdmin) return TENANT_NAV_CONFIG;
  const groups = TENANT_NAV_CONFIG.groups
    .map((g) => ({ ...g, items: g.items.filter((it) => !ADMIN_ONLY_PATHS.has(it.to)) }))
    .filter((g) => g.items.length > 0);
  const mobileTabs = TENANT_NAV_CONFIG.mobileTabs.filter((tab) => !ADMIN_ONLY_PATHS.has(tab.to));
  return { groups, mobileTabs };
}
