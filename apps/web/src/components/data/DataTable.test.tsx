import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '../../i18n';
import type { Column } from './DataTable';
import { DataTable } from './DataTable';

// Resolve the `table.*` aria-labels to real English strings so name-matched
// queries (e.g. "next page", "select all", "columns") are deterministic.
beforeAll(async () => {
  await i18n.changeLanguage('en');
});

// The new table chrome (search, pager, sticky columns, bulk bar, column menu)
// only renders in the desktop layout. Force `useMediaQuery(BP.md)` true.
beforeEach(() => {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface Row {
  id: string;
  name: string;
  weight: number;
}

const ROWS: Row[] = [
  { id: 'a', name: 'Alpha', weight: 3 },
  { id: 'b', name: 'Bravo', weight: 1 },
  { id: 'c', name: 'Charlie', weight: 2 },
  { id: 'd', name: 'Delta', weight: 5 },
  { id: 'e', name: 'Echo', weight: 4 },
];

const COLS: Column<Row>[] = [
  { key: 'name', header: 'Name', cell: (r) => r.name, sortable: true, sortValue: (r) => r.name },
  { key: 'weight', header: 'Weight', cell: (r) => String(r.weight) },
];

function rowKey(r: Row) {
  return r.id;
}

describe('DataTable search', () => {
  it('narrows visible rows by a case-insensitive substring', async () => {
    const user = userEvent.setup();
    render(<DataTable columns={COLS} rows={ROWS} rowKey={rowKey} searchable />);
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Charlie')).toBeInTheDocument();

    const search = screen.getByRole('searchbox');
    await user.type(search, 'alph');

    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.queryByText('Charlie')).not.toBeInTheDocument();
    expect(screen.queryByText('Bravo')).not.toBeInTheDocument();
  });
});

describe('DataTable pagination', () => {
  it('renders only one page of rows and advances on next', async () => {
    const user = userEvent.setup();
    render(<DataTable columns={COLS} rows={ROWS} rowKey={rowKey} pageSize={2} />);

    // page 1: Alpha, Bravo
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Bravo')).toBeInTheDocument();
    expect(screen.queryByText('Charlie')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /next page/i }));

    // page 2: Charlie, Delta
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
    expect(screen.getByText('Charlie')).toBeInTheDocument();
    expect(screen.getByText('Delta')).toBeInTheDocument();
  });

  it('does not render a pager when rows fit on one page', () => {
    render(<DataTable columns={COLS} rows={ROWS} rowKey={rowKey} pageSize={10} />);
    expect(screen.queryByRole('button', { name: /next page/i })).not.toBeInTheDocument();
  });
});

describe('DataTable selection + bulk actions', () => {
  it('header checkbox selects all rows on the page and shows the bulk bar', async () => {
    const user = userEvent.setup();
    render(
      <DataTable
        columns={COLS}
        rows={ROWS}
        rowKey={rowKey}
        selectable
        bulkActions={(selected) => <span>bulk:{selected.length}</span>}
      />,
    );

    // no bulk bar before selection
    expect(screen.queryByText(/bulk:/)).not.toBeInTheDocument();

    const selectAll = screen.getByRole('checkbox', { name: /select all/i });
    await user.click(selectAll);

    // bulk bar reflects all 5 rows selected
    expect(screen.getByText('bulk:5')).toBeInTheDocument();
    expect(screen.getByText(/5 selected/i)).toBeInTheDocument();
  });

  it('a checkbox click does not trigger onRowClick', async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    render(<DataTable columns={COLS} rows={ROWS} rowKey={rowKey} selectable onRowClick={onRowClick} />);

    const rowChecks = screen.getAllByRole('checkbox', { name: /select row/i });
    expect(rowChecks.length).toBeGreaterThan(0);
    await user.click(rowChecks[0]!);

    expect(onRowClick).not.toHaveBeenCalled();
  });
});

