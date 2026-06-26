import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsoleFiltersContext } from '../../components/console/ConsoleChrome';
import i18n from '../../i18n';
import type { RedemptionCodeView } from '../../lib/api/types';

const code: RedemptionCodeView = {
  code: 'GIFT-1',
  credit_amount: '5000000',
  status: 'unused',
  redeemed_by_tenant: null,
  redeemed_at: null,
  expires_at: null,
  created_at: '2026-06-01T00:00:00Z',
};

const mockApi = vi.hoisted(() => ({
  listRedemptionCodes: vi.fn(() => Promise.resolve({ rows: [] as unknown[], nextCursor: null })),
  generateCodes: vi.fn(() => Promise.resolve({ codes: ['GIFT-2'], credit_amount: '5000000' })),
}));
vi.mock('../../lib/api/useAdminApi', () => ({ useAdminApi: () => mockApi }));

const { RedemptionCodesPage } = await import('./RedemptionCodesPage');

/**
 * Mimics the console shell's filter slot: capture the node the page publishes via
 * `useSetConsoleFilters` and render it, so the status `SelectField` it mounts in
 * the TopBar is observable in tests (the default context is a no-op).
 */
function FilterSlotHarness({ children }: { children: ReactNode }) {
  const [filters, setFilters] = useState<ReactNode>(null);
  return (
    <ConsoleFiltersContext.Provider value={setFilters}>
      <div data-testid="filter-slot">{filters}</div>
      {children}
    </ConsoleFiltersContext.Provider>
  );
}

function renderPage(entry = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <FilterSlotHarness>
          <RedemptionCodesPage />
        </FilterSlotHarness>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  mockApi.listRedemptionCodes.mockClear();
  mockApi.listRedemptionCodes.mockResolvedValue({ rows: [code], nextCursor: null });
});

describe('RedemptionCodesPage', () => {
  it('lists minted codes with their status', async () => {
    renderPage();
    await screen.findByText('GIFT-1');
    expect(screen.getByText(i18n.t('console:status.unused'))).toBeInTheDocument();
    // No status in the URL → list every code (undefined filter), keyset-paginated.
    expect(mockApi.listRedemptionCodes).toHaveBeenCalledWith({
      status: undefined,
      cursor: undefined,
      limit: 50,
    });
  });

  it('passes the URL status filter through to the query', async () => {
    renderPage('/?status=redeemed');
    await screen.findByText('GIFT-1');
    expect(mockApi.listRedemptionCodes).toHaveBeenCalledWith({
      status: 'redeemed',
      cursor: undefined,
      limit: 50,
    });
  });

  it('renders the status filter with an inline (label-left) layout', async () => {
    renderPage();
    await screen.findByText('GIFT-1');

    const slot = screen.getByTestId('filter-slot');
    const statusLabel = i18n.t('console:redemptionCodes.cols.status');

    // The label and the select trigger both render in the filter slot…
    const label = within(slot).getByText(statusLabel);
    const trigger = within(slot).getByRole('button', { name: statusLabel });
    expect(label).toBeInTheDocument();
    expect(trigger).toBeInTheDocument();

    // …and the inline layout lays them out as a centred flex row (label to the
    // LEFT of the control), not the default label-above stack.
    const row = label.parentElement as HTMLElement;
    expect(row.style.display).toBe('flex');
    expect(row.style.alignItems).toBe('center');
    expect(row).toContainElement(trigger);

    // The placeholder reflects the unfiltered (全部状态) default.
    expect(trigger).toHaveTextContent(i18n.t('console:redemptionCodes.allStatuses'));
  });
});
