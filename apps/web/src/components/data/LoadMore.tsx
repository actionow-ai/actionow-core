import { useTranslation } from 'react-i18next';

import { Button } from '../ui/Button';

/**
 * The standard "Load more" control for keyset-paginated lists driven by
 * `useInfiniteQuery`. Renders nothing when there is no next page, so callers can
 * drop it unconditionally below a `DataTable`/`CardCollection`.
 */
export function LoadMore({
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
}) {
  const { t } = useTranslation('console');
  if (!hasNextPage) return null;
  return (
    <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 'var(--s-3)' }}>
      <Button variant="ghost" onClick={onLoadMore} loading={isFetchingNextPage}>
        {t('common.loadMore')}
      </Button>
    </div>
  );
}
