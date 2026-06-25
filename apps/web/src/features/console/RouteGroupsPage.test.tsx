import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '../../i18n';
import type { RouteGroupView } from '../../lib/api/types';

const groupA: RouteGroupView = {
  id: 'g-a',
  name: 'premium',
  group_ratio_bps: 10000,
  fallback_group_id: null,
  status: 'active',
  description: null,
  created_at: '2026-06-01T00:00:00Z',
  updated_at: '2026-06-01T00:00:00Z',
};
const groupB: RouteGroupView = {
  id: 'g-b',
  name: 'standard',
  group_ratio_bps: 8000,
  fallback_group_id: null,
  status: 'active',
  description: null,
  created_at: '2026-06-01T00:00:00Z',
  updated_at: '2026-06-01T00:00:00Z',
};

const mockApi = vi.hoisted(() => ({
  listRouteGroups: vi.fn(() => Promise.resolve([] as unknown[])),
  listGroupChannels: vi.fn(() => Promise.resolve([] as unknown[])),
  createRouteGroup: vi.fn(() => Promise.resolve({ id: 'g-new' })),
  updateRouteGroup: vi.fn(() => Promise.resolve({ id: 'g-a' })),
  deleteRouteGroup: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../lib/api/useAdminApi', () => ({ useAdminApi: () => mockApi }));

const { RouteGroupsPage } = await import('./RouteGroupsPage');

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/?tenant=t1']}>
        <RouteGroupsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * Open the edit Drawer for the FIRST group row. The DataTable renders cards in
 * jsdom (no `matchMedia` → mobile layout), so each row exposes its own edit
 * action; the first one is `premium` (the mock returns it first).
 */
async function openFirstEditor(user: ReturnType<typeof userEvent.setup>, name: string) {
  await screen.findByText(name);
  const editButtons = screen.getAllByRole('button', { name: i18n.t('console:common.edit') });
  await user.click(editButtons[0] as HTMLElement);
}

const FALLBACK_LABEL = () => i18n.t('console:groups.form.fallbackGroup');

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  mockApi.createRouteGroup.mockClear();
  mockApi.updateRouteGroup.mockClear();
  mockApi.listRouteGroups.mockResolvedValue([groupA, groupB]);
  mockApi.listGroupChannels.mockResolvedValue([]);
});

describe('RouteGroupsPage fallback selector (resilience v2)', () => {
  it('saves the chosen fallback group id when editing a group', async () => {
    const user = userEvent.setup();
    renderPage();
    await openFirstEditor(user, 'premium');

    // Open the custom Select (its accessible name is the field label) and pick the
    // OTHER live group.
    await user.click(await screen.findByRole('button', { name: FALLBACK_LABEL() }));
    await user.click(await screen.findByRole('option', { name: 'standard' }));

    await user.click(screen.getByRole('button', { name: i18n.t('console:groups.save') }));

    expect(mockApi.updateRouteGroup).toHaveBeenCalledWith(
      'g-a',
      expect.objectContaining({ fallbackGroupId: 'g-b' }),
    );
  });

  it('does not offer the group itself as its own fallback target', async () => {
    const user = userEvent.setup();
    renderPage();
    await openFirstEditor(user, 'premium');

    await user.click(await screen.findByRole('button', { name: FALLBACK_LABEL() }));
    const options = await screen.findAllByRole('option');
    const labels = options.map((o) => o.textContent);
    expect(labels).not.toContain('premium'); // never itself
    expect(labels).toContain('standard'); // the other live group is offered
    expect(labels).toContain(i18n.t('console:groups.form.fallbackNone')); // the clear option
  });

  it('clears the fallback (null) when "none" is selected on a group that had one', async () => {
    const user = userEvent.setup();
    mockApi.listRouteGroups.mockResolvedValue([{ ...groupA, fallback_group_id: 'g-b' }, groupB]);
    renderPage();
    await openFirstEditor(user, 'premium');

    await user.click(await screen.findByRole('button', { name: FALLBACK_LABEL() }));
    await user.click(await screen.findByRole('option', { name: i18n.t('console:groups.form.fallbackNone') }));

    await user.click(screen.getByRole('button', { name: i18n.t('console:groups.save') }));

    expect(mockApi.updateRouteGroup).toHaveBeenCalledWith(
      'g-a',
      expect.objectContaining({ fallbackGroupId: null }),
    );
  });
});
