import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/components/buttons/button';

/** Footer for cursor-paginated tables: loaded count + load-more action. */
export function LoadMore({
  count,
  hasMore,
  loading,
  onLoadMore,
}: {
  count: number;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between gap-4 pt-3">
      <p className="text-sm text-muted-foreground">
        <span className="font-mono tabular-nums">{count}</span> {t('common.loadedRows')}
      </p>
      {hasMore ? (
        <Button variant="outline" size="sm" onClick={onLoadMore} disabled={loading}>
          {loading ? t('common.loading') : t('common.loadMore')}
        </Button>
      ) : null}
    </div>
  );
}
