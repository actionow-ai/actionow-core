import { InfoIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

/**
 * A brief inline note shown on the `/app` surfaces whose WRITES are gated to
 * tenant admins (RBAC v1). Rendered for a `tenant_role='member'` seat so the
 * read-only view explains why the mint/topup/upload controls are absent — the
 * member never sees a control they'd be 403'd on by the backend TenantAdminGuard.
 */
export function AdminOnlyNote() {
  const { t } = useTranslation('console');
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
      {t('app.adminOnly')}
    </div>
  );
}
