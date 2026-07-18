import * as React from 'react';

export type SortDirection = 'asc' | 'desc';

export interface TableSort {
  key: string;
  direction: SortDirection;
}

// Client-side sorting and pagination over an already-filtered row set. Pages
// keep their own filter state (search inputs, enum selects) and pass the
// filtered rows in; the hook resets to page one whenever that set shrinks or
// grows so filters never point at an out-of-range page.
export function useDataTable<T>(
  rows: T[],
  options: {
    pageSize?: number;
    sortValues: Record<string, (row: T) => string | number | null>;
    initialSort?: TableSort;
  },
) {
  const { pageSize: initialPageSize = 10, sortValues, initialSort } = options;
  const [sort, setSort] = React.useState<TableSort | null>(initialSort ?? null);
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSizeState] = React.useState(initialPageSize);

  const sorted = React.useMemo(() => {
    if (!sort) return rows;
    const getter = sortValues[sort.key];
    if (!getter) return rows;
    const factor = sort.direction === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const left = getter(a);
      const right = getter(b);
      if (left === null && right === null) return 0;
      if (left === null) return 1;
      if (right === null) return -1;
      if (typeof left === 'number' && typeof right === 'number') return (left - right) * factor;
      return String(left).localeCompare(String(right), 'zh-Hans-CN') * factor;
    });
  }, [rows, sort, sortValues]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const pageRows = React.useMemo(
    () => sorted.slice((safePage - 1) * pageSize, safePage * pageSize),
    [sorted, safePage, pageSize],
  );

  React.useEffect(() => {
    setPage(1);
  }, [rows.length]);

  const toggleSort = (key: string) => {
    setPage(1);
    setSort((current) => {
      if (current?.key !== key) return { key, direction: 'asc' };
      return current.direction === 'asc' ? { key, direction: 'desc' } : null;
    });
  };

  return {
    rows: pageRows,
    total: sorted.length,
    page: safePage,
    pageCount,
    setPage,
    pageSize,
    setPageSize: (value: number) => {
      setPageSizeState(value);
      setPage(1);
    },
    sort,
    toggleSort,
    directionFor: (key: string): SortDirection | null =>
      sort?.key === key ? sort.direction : null,
  };
}
