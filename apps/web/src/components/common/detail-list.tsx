import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export interface DetailItem {
  label: string;
  value: ReactNode;
}

/** Two-column description list for detail cards. */
export function DetailList({ items, className }: { items: DetailItem[]; className?: string }) {
  return (
    <dl className={cn('divide-y divide-border/60', className)}>
      {items.map((item) => (
        <div key={item.label} className="flex items-start justify-between gap-6 py-2.5">
          <dt className="shrink-0 text-sm text-muted-foreground">{item.label}</dt>
          <dd className="min-w-0 text-right text-sm text-foreground [overflow-wrap:anywhere]">
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
