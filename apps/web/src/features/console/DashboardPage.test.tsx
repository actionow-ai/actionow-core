import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import i18n from '../../i18n';

const mockApi = vi.hoisted(() => ({
  listTenants: vi.fn(() => Promise.resolve([])),
  listResources: vi.fn(() => Promise.resolve([])),
  listJobs: vi.fn(() => Promise.resolve({ rows: [], nextCursor: null })),
  analyticsUsage: vi.fn(() => Promise.resolve([] as unknown[])),
}));
vi.mock('../../lib/api/useAdminApi', () => ({ useAdminApi: () => mockApi }));

const { DashboardPage } = await import('./DashboardPage');

function renderDash() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const rollup = (bucket: string, cost: string, providerCost: string, margin: string) => ({
  bucket,
  requests: 1,
  input_tokens: '0',
  output_tokens: '0',
  cost,
  provider_cost: providerCost,
  margin,
  errors: 0,
});

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

describe('DashboardPage ranking board', () => {
  it('renders a top-models-by-cost board, highest first, with a signed negative margin', async () => {
    mockApi.analyticsUsage.mockResolvedValue([
      rollup('claude-sonnet', '5000000', '6000000', '-1000000'),
      rollup('gpt-4o', '9000000', '7000000', '2000000'),
      rollup('gemini', '3000000', '2000000', '1000000'),
    ]);

    renderDash();

    const top = await screen.findByText('gpt-4o'); // board renders once analytics resolves
    expect(top).toBeInTheDocument();
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('gpt-4o'); // highest cost (9M) first
    expect(screen.getByText('-1')).toBeInTheDocument(); // claude's negative margin, signed
  });
});
