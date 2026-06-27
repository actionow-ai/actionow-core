import { CircleNotchIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

type Variant = 'cta' | 'ghost' | 'link' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface Props {
  children: ReactNode;
  variant?: Variant;
  size?: Size;
  to?: string;
  href?: string;
  onClick?: () => void;
  className?: string;
  type?: 'button' | 'submit';
  disabled?: boolean;
  loading?: boolean;
}

/**
 * The system button. Visual styling (variants cta/ghost/danger/link, sizes
 * sm/md/lg, hover/active/disabled) lives in the `.btn` class block in
 * `styles/glass.css` so hover/active states resolve in CSS; this component only
 * composes the classes and the `to`/`href`/`button` polymorphism. `md` is the
 * base size, so only `sm`/`lg` add a size class; `link` is text-only and ignores
 * size padding.
 */
export function Button({
  children,
  variant = 'cta',
  size = 'md',
  to,
  href,
  onClick,
  className,
  type,
  disabled,
  loading,
}: Props) {
  const sizeCls =
    variant === 'link' ? '' : size === 'sm' ? 'btn-sm' : size === 'lg' ? 'btn-lg' : '';
  const cls = `btn btn-${variant} ${sizeCls} ${className ?? ''}`.replace(/\s+/g, ' ').trim();
  if (to) {
    return (
      <Link to={to} className={cls}>
        {children}
      </Link>
    );
  }
  if (href) {
    return (
      <a href={href} className={cls}>
        {children}
      </a>
    );
  }
  const isBlocked = disabled === true || loading === true;
  return (
    <button
      type={type ?? 'button'}
      onClick={onClick}
      disabled={isBlocked}
      aria-busy={loading === true ? true : undefined}
      className={cls}
    >
      {loading === true && (
        <CircleNotchIcon size={15} weight="bold" className="refresh-spin" aria-hidden="true" />
      )}
      {children}
    </button>
  );
}
