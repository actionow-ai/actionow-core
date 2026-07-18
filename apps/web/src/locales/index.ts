import { locale as appCoreLocale } from '@/pages/app/core/locale';
import { locale as appOpsLocale } from '@/pages/app/ops/locale';
import { locale as appUsersLocale } from '@/pages/app/users/locale';
import { locale as billingLocale } from '@/pages/console/billing/locale';
import { locale as governanceLocale } from '@/pages/console/governance/locale';
import { locale as opsLocale } from '@/pages/console/ops/locale';
import { locale as routingLocale } from '@/pages/console/routing/locale';
import { locale as settingsLocale } from '@/pages/console/settings/locale';
import { locale as supplyModelsLocale } from '@/pages/console/supply-models/locale';
import { locale as supplySourcesLocale } from '@/pages/console/supply-sources/locale';
import { locale as tenantsLocale } from '@/pages/console/tenants/locale';

import { appEn } from './app-en';
import { appZhCN } from './app-zh-cn';
import { graphiteEn } from './en';
import { graphiteZhCN } from './zh-cn';

type Resource = Record<string, unknown>;

/** One-level-deep merge: shared top-level namespaces merge their keys. */
function merge(...bundles: Resource[]): Resource {
  const result: Resource = {};
  for (const bundle of bundles) {
    for (const [key, value] of Object.entries(bundle)) {
      const existing = result[key];
      if (
        existing &&
        typeof existing === 'object' &&
        value &&
        typeof value === 'object' &&
        !Array.isArray(value)
      ) {
        result[key] = { ...(existing as Resource), ...(value as Resource) };
      } else {
        result[key] = value;
      }
    }
  }
  return result;
}

const areaLocales = [
  supplySourcesLocale,
  supplyModelsLocale,
  routingLocale,
  tenantsLocale,
  billingLocale,
  governanceLocale,
  opsLocale,
  settingsLocale,
  appCoreLocale,
  appUsersLocale,
  appOpsLocale,
];

export const resources = {
  'zh-CN': merge(graphiteZhCN, appZhCN, ...areaLocales.map((l) => l.zhCN)),
  en: merge(graphiteEn, appEn, ...areaLocales.map((l) => l.en)),
};
