import { SearchX } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { EmptyState, PageTransition } from '@/components/shell/page';
import { Button } from '@/components/ui/components/buttons/button';

export function NotFoundPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <PageTransition>
      <EmptyState
        icon={SearchX}
        title={t('common.notFoundTitle')}
        description={t('common.notFoundDescription')}
        action={<Button onClick={() => void navigate('/')}>{t('common.backHome')}</Button>}
      />
    </PageTransition>
  );
}
