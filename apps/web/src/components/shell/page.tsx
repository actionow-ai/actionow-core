import { motion, useReducedMotion } from 'motion/react';
import { useTranslation } from 'react-i18next';

import { Card, Skeleton } from '@/components/ui/data-display';
import { DURATION, EASE_OUT } from '@/lib/motion';
import { cn } from '@/lib/utils';

function PageTransition({ children }: { children: React.ReactNode }) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DURATION.base, ease: EASE_OUT }}
      className="mx-auto w-full max-w-[1440px]"
    >
      {children}
    </motion.div>
  );
}

function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-[-0.035em] sm:text-[1.75rem]">{title}</h1>
        <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

function StatCard({
  title,
  value,
  detail,
  icon,
  emphasis = false,
  loading = false,
}: {
  title: string;
  value: string;
  detail: string;
  icon: React.ElementType;
  emphasis?: boolean;
  loading?: boolean;
}) {
  const { t } = useTranslation();
  const Icon = icon;
  return (
    <Card
      className={cn('relative overflow-hidden p-5', emphasis && 'bg-surface-strong/60 shadow-none')}
      interactive
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">{title}</p>
          {loading ? (
            <Skeleton className="mt-3.5 h-7 w-16 rounded-md" aria-label={t('pageChrome.loading')} />
          ) : (
            <p className="mt-3 font-mono text-2xl font-semibold tracking-[-0.04em]">{value}</p>
          )}
          <p className="mt-1.5 text-xs text-muted-foreground">{detail}</p>
        </div>
        <span
          className={cn(
            'flex size-9 items-center justify-center rounded-lg bg-surface-strong text-muted-foreground',
            emphasis && 'bg-surface text-foreground shadow-xs',
          )}
        >
          <Icon className="size-4" />
        </span>
      </div>
    </Card>
  );
}

function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  const Icon = icon;
  return (
    <div className="flex min-h-72 flex-col items-center justify-center px-6 py-12 text-center">
      <span className="flex size-11 items-center justify-center rounded-xl bg-surface-strong text-muted-foreground">
        <Icon className="size-5" />
      </span>
      <h2 className="mt-4 text-base font-semibold">{title}</h2>
      <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted-foreground">{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export { EmptyState, PageHeader, PageTransition, StatCard };
