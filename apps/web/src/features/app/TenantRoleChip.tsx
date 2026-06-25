import { useTranslation } from 'react-i18next';

import { Pill } from '../../components/ui/Pill';

/**
 * The `/app` top-bar "current role" chip (RBAC v1, spec §⑥): an always-visible
 * indicator of the caller's tenant seat — 管理员 (admin, highlighted) / 成员
 * (member). Renders nothing for a system operator (`null` tenant_role) or while
 * `me` is still loading (`undefined`), so it never flashes a placeholder value.
 */
export function TenantRoleChip({ role }: { role: string | null | undefined }) {
  const { t } = useTranslation('console');
  if (role !== 'admin' && role !== 'member') return null;
  return (
    <Pill tone={role === 'admin' ? 'ok' : 'idle'} title={t('app.currentRole')}>
      {t(`app.members.roles.${role}`)}
    </Pill>
  );
}
