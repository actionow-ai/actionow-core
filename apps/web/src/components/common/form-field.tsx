import type { ReactNode } from 'react';
import { useId } from 'react';

import { cn } from '@/lib/utils';

/**
 * Labelled form row: label + control + optional hint/error line. Pass a render
 * function to receive the generated control id for `htmlFor` association.
 */
export function FormField({
  label,
  hint,
  error,
  className,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  className?: string;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      {children(id)}
      {error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : hint ? (
        <p className="text-sm text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
