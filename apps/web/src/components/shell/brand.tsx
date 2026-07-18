import { Link } from 'react-router-dom';

import { config } from '@/config';
import { cn } from '@/lib/utils';

// Actionow 品牌标识：闪电徽标 + 名称（VITE_BRAND_NAME 白标）。
// 保留外层 focus ring 与尺寸结构（graphite 品牌单通道约定）。
function Brand({
  label = config.brandName,
  to = '/',
  compact = false,
  className,
}: {
  label?: string;
  to?: string;
  compact?: boolean;
  className?: string;
}) {
  return (
    <Link
      to={to}
      className={cn(
        'inline-flex items-center gap-2.5 rounded-lg outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        className,
      )}
    >
      <span
        className="flex size-8 items-center justify-center rounded-lg bg-foreground text-background shadow-sm"
        aria-hidden="true"
      >
        <svg viewBox="0 0 16 16" className="size-4" fill="currentColor">
          <path d="M9.7 1 3.2 9.2h3.6L5.6 15l6.9-8.6H8.8L9.7 1z" />
        </svg>
      </span>
      {compact ? null : <span className="text-base font-semibold tracking-[-0.02em]">{label}</span>}
    </Link>
  );
}

export { Brand };
