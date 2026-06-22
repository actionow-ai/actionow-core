import {
  CaretDownIcon,
  CaretUpDownIcon,
  CaretUpIcon,
  ColumnsIcon,
  MagnifyingGlassIcon,
  XIcon,
} from '@phosphor-icons/react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { BP } from '../../lib/breakpoints';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { Z } from '../../lib/zIndex';
import { Checkbox } from '../ui/Checkbox';
import { IconButton } from '../ui/IconButton';
import { RoseLoader } from '../ui/RoseLoader';
import { ErrorState } from './ErrorState';
import {
  clampPage,
  deselectAll,
  filterRows,
  indeterminate,
  isAllSelected,
  nextSortDirection,
  paginate,
  selectAll,
  type SortDirection,
  sortRows,
  toggleKey,
  totalPages,
} from './tableState';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  width?: string;
  /** Horizontal alignment of the header + cells (numeric columns → `right`). */
  align?: 'left' | 'right' | 'center';
  /** Pin this column to an edge during horizontal scroll. */
  sticky?: 'left' | 'right';
  /** When false, the column can't be hidden via the columns menu. Default true. */
  hideable?: boolean;
  /** Make the header a sort toggle (asc → desc → none). */
  sortable?: boolean;
  /** Comparable value used when sorting; defaults to the stringified cell. */
  sortValue?: (row: T) => string | number;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  empty?: ReactNode;
  loading?: boolean;
  /** Render an error + retry state in place of rows when the backing query failed. */
  error?: boolean;
  /** Retry handler for the error state — wire to the query's `refetch`. */
  onRetry?: () => void;
  fill?: boolean;
  onRowClick?: (row: T) => void;
  selectedKey?: string;
  /** Paginate client-side when the filtered rows exceed this size. */
  pageSize?: number;
  /** Show a global (all-visible-columns) search box above the table. */
  searchable?: boolean;
  /** Custom text projection used for search; defaults to stringified cells. */
  filterKeys?: (row: T) => string;
  /** Trailing, right-pinned per-row action buttons. */
  rowActions?: (row: T) => ReactNode;
  /** Reserved width of the row-actions column. Required when `rowActions` are
   * wider than a single control: `table-layout: fixed` can't shrink-to-content,
   * so without an explicit width the pinned cell overflows the scrollport.
   * Defaults to `1` (auto-min) for a single-control actions cell. */
  actionsWidth?: string;
  /** Leading checkbox column + select-all; pairs with `bulkActions`. */
  selectable?: boolean;
  /** Bulk-action bar slot, shown when ≥1 row is selected. */
  bulkActions?: (selected: T[], clear: () => void) => ReactNode;
  /** Show the "columns" visibility menu. */
  columnToggle?: boolean;
}

/** A subtle shadow on a pinned column edge so scrolled cells don't read as flush. */
const STICKY_LEFT_SHADOW = '2px 0 4px -2px var(--scrim)';
const STICKY_RIGHT_SHADOW = '-2px 0 4px -2px var(--scrim)';

