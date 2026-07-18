import { useTranslation } from 'react-i18next';

import { PageHeader, PageTransition } from '@/components/shell/page';

export function AuditLogPage() {
  const { t } = useTranslation();
  return (
    <PageTransition>
      <PageHeader title={t('nav.auditLog')} description="" />
    </PageTransition>
  );
}
