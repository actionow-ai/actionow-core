import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '../../i18n';
import type { BreakerView } from '../../lib/api/types';

const breaker: BreakerView = {
  channel_id: 'c1',
  channel_name: 'openai',
  resource_id: 'gpt',
  model: 'gpt-4o',
  state: 'open',
  opened_at: '2026-06-25T00:00:00Z',
  cooldown_until: '2026-06-25T00:05:00Z',
  trip_count: 3,
  half_open_successes: 0,
  last_transition_at: '2026-06-25T00:00:00Z',
};

const mockApi = vi.hoisted(() => ({
  listBreakers: vi.fn(() => Promise.resolve([] as unknown[])),
  resetBreaker: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../lib/api/useAdminApi', () => ({ useAdminApi: () => mockApi }));

const { BreakersPage } = await import('./BreakersPage');

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/console/breakers']}>
        <BreakersPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  mockApi.listBreakers.mockClear();
  mockApi.resetBreaker.mockClear();
  mockApi.listBreakers.mockResolvedValue([breaker]);
});

describe('BreakersPage (弹性2.0)', () => {
  it('lists a tripped breaker with its channel, model and open state', async () => {
    renderPage();
    // The channel display label (provider_type) + the model are rendered.
    await screen.findByText('openai');
    expect(screen.getByText('gpt-4o')).toBeInTheDocument();
    // The state pill shows the translated "Open" state.
    expect(screen.getByText(i18n.t('console:breakers.state.open'))).toBeInTheDocument();
  });

  it('resets a breaker after confirming and calls the api with channel + model', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('openai');
    // Click the per-row reset action, then confirm in the dialog.
    await user.click(screen.getByRole('button', { name: i18n.t('console:breakers.reset.action') }));

    // The confirm dialog's confirm button shares the same label — pick the dialog one.
    const confirms = screen.getAllByRole('button', {
      name: i18n.t('console:breakers.reset.action'),
    });
    await user.click(confirms[confirms.length - 1]);

    expect(mockApi.resetBreaker).toHaveBeenCalledWith('c1', 'gpt-4o');
  });

  it('renders the empty state when no breaker has tripped', async () => {
    mockApi.listBreakers.mockResolvedValue([]);
    renderPage();
    await screen.findByText(i18n.t('console:breakers.empty'));
  });
});
