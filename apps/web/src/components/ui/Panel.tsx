import type { CSSProperties, ReactNode } from 'react';

/** A `.panel` vertical-stack container — bakes the repeated
 *  {borderRadius, flex column, gap, padding} so detail pages stop copy-pasting it. */
export function Panel({
  children,
  gap = 'var(--s-3)',
  padding = 'var(--s-4)',
  maxWidth,
  className,
  style,
}: {
  children: ReactNode;
  gap?: string;
  padding?: string;
  maxWidth?: number | string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={className ? `panel ${className}` : 'panel'}
      style={{
        borderRadius: 'var(--r-md)',
        display: 'flex',
        flexDirection: 'column',
        gap,
        padding,
        ...(maxWidth !== undefined ? { maxWidth } : {}),
        ...style,
      }}
    >
      {children}
    </div>
  );
}
