// Animate UI does not publish styled data-display registry items. These local primitives follow its official tokens, spacing, radius, and accessibility conventions.
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/components/buttons/button';
import { RefreshCwIcon } from '@/components/ui/icons/refresh-cw';
import { SearchIcon } from '@/components/ui/icons/search';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { SortDirection } from '@/hooks/use-data-table';
import { cn } from '@/lib/utils';

const DEFAULT_PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

function Card({ className, interactive = false, ...props }: React.ComponentProps<typeof motion.div> & { interactive?: boolean }) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      whileHover={interactive && !reduceMotion ? { y: -2 } : undefined}
      transition={{ type: 'spring', stiffness: 320, damping: 26 }}
      className={cn('rounded-xl bg-surface shadow-card', className)}
      {...props}
    />
  );
}

const badgeVariants = cva('inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium', {
  variants: {
    variant: {
      neutral: 'bg-surface-strong text-muted-foreground',
      primary: 'bg-primary text-primary-foreground',
      success: 'bg-success/12 text-success',
      warning: 'bg-warning/15 text-warning',
      danger: 'bg-danger/12 text-danger',
    },
  },
  defaultVariants: { variant: 'neutral' },
});

function Badge({ className, variant, ...props }: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

function DataTable({ className, ...props }: React.ComponentProps<'table'>) {
  return <table className={cn('w-full min-w-[720px] border-collapse text-left text-sm', className)} {...props} />;
}

function DataTableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return <thead className={cn('border-b text-xs text-muted-foreground', className)} {...props} />;
}

function DataTableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return <tbody className={cn('divide-y', className)} {...props} />;
}

function DataTableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return <tr className={cn('transition-colors hover:bg-surface-subtle/70', className)} {...props} />;
}

function DataTableHead({ className, ...props }: React.ComponentProps<'th'>) {
  return <th className={cn('px-4 py-3 font-semibold', className)} {...props} />;
}

function DataTableSortHead({
  children,
  direction,
  onToggle,
  className,
}: {
  children: React.ReactNode;
  direction: SortDirection | null;
  onToggle: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const SortIcon = direction === 'asc' ? ArrowUp : direction === 'desc' ? ArrowDown : ChevronsUpDown;
  return (
    <th
      className={cn('p-0 font-semibold', className)}
      aria-sort={direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none'}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-label={typeof children === 'string' ? t('table.sortBy', { column: children }) : undefined}
        className={cn(
          'flex w-full items-center gap-1.5 px-4 py-3 text-left font-semibold whitespace-nowrap outline-hidden transition-colors hover:text-foreground focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
          direction && 'text-foreground',
        )}
      >
        {children}
        <SortIcon className="size-3.5 shrink-0" aria-hidden="true" />
      </button>
    </th>
  );
}

// Unified table footer: total on the left; page-size selector and page navigation on the right.
// Passing `onPageSizeChange` opts a table into the per-page control; `total === undefined` (cursor
// pagination) hides the running total but keeps navigation.
function DataTablePagination({
  page,
  pageCount,
  total,
  pageSize,
  pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
  onPageChange,
  onPageSizeChange,
  className,
}: {
  page: number;
  pageCount: number;
  total?: number;
  pageSize?: number;
  pageSizeOptions?: number[];
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const showPageSize = onPageSizeChange !== undefined && pageSize !== undefined;
  if (total === undefined && pageCount <= 1 && !showPageSize) return null;
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t px-4 py-2.5 text-xs text-muted-foreground', className)}>
      <span>{total === undefined ? null : t('table.total', { count: total })}</span>
      <div className="flex items-center gap-4">
        {showPageSize ? (
          <label className="flex items-center gap-2">
            <span className="whitespace-nowrap">{t('table.pageSize')}</span>
            <Select value={String(pageSize)} onValueChange={(value) => onPageSizeChange(Number(value))}>
              <SelectTrigger className="h-8 w-auto gap-1.5 px-3 text-xs" aria-label={t('table.pageSize')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {pageSizeOptions.map((size) => (
                  <SelectItem key={size} value={String(size)}>{size}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        ) : null}
        {pageCount > 1 ? (
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="icon-sm" aria-label={t('table.previousPage')} disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
              <ChevronLeft />
            </Button>
            <span className="min-w-12 text-center font-mono tabular-nums">{total === undefined ? page : t('table.pageOf', { page, pageCount })}</span>
            <Button variant="ghost" size="icon-sm" aria-label={t('table.nextPage')} disabled={page >= pageCount} onClick={() => onPageChange(page + 1)}>
              <ChevronRight />
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// Unified table header: an optional search field (left, grows), a filter/action slot, and an
// optional refresh button (right). Pages pass their own filter controls as children so every table
// shares one toolbar layout instead of hand-rolling the arrangement.
function DataTableToolbar({
  title,
  search,
  onRefresh,
  refreshing = false,
  children,
  className,
}: {
  title?: React.ReactNode;
  search?: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    ariaLabel?: string;
  };
  onRefresh?: () => void;
  refreshing?: boolean;
  children?: React.ReactNode;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className={cn('flex flex-wrap items-center gap-3 border-b p-4', className)}>
      {title ? <div className="flex items-center gap-2 font-semibold">{title}</div> : null}
      {search ? (
        <div className="relative min-w-56 flex-1">
          <SearchIcon className="pointer-events-none absolute top-2.5 left-3 text-muted-foreground" size={16} aria-hidden="true" />
          <Input
            className="pl-9"
            value={search.value}
            onChange={(event) => search.onChange(event.target.value)}
            placeholder={search.placeholder ?? t('table.searchPlaceholder')}
            aria-label={search.ariaLabel ?? search.placeholder ?? t('table.search')}
          />
        </div>
      ) : null}
      {children}
      {onRefresh ? (
        <Button
          type="button"
          variant="outline"
          size="icon-lg"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label={t('table.refresh')}
          className="ml-auto shrink-0"
        >
          <RefreshCwIcon animateOnHover className={refreshing ? 'animate-spin' : undefined} />
        </Button>
      ) : null}
    </div>
  );
}

function DataTableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return <td className={cn('px-4 py-3.5 align-middle', className)} {...props} />;
}

function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('animate-pulse rounded-md bg-surface-strong', className)} {...props} />;
}

export {
  Badge,
  Card,
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTablePagination,
  DataTableRow,
  DataTableSortHead,
  DataTableToolbar,
  Skeleton,
};
