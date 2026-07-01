import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '../../i18n';
import type { ApiKeyView, RouteGroupView } from '../../lib/api/types';

const key: ApiKeyView = {
  id: 'k1',
  tenant_id: 't1',
  resource_allowlist: [],
  rate_limit: null,
  status: 'active',
  route_group_id: 'g1',
  limit_plan_id: null,
  subject_id: null,
  created_at: '2026-06-01T00:00:00Z',
};
const groups: RouteGroupView[] = [
  {
    id: 'g1',
    name: 'team-a',
    group_ratio_bps: 10000,
    fallback_group_id: null,
    require_params: false,
    status: 'active',
    description: null,
    created_at: '',
    updated_at: '',
  },
  {
    id: 'g2',
    name: 'team-b',
    group_ratio_bps: 12000,
    fallback_group_id: null,
    require_params: false,
    status: 'active',
    description: null,
    created_at: '',
    updated_at: '',
  },
];

const mockApi = vi.hoisted(() => ({
  listApiKeys: vi.fn(() => Promise.resolve([] as unknown[])),
  listRouteGroups: vi.fn(() => Promise.resolve([] as unknown[])),
  listLimitPlans: vi.fn(() => Promise.resolve([] as unknown[])),
  listLimitStatus: vi.fn(() => Promise.resolve([] as unknown[])),
  listSubjects: vi.fn(() => Promise.resolve([] as unknown[])),
  createApiKey: vi.fn(() => Promise.resolve({ id: 'k9', plaintext: 'sk-x' })),
  updateApiKeyGroup: vi.fn(() => Promise.resolve({ id: 'k1', route_group_id: null })),
  setApiKeyLimitPlan: vi.fn(() => Promise.resolve({ ok: true })),
  deleteApiKey: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../lib/api/useAdminApi', () => ({ useAdminApi: () => mockApi }));

const { ApiKeysPage } = await import('./ApiKeysPage');
const { ApiKeyDetailPage } = await import('./ApiKeyDetailPage');

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/console/api-keys?tenant=t1']}>
        <Routes>
          <Route path="/console/api-keys" element={<ApiKeysPage />} />
          <Route path="/console/api-keys/:id" element={<ApiKeyDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  mockApi.updateApiKeyGroup.mockClear();
  mockApi.deleteApiKey.mockClear();
  mockApi.listApiKeys.mockResolvedValue([key]);
  mockApi.listRouteGroups.mockResolvedValue(groups);
  mockApi.listLimitPlans.mockResolvedValue([]);
  mockApi.listLimitStatus.mockResolvedValue([]);
  mockApi.listSubjects.mockResolvedValue([]);
});

describe('ApiKeysPage table', () => {
  it('renders keys as table rows with the bound route-group name', async () => {
    renderPage();

    await screen.findByText('k1'); // the key id cell
    // The bound route group resolves to its name, not the raw id.
    expect(screen.getByText('team-a')).toBeInTheDocument();
  });

  it('navigates to the routed detail page on row-click (tenant scope preserved)', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByText('k1'));

    // The detail page mounts: its heading is the key id + the binding selects show.
    await screen.findByRole('heading', { name: 'k1' });
    expect(
      screen.getByRole('button', { name: i18n.t('console:apiKeys.group.label') }),
    ).toBeInTheDocument();
  });

  it('revokes a key via the row action + DELETE after confirming', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('k1');
    await user.click(screen.getByRole('button', { name: i18n.t('console:apiKeys.revoke') }));
    // ConfirmDialog confirm button
    await user.click(await screen.findByRole('button', { name: i18n.t('console:common.delete') }));

    expect(mockApi.deleteApiKey).toHaveBeenCalledWith('k1');
  });
});

describe('ApiKeyDetailPage binding', () => {
  function renderDetail() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/console/api-keys/k1?tenant=t1']}>
          <Routes>
            <Route path="/console/api-keys/:id" element={<ApiKeyDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('rebinds the key to another route group via PATCH', async () => {
    const user = userEvent.setup();
    renderDetail();

    await screen.findByRole('heading', { name: 'k1' });
    await user.click(screen.getByRole('button', { name: i18n.t('console:apiKeys.group.label') }));
    await user.click(await screen.findByRole('option', { name: 'team-b' }));

    expect(mockApi.updateApiKeyGroup).toHaveBeenCalledWith('k1', { routeGroupId: 'g2' });
  });

  it('unbinds to the default group by passing null', async () => {
    const user = userEvent.setup();
    renderDetail();

    await screen.findByRole('heading', { name: 'k1' });
    await user.click(screen.getByRole('button', { name: i18n.t('console:apiKeys.group.label') }));
    await user.click(
      await screen.findByRole('option', { name: i18n.t('console:apiKeys.group.default') }),
    );

    expect(mockApi.updateApiKeyGroup).toHaveBeenCalledWith('k1', { routeGroupId: null });
  });

  it('shows a not-found state for an unknown id', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/console/api-keys/nope?tenant=t1']}>
          <Routes>
            <Route path="/console/api-keys/:id" element={<ApiKeyDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText(i18n.t('console:apiKeys.detail.notFound'))).toBeInTheDocument();
  });
});
