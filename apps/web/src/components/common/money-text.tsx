import { formatMicroCredits } from '@/api/client';
import { cn } from '@/lib/utils';

/** Renders a µcredit decimal string as credits, monospace + tabular. */
export function MoneyText({
  value,
  className,
}: {
  value: string | number | null | undefined;
  className?: string;
}) {
  return (
    <span className={cn('font-mono tabular-nums', className)}>{formatMicroCredits(value)}</span>
  );
}
