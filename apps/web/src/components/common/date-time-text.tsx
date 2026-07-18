import { i18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

function format(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(i18n.language === 'en' ? 'en-US' : 'zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/** Renders an ISO timestamp in the active locale, monospace + tabular. */
export function DateTimeText({
  value,
  className,
}: {
  value: string | null | undefined;
  className?: string;
}) {
  return <span className={cn('font-mono tabular-nums', className)}>{format(value)}</span>;
}
