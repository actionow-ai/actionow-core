import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '../../i18n';
import type { FaultPolicyView } from '../../lib/api/types';

const policy: FaultPolicyView = {
  id: 'fp1',
  name: 'aggressive',
  fast_fail: false,
  retry_count: 3,
  backoff_type: 'fixed',
  backoff_ms: 0,
  connect_timeout_ms: null,
  ttft_timeout_ms: null,
  total_timeout_ms: null,
  idle_timeout_ms: null,
  retry_codes: null,
  retry_messages: null,
  breaker_enabled: true,
  breaker_window_ms: null,
  breaker_min_volume: null,
  breaker_failure_rate_pct: null,
  breaker_half_open_trial: null,
  breaker_half_open_successes: null,
  breaker_open_cooldown_ms: null,
  breaker_open_cooldown_cap_ms: null,
  status: 'active',
  description: null,
  created_at: '2026-06-01T00:00:00Z',
  updated_at: '2026-06-01T00:00:00Z',
};

const mockApi = vi.hoisted(() => ({
  listFaultPolicies: vi.fn(() => Promise.resolve([] as unknown[])),
  createFaultPolicy: vi.fn(() => Promise.resolve({ id: 'fp9' })),
  updateFaultPolicy: vi.fn(() => Promise.resolve({ id: 'fp1' })),
  deleteFaultPolicy: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../lib/api/useAdminApi', () => ({ useAdminApi: () => mockApi }));

const { FaultPoliciesPage } = await import('./FaultPoliciesPage');

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/?tenant=t1']}>
        <FaultPoliciesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  mockApi.updateFaultPolicy.mockClear();
  mockApi.createFaultPolicy.mockClear();
  mockApi.listFaultPolicies.mockResolvedValue([policy]);
});

describe('FaultPoliciesPage breaker fields (resilience v2)', () => {
  it('shows the breaker column with the failure-rate threshold', async () => {
    renderPage();
    // The breaker column surfaces the (default) failure-rate threshold (50%).
    await screen.findByText(i18n.t('console:faultPolicies.breakerOn', { rate: 50 }));
  });

  it('reveals the collapsible breaker section in the editor and patches breaker fields', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('aggressive');
    await user.click(screen.getByRole('button', { name: i18n.t('console:common.edit') }));

    // Breaker section is collapsed by default — the failure-rate field is hidden.
    expect(
      screen.queryByLabelText(i18n.t('console:faultPolicies.form.breakerFailureRatePct')),
    ).toBeNull();

    // Expand the 熔断 section.
    await user.click(
      screen.getByRole('button', { name: i18n.t('console:faultPolicies.breakerShow') }),
    );

    const rate = await screen.findByLabelText(
      i18n.t('console:faultPolicies.form.breakerFailureRatePct'),
    );
    await user.clear(rate);
    await user.type(rate, '80');

    await user.click(screen.getByRole('button', { name: i18n.t('console:faultPolicies.save') }));

    expect(mockApi.updateFaultPolicy).toHaveBeenCalledWith(
      'fp1',
      expect.objectContaining({ breakerEnabled: true, breakerFailureRatePct: 80 }),
    );
  });
});
