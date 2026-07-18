import { useTranslation } from 'react-i18next';

import { PageHeader, PageTransition } from '@/components/shell/page';

export function AppKeysPage() {
  const { t } = useTranslation();
  return (
    <PageTransition>
      <PageHeader title={t('nav.appKeys')} description="" />
    </PageTransition>
  );
}
