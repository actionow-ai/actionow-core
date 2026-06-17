import { CircleNotchIcon } from '@phosphor-icons/react';
import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router-dom';

type Variant = 'cta' | 'ghost' | 'link' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const sizes: Record<Size, CSSProperties> = {
  sm: { fontSize: 'var(--fs-caption)', padding: '6px 12px' },
  md: { fontSize: 'var(--fs-sm)', padding: '9px 16px' },
  lg: { fontSize: 'var(--fs-base)', padding: '12px 22px' },
};

function styleFor(variant: Variant, size: Size): CSSProperties {
  const base: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    fontWeight: 650,
    borderRadius: 'var(--r-pill)',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    border: '1px solid transparent',
    transition: 'transform 0.2s ease, box-shadow 0.2s ease, background 0.2s ease, border-color 0.2s ease',
    ...sizes[size],
  };
  if (variant === 'cta') {
    return { ...base, color: 'var(--ink)', background: 'var(--grad-accent)', boxShadow: 'var(--shadow-cta)' };
  }
  if (variant === 'danger') {
    return { ...base, color: 'var(--fail)', background: 'transparent', borderColor: 'var(--fail)' };
  }
  if (variant === 'link') {
    return {
      ...base,
      color: 'var(--accent)',
      background: 'transparent',
      border: 'none',
      padding: 0,
      borderRadius: 0,
      boxShadow: 'none',
    };
  }
  return { ...base, color: 'var(--text)', background: 'var(--glass-bg)', borderColor: 'var(--glass-bd)' };
}

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

export function Button({ children, variant = 'cta', size = 'md', to, href, onClick, className, type, disabled, loading }: Props) {
  const style = styleFor(variant, size);
  // The `link` variant is text-only, so it skips the tactile push.
  const cls = `${variant === 'link' ? '' : 'btn-tactile'} ${className ?? ''}`.trim();
  if (to) {
    return (
      <Link to={to} className={cls} style={style}>
        {children}
      </Link>
    );
  }
  if (href) {
    return (
      <a href={href} className={cls} style={style}>
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
      style={isBlocked ? { ...style, opacity: 0.7, cursor: 'default' } : style}
    >
      {loading === true && <CircleNotchIcon size={15} weight="bold" className="refresh-spin" aria-hidden="true" />}
      {children}
    </button>
  );
}
