import { CoinsIcon, KeyIcon, SquaresFourIcon, StackIcon } from '@phosphor-icons/react';

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
        { to: '/app/models', labelKey: 'tmodels' },
      ],
    },
    {
      key: 'account',
      icon: KeyIcon,
      items: [
        { to: '/app/keys', labelKey: 'tkeys' },
        { to: '/app/billing', labelKey: 'billing' },
      ],
    },
  ],
  mobileTabs: [
    { to: '/app/overview', labelKey: 'overview', icon: SquaresFourIcon },
    { to: '/app/keys', labelKey: 'tkeys', icon: KeyIcon },
    { to: '/app/models', labelKey: 'tmodels', icon: StackIcon },
    { to: '/app/billing', labelKey: 'billing', icon: CoinsIcon },
  ],
};
