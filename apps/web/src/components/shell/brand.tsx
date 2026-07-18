import { Link } from 'react-router-dom';

import { cn } from '@/lib/utils';

// 占位品牌标识：四格方块 + 名称。消费方项目应整体替换 logo 与文字，
// 但保留外层 focus ring 与尺寸结构。
function Brand({ label = 'Graphite', to = '/', compact = false, className }: { label?: string; to?: string; compact?: boolean; className?: string }) {
  return (
    <Link to={to} className={cn('inline-flex items-center gap-2.5 rounded-lg outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring', className)}>
      <span className="grid size-8 grid-cols-2 gap-0.5 rounded-lg bg-foreground p-1.5 text-background shadow-sm" aria-hidden="true">
        <span className="rounded-[2px] bg-background" />
        <span className="rounded-[2px] bg-background/55" />
        <span className="rounded-[2px] bg-background/55" />
        <span className="rounded-[2px] bg-background" />
      </span>
      {compact ? null : <span className="text-base font-semibold tracking-[-0.02em]">{label}</span>}
    </Link>
  );
}

export { Brand };
