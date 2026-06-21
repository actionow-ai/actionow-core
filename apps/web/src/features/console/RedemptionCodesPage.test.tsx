import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
  listRedemptionCodes: vi.fn(() => Promise.resolve([] as unknown[])),
  generateCodes: vi.fn(() => Promise.resolve({ codes: ['GIFT-2'], credit_amount: '5000000' })),
}));
vi.mock('../../lib/api/useAdminApi', () => ({ useAdminApi: () => mockApi }));

const { RedemptionCodesPage } = await import('./RedemptionCodesPage');

function renderPage(entry = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <RedemptionCodesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  mockApi.listRedemptionCodes.mockClear();
  mockApi.listRedemptionCodes.mockResolvedValue([code]);
});

describe('RedemptionCodesPage', () => {
  it('lists minted codes with their status', async () => {
    renderPage();
    await screen.findByText('GIFT-1');
    expect(screen.getByText(i18n.t('console:status.unused'))).toBeInTheDocument();
    // No status in the URL → list every code (undefined filter).
    expect(mockApi.listRedemptionCodes).toHaveBeenCalledWith(undefined);
  });

  it('passes the URL status filter through to the query', async () => {
    renderPage('/?status=redeemed');
    await screen.findByText('GIFT-1');
    expect(mockApi.listRedemptionCodes).toHaveBeenCalledWith('redeemed');
  });
});
