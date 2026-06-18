import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
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
  created_at: '2026-06-01T00:00:00Z',
};
const groups: RouteGroupView[] = [
  { id: 'g1', name: 'team-a', group_ratio_bps: 10000, status: 'active', description: null, created_at: '', updated_at: '' },
  { id: 'g2', name: 'team-b', group_ratio_bps: 12000, status: 'active', description: null, created_at: '', updated_at: '' },
];

const mockApi = vi.hoisted(() => ({
  listApiKeys: vi.fn(() => Promise.resolve([] as unknown[])),
  listRouteGroups: vi.fn(() => Promise.resolve([] as unknown[])),
  createApiKey: vi.fn(() => Promise.resolve({ id: 'k9', plaintext: 'sk-x' })),
  updateApiKeyGroup: vi.fn(() => Promise.resolve({ id: 'k1', route_group_id: null })),
  deleteApiKey: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../lib/api/useAdminApi', () => ({ useAdminApi: () => mockApi }));

const { ApiKeysPage } = await import('./ApiKeysPage');

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/?tenant=t1']}>
        <ApiKeysPage />
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
});

describe('ApiKeysPage group-bind + revoke', () => {
  it('rebinds a key to another route group via PATCH', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('k1'); // card rendered once the keys resolve
    await user.click(screen.getByRole('button', { name: i18n.t('console:apiKeys.group.label') }));
    await user.click(await screen.findByRole('option', { name: 'team-b' }));

    expect(mockApi.updateApiKeyGroup).toHaveBeenCalledWith('k1', { routeGroupId: 'g2' });
  });

  it('unbinds to the default group by passing null', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('k1');
    await user.click(screen.getByRole('button', { name: i18n.t('console:apiKeys.group.label') }));
    await user.click(await screen.findByRole('option', { name: i18n.t('console:apiKeys.group.default') }));

    expect(mockApi.updateApiKeyGroup).toHaveBeenCalledWith('k1', { routeGroupId: null });
  });

  it('revokes a key via DELETE after confirming', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('k1');
    await user.click(screen.getByRole('button', { name: i18n.t('console:apiKeys.revoke') }));
    // ConfirmDialog confirm button
    await user.click(await screen.findByRole('button', { name: i18n.t('console:common.delete') }));

    expect(mockApi.deleteApiKey).toHaveBeenCalledWith('k1');
  });
});
