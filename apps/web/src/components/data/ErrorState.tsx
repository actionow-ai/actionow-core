import { WarningCircleIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../ui/Button';

/**
 * The shared "this section failed to load" state: a warning mark, a message
 * (defaults to `errors.loadFailed`), an optional detail line, and an optional
 * retry button wired to a query's `refetch`. Used by the section-level
 * `QueryBoundary` and by `DataTable`'s error branch so a failed request is never
 * silently rendered as "no data". `role="alert"` so assistive tech announces it.
 */
export function ErrorState({
  message,
  detail,
  onRetry,
  retrying = false,
}: {
  message?: ReactNode;
  detail?: ReactNode;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const { t } = useTranslation('console');
  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 'var(--s-3)',
        padding: 'var(--s-6)',
        textAlign: 'center',
        color: 'var(--muted)',
      }}
    >
      <WarningCircleIcon
        size={28}
        weight="regular"
        style={{ color: 'var(--fail)' }}
        aria-hidden="true"
      />
      <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text)' }}>
        {message ?? t('errors.loadFailed')}
      </div>
      {detail !== undefined && (
        <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--muted)' }}>{detail}</div>
      )}
      {onRetry !== undefined && (
        <Button variant="ghost" size="sm" onClick={onRetry} loading={retrying}>
          {t('common.retry')}
        </Button>
      )}
    </div>
  );
}