describe('DataTable selection across pagination', () => {
  // The Set-keyed selection is keyed by rowKey, not by page index, so a
  // selection made on one page must survive paging away and back.
  it('keeps a row selected after paging away and back', async () => {
    const user = userEvent.setup();
    render(
      <DataTable
        columns={COLS}
        rows={ROWS}
        rowKey={rowKey}
        selectable
        pageSize={2}
        bulkActions={(selected) => <span>bulk:{selected.length}</span>}
      />,
    );

    // page 1: Alpha, Bravo — select Alpha's row checkbox.
    const alphaRow = screen.getByText('Alpha').closest('tr');
    expect(alphaRow).not.toBeNull();
    await user.click(within(alphaRow as HTMLElement).getByRole('checkbox', { name: /select row/i }));

    // bulk bar reflects exactly one selection
    expect(screen.getByText('bulk:1')).toBeInTheDocument();
    expect(screen.getByText(/1 selected/i)).toBeInTheDocument();

    // advance to page 2, then back to page 1
    await user.click(screen.getByRole('button', { name: /next page/i }));
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /previous page/i }));

    // Alpha is back and still checked; the bulk count is unchanged
    const alphaRowAgain = screen.getByText('Alpha').closest('tr');
    expect(alphaRowAgain).not.toBeNull();
    expect(within(alphaRowAgain as HTMLElement).getByRole('checkbox', { name: /select row/i })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByText('bulk:1')).toBeInTheDocument();
    expect(screen.getByText(/1 selected/i)).toBeInTheDocument();
  });
});

describe('DataTable select-all indeterminate state', () => {
  it('reports aria-checked="mixed" on the select-all when only some rows are selected', async () => {
    const user = userEvent.setup();
    render(<DataTable columns={COLS} rows={ROWS} rowKey={rowKey} selectable />);

    const selectAll = screen.getByRole('checkbox', { name: /select all/i });
    expect(selectAll).toHaveAttribute('aria-checked', 'false');

    // select a single row out of several
    const rowChecks = screen.getAllByRole('checkbox', { name: /select row/i });
    await user.click(rowChecks[0]!);

    expect(selectAll).toHaveAttribute('aria-checked', 'mixed');
  });
});

describe('DataTable row actions', () => {
  it('renders per-row actions and a click does not trigger onRowClick', async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    const onDelete = vi.fn();
    render(
      <DataTable
        columns={COLS}
        rows={ROWS}
        rowKey={rowKey}
        onRowClick={onRowClick}
        rowActions={(r) => (
          <button
            type="button"
            onClick={() => {
              onDelete(r.id);
            }}
          >
            del-{r.id}
          </button>
        )}
      />,
    );

    await user.click(screen.getByText('del-a'));
    expect(onDelete).toHaveBeenCalledWith('a');
    expect(onRowClick).not.toHaveBeenCalled();
  });
});

describe('DataTable column visibility', () => {
  it('toggling a column in the menu hides it from header and body', async () => {
    const user = userEvent.setup();
    render(<DataTable columns={COLS} rows={ROWS} rowKey={rowKey} columnToggle />);

    // both columns visible initially
    expect(screen.getByRole('columnheader', { name: 'Weight' })).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /columns/i }));
    // The popover is a labeled group of checkboxes (not a role="menu"): no
    // arrow-key roving focus, just Tab between the native Checkbox buttons.
    const menu = screen.getByRole('group', { name: /columns/i });
    await user.click(within(menu).getByRole('checkbox', { name: 'Weight' }));

    expect(screen.queryByRole('columnheader', { name: 'Weight' })).not.toBeInTheDocument();
    expect(screen.queryByText('3')).not.toBeInTheDocument();
    // the other column survives
    expect(screen.getByRole('columnheader', { name: /Name/ })).toBeInTheDocument();
  });
});

describe('DataTable error state', () => {
  it('renders an error + retry in place of rows when error is set, and retries on click', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <DataTable columns={COLS} rows={[]} rowKey={rowKey} error onRetry={onRetry} empty="No rows" />,
    );

    // error wins over the empty state
    expect(screen.queryByText('No rows')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('error wins over loading', () => {
    render(<DataTable columns={COLS} rows={[]} rowKey={rowKey} error loading />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('DataTable sorting', () => {
  it('cycles a sortable header asc -> desc and reorders rows', async () => {
    const user = userEvent.setup();
    render(<DataTable columns={COLS} rows={ROWS} rowKey={rowKey} />);

    const header = screen.getByRole('button', { name: /sort by name/i });
    await user.click(header); // asc
    const firstAsc = screen.getAllByRole('row')[1]!;
    expect(within(firstAsc).getByText('Alpha')).toBeInTheDocument();

    await user.click(header); // desc
    const firstDesc = screen.getAllByRole('row')[1]!;
    expect(within(firstDesc).getByText('Echo')).toBeInTheDocument();
  });
});
