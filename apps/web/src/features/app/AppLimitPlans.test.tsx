import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsoleActionContext } from '../../components/console/ConsoleChrome';
import i18n from '../../i18n';
import type { LimitPlanView } from '../../lib/api/types';

const starter: LimitPlanView = {
  id: 'lp-1',
  tenant_id: 't1',
  name: 'Starter',
  description: 'Entry tier',
  status: 'active',
  rules: [
    {
      id: 'r1',
      dimension: 'spend',
      period: 'month',
      cap: '100000000',
      model_scope: null,
      alert_pct: 80,
      enforce: 'block',
    },
  ],
  key_count: 0,
  tenant_count: 0,
  created_at: '2026-06-01T00:00:00Z',
  updated_at: '2026-06-01T00:00:00Z',
};

const mockApi = vi.hoisted(() => ({
  me: vi.fn(() => Promise.resolve({ tenant_role: 'admin' as string | null })),
  listLimitPlans: vi.fn(() => Promise.resolve([] as LimitPlanView[])),
  createLimitPlan: vi.fn(),
  updateLimitPlan: vi.fn(),
  deleteLimitPlan: vi.fn(),
}));
vi.mock('../../lib/api/useConsoleApi', () => ({ useConsoleApi: () => mockApi }));

const { AppLimitPlans } = await import('./AppLimitPlans');

/** Mirror the shell's TopBar action slot so the "New plan" trigger is in the DOM. */
function ActionHost() {
  const [action, setAction] = useState<React.ReactNode>(null);
  return (
    <ConsoleActionContext.Provider value={setAction}>
      <div>{action}</div>
      <AppLimitPlans />
    </ConsoleActionContext.Provider>
  );
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ActionHost />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  vi.clearAllMocks();
  mockApi.me.mockResolvedValue({ tenant_role: 'admin' });
  mockApi.listLimitPlans.mockResolvedValue([starter]);
  mockApi.createLimitPlan.mockResolvedValue(starter);
  mockApi.updateLimitPlan.mockResolvedValue(starter);
});

describe('AppLimitPlans', () => {
  it('lists the tenant limit plans (name + rule chip)', async () => {
    renderPage();
    expect(await screen.findByText('Starter')).toBeInTheDocument();
    // µUSD spend cap (100000000) is shown in credits ($100).
    expect(screen.getByText(/\$100/)).toBeInTheDocument();
  });

  it('creates a plan from the new-plan drawer', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Starter');

    await user.click(screen.getByRole('button', { name: /new plan/i }));

    // The Name field is required, so its accessible label is "Name *".
    const name = await screen.findByLabelText(/name \*/i);
    await user.type(name, 'Pro');
    await user.click(screen.getByRole('button', { name: /save plan/i }));

    await waitFor(() => {
      expect(mockApi.createLimitPlan).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Pro' }),
      );
    });
  });

  it('shows the admin-only note (no list) for a tenant member', async () => {
    mockApi.me.mockResolvedValue({ tenant_role: 'member' });
    renderPage();
    expect(await screen.findByRole('note')).toBeInTheDocument();
    expect(mockApi.listLimitPlans).not.toHaveBeenCalled();
  });
});
