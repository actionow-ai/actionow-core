import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '../../i18n';
import type { AdminTokenView } from '../../lib/api/types';

const token: AdminTokenView = {
  id: 'tok_1',
  name: 'CI deploy bot',
  created_by: 'admin_1',
  status: 'active',
  expires_at: null,
  created_at: '2026-06-01T00:00:00Z',
  updated_at: '2026-06-01T00:00:00Z',
};

const mockApi = vi.hoisted(() => ({
  listAdminTokens: vi.fn(() => Promise.resolve([] as unknown[])),
  createAdminToken: vi.fn(() => Promise.resolve({ id: 'tok_9', plaintext: 'at_secret' })),
  revokeAdminToken: vi.fn(() => Promise.resolve({})),
}));
vi.mock('../../lib/api/useAdminApi', () => ({ useAdminApi: () => mockApi }));

const { ServiceTokensPage } = await import('./ServiceTokensPage');
const { ServiceTokenDetailPage } = await import('./ServiceTokenDetailPage');

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/console/tokens']}>
        <Routes>
          <Route path="/console/tokens" element={<ServiceTokensPage />} />
          <Route path="/console/tokens/:id" element={<ServiceTokenDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  mockApi.listAdminTokens.mockClear();
  mockApi.revokeAdminToken.mockClear();
  mockApi.listAdminTokens.mockResolvedValue([token]);
});

describe('ServiceTokensPage table', () => {
  it('renders tokens as table rows with name + status + never-expires', async () => {
    renderPage();

    await screen.findByText('CI deploy bot');
    // Status badge uses the i18n label.
    expect(screen.getByText(i18n.t('console:status.active', 'active'))).toBeInTheDocument();
    // A null expiry renders the "Never" label.
    expect(screen.getByText(i18n.t('console:tokens.never'))).toBeInTheDocument();
  });

  it('navigates to the routed detail page on row-click', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByText('CI deploy bot'));

    // The detail page mounts: its heading is the token name and the back link shows.
    const heading = await screen.findByRole('heading', { name: 'CI deploy bot' });
    expect(heading).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: i18n.t('console:tokens.detail.back') }),
    ).toBeInTheDocument();
  });
});

describe('ServiceTokenDetailPage', () => {
  function renderDetail(id: string) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/console/tokens/${id}`]}>
          <Routes>
            <Route path="/console/tokens/:id" element={<ServiceTokenDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('renders the token header + back link for a known id', async () => {
    renderDetail('tok_1');

    await screen.findByRole('heading', { name: 'CI deploy bot' });
    const back = screen.getByRole('link', { name: i18n.t('console:tokens.detail.back') });
    expect(back).toHaveAttribute('href', '/console/tokens');
  });

  it('shows a not-found state for an unknown id', async () => {
    renderDetail('nope');

    expect(
      await screen.findByText(i18n.t('console:tokens.detail.notFound')),
    ).toBeInTheDocument();
  });
});
