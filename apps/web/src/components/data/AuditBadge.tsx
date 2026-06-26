import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import type { LatestAuditView } from '../../lib/api/types';
import { relativeTime } from '../../lib/relativeTime';
import { Pill } from '../ui/Pill';

/**
 * A small "last changed {when} by {who}" version badge for an entity row (前端打磨).
 * Reads the newest `audit_log` row (`entry`, from {@link useLatestAudit}) and
 * renders an `idle`-tone {@link Pill} with the relative time + actor, linking to
 * the 审计日志 page deep-filtered to this `target_type` (+ `target_id`) — matching
 * how `AuditLogPage` reads its `target` filter from the URL. Renders nothing when
 * the entity has no audit history (`entry === undefined`).
 */
export function AuditBadge({
  entry,
  targetType,
  targetId,
}: {
  entry?: LatestAuditView;
  targetType: string;
  targetId: string;
}) {
  const { t, i18n } = useTranslation('console');
  if (entry === undefined) return null;

  const actor = entry.actor_id ?? t('auditLog.actor.' + entry.actor_type, entry.actor_type);
  const time = relativeTime(entry.created_at, i18n.language);
  const to = `/console/audit-log?target=${encodeURIComponent(targetType)}&target_id=${encodeURIComponent(targetId)}`;

  return (
    <Link
      to={to}
      title={t('audit.badge', { time, actor })}
      style={{ textDecoration: 'none' }}
      onClick={(e) => e.stopPropagation()}
    >
      <Pill tone="idle">{t('audit.badge', { time, actor })}</Pill>
    </Link>
  );
}
