import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '../../i18n';
import type { AccountView, TenantView } from '../../lib/api/types';

const tenant: TenantView = {
  id: 't1',
  name: 'Acme Corp',
  isolation_mode: 'field',
  created_at: '2026-06-01T00:00:00Z',
};
const account: AccountView = {
  id: 'a1',
  tenant_id: 't1',
  credit_balance: '5000000',
  credit_held: '0',
  limit_plan_id: null,
  created_at: '2026-06-01T00:00:00Z',
};

const mockApi = vi.hoisted(() => ({
  listTenants: vi.fn(() => Promise.resolve([] as unknown[])),
  listAccounts: vi.fn(() => Promise.resolve([] as unknown[])),
  createTenant: vi.fn(() => Promise.resolve({ id: 't9' })),
  provision: vi.fn(() => Promise.resolve({})),
  // Detail-page methods (so the routed detail page can mount in the nav test).
  listLimitPlans: vi.fn(() => Promise.resolve([] as unknown[])),
  listLimitStatus: vi.fn(() => Promise.resolve([] as unknown[])),
  listSubjects: vi.fn(() => Promise.resolve([] as unknown[])),
  listLedger: vi.fn(() => Promise.resolve({ rows: [], nextCursor: null })),
  listPayments: vi.fn(() => Promise.resolve({ rows: [], nextCursor: null })),
}));
vi.mock('../../lib/api/useAdminApi', () => ({ useAdminApi: () => mockApi }));

const { TenantsPage } = await import('./TenantsPage');
const { TenantDetailPage } = await import('./TenantDetailPage');

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/console/tenants']}>
        <Routes>
          <Route path="/console/tenants" element={<TenantsPage />} />
          <Route path="/console/tenants/:id" element={<TenantDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  mockApi.listTenants.mockClear();
  mockApi.listAccounts.mockClear();
  mockApi.listTenants.mockResolvedValue([tenant]);
  mockApi.listAccounts.mockResolvedValue([account]);
});

describe('TenantsPage table', () => {
  it('renders tenants as table rows with isolation + joined balance', async () => {
    renderPage();

    await screen.findByText('Acme Corp');
    // Isolation chip uses the i18n label, not the raw mode string.
    expect(screen.getByText(i18n.t('console:tenants.isolation.field'))).toBeInTheDocument();
    // The joined account balance renders (5,000,000 µcredits → "5" credits).
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('navigates to the routed detail page on row-click', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByText('Acme Corp'));

    // The detail page mounts: its heading is the tenant name and the copyable id
    // shows. The directory's "New tenant" action button is gone (we left the page).
    const heading = await screen.findByRole('heading', { name: 'Acme Corp' });
    expect(heading).toBeInTheDocument();
    expect(screen.getByText(i18n.t('console:tenants.detail.id'))).toBeInTheDocument();
  });
});

describe('TenantDetailPage', () => {
  function renderDetail(id: string) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/console/tenants/${id}`]}>
          <Routes>
            <Route path="/console/tenants/:id" element={<TenantDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('renders the tenant header + back link for a known id', async () => {
    renderDetail('t1');

    await screen.findByRole('heading', { name: 'Acme Corp' });
    const back = screen.getByRole('link', { name: i18n.t('console:tenants.detail.back') });
    expect(back).toHaveAttribute('href', '/console/tenants');
  });

  it('shows a not-found state for an unknown id', async () => {
    renderDetail('nope');

    expect(await screen.findByText(i18n.t('console:tenants.detail.notFound'))).toBeInTheDocument();
  });
});