function stickyCellStyle(sticky: Column<unknown>['sticky'], header: boolean): CSSProperties {
  if (sticky === undefined) return {};
  return {
    position: 'sticky',
    left: sticky === 'left' ? 0 : undefined,
    right: sticky === 'right' ? 0 : undefined,
    zIndex: header ? 3 : 1,
    // Near-opaque (not the semi-transparent --panel-bg) so a pinned column/header
    // can't faintly show scrolled content through its edge.
    background: 'var(--overlay-bg)',
    boxShadow: sticky === 'left' ? STICKY_LEFT_SHADOW : STICKY_RIGHT_SHADOW,
  };
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  empty,
  loading,
  error,
  onRetry,
  fill,
  onRowClick,
  selectedKey,
  pageSize,
  searchable,
  filterKeys,
  rowActions,
  actionsWidth,
  selectable,
  bulkActions,
  columnToggle,
}: DataTableProps<T>) {
  const { t } = useTranslation('console');
  const isDesktop = useMediaQuery(BP.md);
  const clickable = onRowClick !== undefined;
  // A row may only adopt role="button" (with tabIndex/aria-pressed/keydown) when
  // it has no nested interactive controls. role="button" can't contain
  // interactive descendants (invalid ARIA) and it clobbers the implicit row
  // role, so row-as-button is mutually exclusive with selection + row-actions.
  // When clickable AND (selectable | rowActions), the row stays a plain
  // clickable row (onClick + pointer/hover only); interact via the
  // checkbox/action cells instead.
  const rowAsButton = clickable && selectable !== true && rowActions === undefined;

  // --- Local view state ---------------------------------------------------
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<{ key: string; dir: SortDirection }>({ key: '', dir: 'none' });
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  // Columns currently rendered (visibility menu drops hidden ones).
  const visibleColumns = useMemo(
    () => columns.filter((c) => !hidden.has(c.key)),
    [columns, hidden],
  );

  // Default search projection: stringify every visible cell.
  const projectText = useMemo(() => {
    if (filterKeys !== undefined) return filterKeys;
    return (row: T) => visibleColumns.map((c) => cellToText(c.cell(row))).join(' ');
  }, [filterKeys, visibleColumns]);

  // --- Derive the rows to render -----------------------------------------
  const filtered = useMemo(
    () => (searchable === true ? filterRows(rows, query, projectText) : rows),
    [rows, query, projectText, searchable],
  );

  const sortedColumn = sort.dir !== 'none' ? columns.find((c) => c.key === sort.key) : undefined;
  const sorted = useMemo(() => {
    if (sortedColumn === undefined) return filtered;
    const value = sortedColumn.sortValue ?? ((row: T) => cellToText(sortedColumn.cell(row)));
    return sortRows(filtered, value, sort.dir);
  }, [filtered, sortedColumn, sort.dir]);

  const paged = pageSize !== undefined && pageSize > 0 ? paginate(sorted, page, pageSize) : sorted;
  const pages = pageSize !== undefined && pageSize > 0 ? totalPages(sorted.length, pageSize) : 1;
  const showPager = pageSize !== undefined && pageSize > 0 && sorted.length > pageSize;

  // Keep the current page in range when the result set shrinks (e.g. a row is
  // removed or a filter narrows the list below the current page).
  useEffect(() => {
    if (pageSize === undefined || pageSize <= 0) return;
    setPage((p) => clampPage(p, sorted.length, pageSize));
  }, [sorted.length, pageSize]);
  // Filtering changes the result set → jump back to the first page.
  useEffect(() => {
    setPage(1);
  }, [query]);

  // --- Selection ----------------------------------------------------------
  const pageKeys = useMemo(() => paged.map((r) => rowKey(r)), [paged, rowKey]);
  const allOnPage = isAllSelected(selected, pageKeys);
  const someOnPage = indeterminate(selected, pageKeys);
  const selectedRows = useMemo(
    () => rows.filter((r) => selected.has(rowKey(r))),
    [rows, selected, rowKey],
  );

  const clearSelection = () => setSelected(new Set());
  const toggleRow = (key: string) => setSelected((s) => toggleKey(s, key));
  const toggleSelectAll = () =>
    setSelected((s) =>
      isAllSelected(s, pageKeys) ? deselectAll(s, pageKeys) : selectAll(s, pageKeys),
    );

  const onSort = (col: Column<T>) => {
    setSort((prev) => {
      const dir = prev.key === col.key ? nextSortDirection(prev.dir) : 'asc';
      return { key: col.key, dir };
    });
  };

  const hideableColumns = columns.filter((c) => c.hideable !== false);

  // --- Shared cells -------------------------------------------------------
  const loadingState = (
    <div style={{ padding: 'var(--s-6)', display: 'grid', placeItems: 'center' }}>
      <RoseLoader size={56} />
    </div>
  );
  const errorState = <ErrorState onRetry={onRetry} />;
  const emptyState = (
    <div
      style={{
        padding: 'var(--s-6)',
        color: 'var(--muted)',
        fontSize: 'var(--fs-sm)',
        textAlign: 'center',
      }}
    >
      {query.trim() !== '' && rows.length > 0 ? t('table.noMatches') : empty}
    </div>
  );

  // A clickable row is a toggle in master-detail; expose selected to AT.
  const rowInteraction = (r: T) => {
    const selectedRow = selectedKey !== undefined && rowKey(r) === selectedKey;
    if (!clickable) return { selectedRow, handlers: {} as const };
    // Plain clickable row (has selection/row-actions): keep onClick + the
    // pointer/hover affordance via .dt-row, but NOT role="button"/tabIndex/
    // aria-pressed/keydown — those would nest interactive controls inside a
    // button (invalid ARIA) and override the implicit row role.
    if (!rowAsButton) {
      return {
        selectedRow,
        handlers: {
          className: 'dt-row',
          onClick: () => onRowClick(r),
        },
      };
    }
    return {
      selectedRow,
      handlers: {
        className: 'dt-row',
        onClick: () => onRowClick(r),
        role: 'button' as const,
        tabIndex: 0,
        'aria-pressed': selectedRow,
        onKeyDown: (e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onRowClick(r);
          }
        },
      },
    };
  };

  // Toolbar above the table (search + columns menu); rendered when any apply.
  const toolbar =
    searchable === true || (columnToggle === true && hideableColumns.length > 0) ? (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--s-3)',
          marginBottom: 'var(--s-3)',
        }}
      >
        {searchable === true && (
          <SearchBox value={query} onChange={setQuery} placeholder={t('table.search')} />
        )}
        <div style={{ flex: 1 }} />
        {columnToggle === true && hideableColumns.length > 0 && (
          <ColumnsMenu
            label={t('table.columns')}
            columns={hideableColumns}
            hidden={hidden}
            onToggle={(key) => setHidden((h) => toggleKey(h, key))}
          />
        )}
      </div>
    ) : null;

  // Bulk-action bar (selection summary + custom slot + clear).
  const bulkBar =
    selectable === true && selectedRows.length > 0 ? (
      <div
        role="region"
        aria-label={t('table.selected', { n: selectedRows.length })}
        className="panel"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--s-3)',
          flexWrap: 'wrap',
          padding: 'var(--s-2) var(--s-3)',
          marginBottom: 'var(--s-3)',
          borderRadius: 'var(--r-sm)',
          fontSize: 'var(--fs-sm)',
        }}
      >
        <span style={{ fontWeight: 'var(--fw-medium)', whiteSpace: 'nowrap' }}>
          {t('table.selected', { n: selectedRows.length })}
        </span>
        {bulkActions?.(selectedRows, clearSelection)}
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={clearSelection}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--muted)',
            cursor: 'pointer',
            fontSize: 'var(--fs-sm)',
            whiteSpace: 'nowrap',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--s-1)',
          }}
        >
          <XIcon size={13} weight="bold" />
          {t('table.clear')}
        </button>
      </div>
    ) : null;

  // ----- Mobile: keep the stacked-card view (existing behavior) -----------
  if (!isDesktop) {
    return (
      <MobileShell fill={fill} toolbar={toolbar} bulkBar={bulkBar}>
        {error === true
          ? errorState
          : loading === true
            ? loadingState
            : paged.length === 0
              ? emptyState
              : paged.map((r) => {
                const { selectedRow, handlers } = rowInteraction(r);
                // Compact card: the first (identity) column spans full width as the
                // card's headline; the rest pack into a 2-up grid so a wide table
                // (e.g. 7 model columns) is ~3 grid rows, not a one-screen stack.
                const [primaryCol, ...restCols] = visibleColumns;
                return (
                  <div
                    key={rowKey(r)}
                    {...handlers}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 'var(--s-3)',
                      padding: 'var(--s-4)',
                      // A clickable card must clear the min touch target even for a short row.
                      minHeight: clickable ? 'var(--min-touch)' : undefined,
                      borderBottom: '1px solid var(--row-bd)',
                      background: selectedRow ? 'var(--hover-bg)' : undefined,
                    }}
                  >
                    {visibleColumns.length > 0 && (
                      <div
                        style={{
                          fontSize: 'var(--fs-base)',
                          fontWeight: 'var(--fw-medium)',
                          minWidth: 0,
                          overflow: 'hidden',
                        }}
                      >
                        {primaryCol.cell(r)}
                      </div>
                    )}
                    {restCols.length > 0 && (
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                          gap: 'var(--s-2) var(--s-4)',
                        }}
                      >
                        {restCols.map((c) => (
                          <Field key={c.key} header={c.header} value={c.cell(r)} />
                        ))}
                      </div>
                    )}
                    {(selectable === true || rowActions !== undefined) && (
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 'var(--s-3)',
                          borderTop: '1px solid var(--row-bd)',
                          paddingTop: 'var(--s-2)',
                          marginTop: 'var(--s-1)',
                        }}
                      >
                        {selectable === true ? (
                          <span onClick={stop} onKeyDown={stopKey} role="presentation">
                            <Checkbox
                              checked={selected.has(rowKey(r))}
                              onChange={() => toggleRow(rowKey(r))}
                              ariaLabel={t('table.selectRow')}
                            />
                          </span>
                        ) : (
                          <span />
                        )}
                        {rowActions !== undefined && (
                          <span
                            onClick={stop}
                            onKeyDown={stopKey}
                            role="presentation"
                            style={{ display: 'inline-flex', gap: 'var(--s-2)' }}
                          >
                            {rowActions(r)}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
        {showPager && (
          <Pager page={page} pages={pages} total={sorted.length} onPage={setPage} t={t} />
        )}
      </MobileShell>
    );
  }

  // ----- Desktop: a real <table> for natural sticky header + columns ------
  const colCount =
    visibleColumns.length + (selectable === true ? 1 : 0) + (rowActions !== undefined ? 1 : 0);

  // Content floor: with `table-layout: fixed`, a width-less column (e.g. `name`)
  // absorbs leftover space and clamps to 0px once the container is narrower than
  // the sum of fixed widths (the global `* { min-width: 0 }` reset lets it
  // collapse instead of scrolling). Floor the table at the sum of declared
  // widths so it scrolls horizontally and no column disappears.
  const DEFAULT_COL_W = 160;
  const pxWidth = (w?: string) => {
    const m = w !== undefined ? /^(\d+)px$/.exec(w) : null;
    return m ? Number(m[1]) : DEFAULT_COL_W;
  };
  const actionsPx = (() => {
    const m = actionsWidth !== undefined ? /^(\d+)px$/.exec(actionsWidth) : null;
    return m ? Number(m[1]) : 80;
  })();
  const contentMinWidth =
    visibleColumns.reduce((sum, c) => sum + pxWidth(c.width), 0) +
    (selectable === true ? 44 : 0) +
    (rowActions !== undefined ? actionsPx : 0);

  return (
    <div
      style={
        fill === true
          ? { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }
          : undefined
      }
    >
      {toolbar}
      {bulkBar}
      <div
        className="panel"
        style={{
          borderRadius: 'var(--r-md)',
          overflowX: 'auto',
          ...(fill === true
            ? { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflowY: 'auto' }
            : null),
        }}
      >
        <table
          style={{
            width: '100%',
            minWidth: Math.max(520, contentMinWidth),
            borderCollapse: 'separate',
            borderSpacing: 0,
            tableLayout: 'fixed',
          }}
        >
          <thead>
            <tr>
              {selectable === true && (
                <th
                  scope="col"
                  style={{
                    ...headerCellStyle,
                    width: 44,
                    ...stickyCellStyle('left', true),
                  }}
                >
                  <span onClick={stop} onKeyDown={stopKey} role="presentation">
                    <Checkbox
                      checked={allOnPage}
                      onChange={toggleSelectAll}
                      ariaLabel={t('table.selectAll')}
                      indeterminate={someOnPage}
                    />
                  </span>
                </th>
              )}
              {visibleColumns.map((c) => {
                const isSorted = sort.key === c.key && sort.dir !== 'none';
                const ariaSort = !isSorted
                  ? 'none'
                  : sort.dir === 'asc'
                    ? 'ascending'
                    : 'descending';
                return (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={c.sortable === true ? ariaSort : undefined}
                    style={{
                      ...headerCellStyle,
                      width: c.width,
                      ...(c.align !== undefined ? { textAlign: c.align } : {}),
                      ...stickyCellStyle(c.sticky, true),
                    }}
                  >
                    {c.sortable === true ? (
                      <button
                        type="button"
                        onClick={() => onSort(c)}
                        aria-label={t('table.sortBy', { column: headerText(c.header) })}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 'var(--s-1)',
                          background: 'transparent',
                          border: 'none',
                          padding: 0,
                          cursor: 'pointer',
                          color: 'inherit',
                          font: 'inherit',
                          textTransform: 'inherit',
                          letterSpacing: 'inherit',
                        }}
                      >
                        {c.header}
                        <SortCaret active={isSorted} dir={sort.dir} />
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
              {rowActions !== undefined && (
                <th
                  scope="col"
                  aria-hidden="true"
                  style={{
                    ...headerCellStyle,
                    width: actionsWidth ?? 1,
                    ...stickyCellStyle('right', true),
                  }}
                />
              )}
            </tr>
          </thead>
          <tbody>
            {error === true ? (
              <tr>
                <td colSpan={colCount}>{errorState}</td>
              </tr>
            ) : loading === true ? (
              <tr>
                <td colSpan={colCount}>{loadingState}</td>
              </tr>
            ) : paged.length === 0 ? (
              <tr>
                <td colSpan={colCount}>{emptyState}</td>
              </tr>
            ) : (
              paged.map((r) => {
                const key = rowKey(r);
                const { selectedRow, handlers } = rowInteraction(r);
                const rowBg = selectedRow ? 'var(--hover-bg)' : undefined;
                return (
                  <tr
                    key={key}
                    {...handlers}
                    style={{
                      borderBottom: '1px solid var(--row-bd)',
                      background: rowBg,
                      boxShadow: selectedRow ? 'inset 2px 0 0 var(--accent)' : undefined,
                    }}
                  >
                    {selectable === true && (
                      <td
                        style={{
                          ...bodyCellStyle,
                          ...stickyCellStyle('left', false),
                          background: rowBg ?? 'var(--overlay-bg)',
                        }}
                      >
                        <span onClick={stop} onKeyDown={stopKey} role="presentation">
                          <Checkbox
                            checked={selected.has(key)}
                            onChange={() => toggleRow(key)}
                            ariaLabel={t('table.selectRow')}
                          />
                        </span>
                      </td>
                    )}
                    {visibleColumns.map((c) => (
                      <td
                        key={c.key}
                        style={{
                          ...bodyCellStyle,
                          ...stickyCellStyle(c.sticky, false),
                          ...(c.sticky !== undefined
                            ? { background: rowBg ?? 'var(--overlay-bg)' }
                            : null),
                        }}
                      >
                        <div
                          style={{
                            minWidth: 0,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            ...(c.align !== undefined ? { textAlign: c.align } : {}),
                          }}
                        >
                          {c.cell(r)}
                        </div>
                      </td>
                    ))}
                    {rowActions !== undefined && (
                      <td
                        style={{
                          ...bodyCellStyle,
                          ...stickyCellStyle('right', false),
                          background: rowBg ?? 'var(--overlay-bg)',
                          whiteSpace: 'nowrap',
                          width: actionsWidth ?? 1,
                          textAlign: 'right',
                        }}
                      >
                        <span
                          onClick={stop}
                          onKeyDown={stopKey}
                          role="presentation"
                          style={{ display: 'inline-flex', gap: 'var(--s-2)' }}
                        >
                          {rowActions(r)}
                        </span>
                      </td>
                    )}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {showPager && (
        <Pager page={page} pages={pages} total={sorted.length} onPage={setPage} t={t} />
      )}
    </div>
  );
}

// --- Style fragments ------------------------------------------------------
const headerCellStyle: CSSProperties = {
  textAlign: 'left',
  padding: '11px var(--s-4)',
  fontSize: 'var(--fs-caption)',
  fontWeight: 'var(--fw-medium)',
  textTransform: 'uppercase',
  letterSpacing: '.05em',
  color: 'var(--muted)',
  borderBottom: '1px solid var(--row-bd)',
  whiteSpace: 'nowrap',
  position: 'sticky',
  top: 0,
  // Sticky header sits over scrolled rows: use the near-opaque overlay token
  // (not the semi-transparent --panel-bg) so content can't show through.
  background: 'var(--overlay-bg)',
  zIndex: 2,
};

const bodyCellStyle: CSSProperties = {
  padding: 'var(--s-3) var(--s-4)',
  fontSize: 'var(--fs-sm)',
  verticalAlign: 'middle',
};

// Stop checkbox / action clicks (and their keyboard activation) from bubbling
// to the row's onRowClick handler.
function stop(e: { stopPropagation: () => void }) {
  e.stopPropagation();
}
function stopKey(e: KeyboardEvent) {
  if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
}

function cellToText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(cellToText).join(' ');
  if (typeof node === 'object' && 'props' in node) {
    const props = (node as { props?: { children?: ReactNode } }).props;
    return cellToText(props?.children);
  }
  return '';
}

function headerText(node: ReactNode): string {
  return cellToText(node);
}

// --- Sub-components -------------------------------------------------------

function SortCaret({ active, dir }: { active: boolean; dir: SortDirection }) {
  if (!active)
    return (
      <CaretUpDownIcon
        size={12}
        weight="bold"
        style={{ color: 'var(--faint)', flexShrink: 0 }}
        aria-hidden="true"
      />
    );
  const Icon = dir === 'asc' ? CaretUpIcon : CaretDownIcon;
  return (
    <Icon
      size={12}
      weight="bold"
      style={{ color: 'var(--accent-2)', flexShrink: 0 }}
      aria-hidden="true"
    />
  );
}

function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <label
      className="panel"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--s-2)',
        padding: 'var(--s-2) var(--s-3)',
        borderRadius: 'var(--r-sm)',
        border: '1px solid var(--panel-bd)',
        minWidth: 0,
        flex: '0 1 280px',
      }}
    >
      <MagnifyingGlassIcon
        size={15}
        style={{ color: 'var(--muted)', flexShrink: 0 }}
        aria-hidden="true"
      />
      <input
        type="search"
        role="searchbox"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        style={{
          flex: 1,
          minWidth: 0,
          background: 'transparent',
          border: 'none',
          outline: 'none',
          color: 'var(--text)',
          fontSize: 'var(--fs-sm)',
        }}
      />
    </label>
  );
}

function ColumnsMenu<T>({
  label,
  columns,
  hidden,
  onToggle,
}: {
  label: string;
  columns: Column<T>[];
  hidden: ReadonlySet<string>;
  onToggle: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ left: number; top: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = wrapRef.current?.getBoundingClientRect();
      if (r) setRect({ left: r.right, top: r.bottom + 4 });
    };
    place();
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target) !== true && menuRef.current?.contains(target) !== true)
        setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        // Return focus to the trigger so a keyboard user isn't stranded.
        wrapRef.current?.querySelector('button')?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', place);
    // Reposition (don't close) on scroll so the columns menu follows its trigger.
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  return (
    <div ref={wrapRef} style={{ display: 'inline-flex' }}>
      <IconButton
        icon={ColumnsIcon}
        label={label}
        onClick={() => setOpen((o) => !o)}
        active={open}
        ariaHasPopup="dialog"
        ariaExpanded={open}
        ariaControls={open ? menuId : undefined}
      />
      {open &&
        rect !== null &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            // A labeled group of checkboxes, not a menu: there's no arrow-key
            // roving focus, only Tab between the native Checkbox buttons. Using
            // role="group" keeps the keyboard contract honest.
            role="group"
            aria-label={label}
            className="glass"
            style={{
              position: 'fixed',
              top: rect.top,
              left: rect.left,
              transform: 'translateX(-100%)',
              zIndex: Z.popover,
              minWidth: 180,
              maxHeight: 320,
              overflowY: 'auto',
              padding: 'var(--s-2)',
              borderRadius: 'var(--r-md)',
              background: 'var(--overlay-bg)',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--s-1)',
            }}
          >
            {columns.map((c) => (
              <div key={c.key} style={{ padding: 'var(--s-1) var(--s-2)' }}>
                <Checkbox
                  checked={!hidden.has(c.key)}
                  onChange={() => onToggle(c.key)}
                  label={headerText(c.header)}
                />
              </div>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}

function Pager({
  page,
  pages,
  total,
  onPage,
  t,
}: {
  page: number;
  pages: number;
  total: number;
  onPage: (p: number) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const safe = Math.min(Math.max(page, 1), pages);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 'var(--s-3)',
        flexWrap: 'wrap',
        padding: 'var(--s-2) var(--s-1)',
        marginTop: 'var(--s-2)',
        fontSize: 'var(--fs-sm)',
        color: 'var(--muted)',
      }}
    >
      <span className="tabular">{t('table.totalRows', { n: total })}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-3)' }}>
        <span className="tabular" style={{ whiteSpace: 'nowrap' }}>
          {t('table.page', { page: safe, pages })}
        </span>
        <div style={{ display: 'flex', gap: 'var(--s-2)' }}>
          <PagerButton
            label={t('table.prevPage')}
            disabled={safe <= 1}
            onClick={() => onPage(safe - 1)}
            dir="prev"
          />
          <PagerButton
            label={t('table.nextPage')}
            disabled={safe >= pages}
            onClick={() => onPage(safe + 1)}
            dir="next"
          />
        </div>
      </div>
    </div>
  );
}

function PagerButton({
  label,
  disabled,
  onClick,
  dir,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  dir: 'prev' | 'next';
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="panel"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 30,
        height: 30,
        borderRadius: 'var(--r-sm)',
        border: '1px solid var(--panel-bd)',
        background: 'var(--glass-bg)',
        color: 'var(--text)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {dir === 'prev' ? (
        <CaretDownIcon size={14} weight="bold" style={{ transform: 'rotate(90deg)' }} />
      ) : (
        <CaretDownIcon size={14} weight="bold" style={{ transform: 'rotate(-90deg)' }} />
      )}
    </button>
  );
}

/** One `LABEL …… value` line inside a mobile card — value right-aligned and
 * ellipsized so two fields pack into a 2-up grid without overflowing. */
function Field({ header, value }: { header: ReactNode; value: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        gap: 'var(--s-2)',
        minWidth: 0,
      }}
    >
      <span
        style={{
          fontSize: 'var(--fs-caption)',
          color: 'var(--muted)',
          textTransform: 'uppercase',
          letterSpacing: '.05em',
          flexShrink: 0,
        }}
      >
        {header}
      </span>
      <span
        style={{
          fontSize: 'var(--fs-sm)',
          minWidth: 0,
          textAlign: 'right',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {value}
      </span>
    </div>
  );
}

function MobileShell({
  fill,
  toolbar,
  bulkBar,
  children,
}: {
  fill?: boolean;
  toolbar: ReactNode;
  bulkBar: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      style={
        fill === true
          ? { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }
          : undefined
      }
    >
      {toolbar}
      {bulkBar}
      <div
        className="panel"
        style={{
          borderRadius: 'var(--r-md)',
          // Clip cards to the rounded corners so the first/last card's content
          // (e.g. the actions footer) never bleeds into the corner-radius cut.
          overflow: 'hidden',
          ...(fill === true
            ? { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflowY: 'auto' }
            : null),
        }}
      >
        {children}
      </div>
    </div>
  );
}
