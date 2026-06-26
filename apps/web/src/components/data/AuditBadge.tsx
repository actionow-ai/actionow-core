import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import type { Column } from '../../components/data/DataTable';
import type { LatestAuditView } from '../../lib/api/types';
import { relativeTime } from '../../lib/relativeTime';
import { Pill } from '../ui/Pill';

/** Abbreviate an id to its first 8 chars — matches `AuditLogPage`'s actor/target rendering. */
const SHORT = (id: string): string => id.slice(0, 8);

/**
 * A small "last changed {when} by {who}" version badge for an entity row (前端打磨).
 * Reads the newest `audit_log` row (`entry`, from {@link useLatestAudit}) and
 * renders an `idle`-tone {@link Pill} with the relative time + actor, linking to
 * the 审计日志 page deep-filtered to this `target_type` + `target_id` — matching
 * how `AuditLogPage` reads its `target` + `target_id` filters from the URL.
 * Renders nothing when the entity has no audit history (`entry === undefined`).
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

  // Abbreviate the actor id to SHORT(id) like the audit log page does (the full id
  // is clipped by the 180px column anyway) — fall back to the actor-type label.
  const actor =
    entry.actor_id !== null
      ? SHORT(entry.actor_id)
      : t('auditLog.actor.' + entry.actor_type, entry.actor_type);
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

/**
 * The shared "last changed" {@link Column} for an entity list — keeps the header,
 * width (180px) and `noClip` in one place across the 5 wired tables (前端打磨). Pass
 * the page's `t`, the `Map<id, LatestAuditView>` from {@link useLatestAudit}, the
 * entity's `target_type`, and an id accessor; the cell looks up the row's audit
 * entry and renders an {@link AuditBadge}.
 */
export function auditColumn<T>(
  t: TFunction<'console'>,
  audit: Map<string, LatestAuditView>,
  targetType: string,
  id: (row: T) => string,
): Column<T> {
  return {
    key: 'audit',
    header: t('common.lastChanged'),
    noClip: true,
    width: '180px',
    cell: (row) => (
      <AuditBadge entry={audit.get(id(row))} targetType={targetType} targetId={id(row)} />
    ),
  };
}
