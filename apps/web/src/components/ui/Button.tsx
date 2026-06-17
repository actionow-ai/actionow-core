import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router-dom';

type Variant = 'cta' | 'ghost';
type Size = 'md' | 'lg';

const sizes: Record<Size, CSSProperties> = {
  md: { fontSize: 'var(--fs-sm)', padding: '9px 16px' },
  lg: { fontSize: 'var(--fs-base)', padding: '12px 22px' },
};

function styleFor(variant: Variant, size: Size): CSSProperties {
  const base: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
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
    return {
      ...base,
      color: 'var(--ink)',
      background: 'var(--grad-accent)',
      boxShadow: 'var(--shadow-cta)',
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
}

export function Button({ children, variant = 'cta', size = 'md', to, href, onClick, className, type, disabled }: Props) {
  const style = styleFor(variant, size);
  const cls = `btn-tactile ${className ?? ''}`;
  if (to) return <Link to={to} className={cls} style={style}>{children}</Link>;
  if (href) return <a href={href} className={cls} style={style}>{children}</a>;
  return (
    <button
      type={type ?? 'button'}
      onClick={onClick}
      disabled={disabled}
      className={cls}
      style={disabled ? { ...style, opacity: 0.7, cursor: 'default' } : style}
    >
      {children}
    </button>
  );
}
