import { InfoIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

/**
 * The tenant-admin-only gate note (RBAC v1). Two shapes:
 * - `banner` (default): a brief inline note shown OVER a still-visible read-only view
 *   on `/app` surfaces whose WRITES are admin-gated (e.g. AppKeys), so a member seat
 *   sees why the mint/topup/upload controls are absent (never a control they'd 403 on).
 * - `page`: a centered full-page note that REPLACES the content for a member who lacks
 *   access to the whole surface (subjects / limit-plans / members).
 */
export function AdminOnlyNote({
  variant = 'banner',
  message,
}: {
  variant?: 'banner' | 'page';
  message?: string;
}) {
  const { t } = useTranslation('console');
  const text = message ?? t('app.adminOnly');

  if (variant === 'page') {
    return (
      <div
        role="note"
        style={{
          padding: 'var(--s-5)',
          textAlign: 'center',
          color: 'var(--muted)',
          fontSize: 'var(--fs-sm)',
        }}
      >
        {text}
      </div>
    );
  }

  return (
    <div
      role="note"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--s-2)',
        padding: 'var(--s-2) var(--s-3)',
        borderRadius: 'var(--r-sm)',
        background: 'var(--glass-bg)',
        border: '1px solid var(--panel-bd)',
        fontSize: 'var(--fs-caption)',
        color: 'var(--muted)',
      }}
    >
      <InfoIcon size={15} aria-hidden="true" style={{ flexShrink: 0, color: 'var(--faint)' }} />
      {text}
    </div>
  );
}
