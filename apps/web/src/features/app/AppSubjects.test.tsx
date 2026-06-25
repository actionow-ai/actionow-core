import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsoleActionContext } from '../../components/console/ConsoleChrome';
import i18n from '../../i18n';
import type { SubjectView } from '../../lib/api/types';

const ada: SubjectView = {
  id: 's-ada',
  tenant_id: 't1',
  external_id: 'ext-ada',
  email: null,
  display_name: 'Ada',
  limit_plan_id: null,
  status: 'active',
  created_at: '2026-06-01T00:00:00Z',
};

const mockApi = vi.hoisted(() => ({
  me: vi.fn(() => Promise.resolve({ tenant_role: 'admin' as string | null })),
  listSubjects: vi.fn(() => Promise.resolve([] as SubjectView[])),
  createSubject: vi.fn(() => Promise.resolve({} as SubjectView)),
  updateSubject: vi.fn(),
  deleteSubject: vi.fn(),
  setSubjectLimitPlan: vi.fn(),
  getSubAccount: vi.fn(() => Promise.reject(new Error('404'))),
  openSubAccount: vi.fn(),
  topupSubAccount: vi.fn(),
  transferSubAccount: vi.fn(),
  listLimitPlans: vi.fn(() => Promise.resolve([])),
  listApiKeys: vi.fn(() => Promise.resolve({ rows: [], nextCursor: null })),
  createApiKey: vi.fn(),
  disableApiKey: vi.fn(),
}));
vi.mock('../../lib/api/useConsoleApi', () => ({ useConsoleApi: () => mockApi }));

const { AppSubjects } = await import('./AppSubjects');

/** Mirror the shell's TopBar action slot so the "Add end-user" trigger is in the DOM. */
function ActionHost() {
  const [action, setAction] = useState<React.ReactNode>(null);
  return (
    <ConsoleActionContext.Provider value={setAction}>
      <div>{action}</div>
      <AppSubjects />
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
  mockApi.listSubjects.mockResolvedValue([ada]);
  mockApi.listLimitPlans.mockResolvedValue([]);
  mockApi.createSubject.mockResolvedValue(ada);
  mockApi.getSubAccount.mockRejectedValue(new Error('404'));
  mockApi.listApiKeys.mockResolvedValue({ rows: [], nextCursor: null });
});

describe('AppSubjects', () => {
  it('lists the tenant end-users (display name + external id)', async () => {
    renderPage();
    expect(await screen.findByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('ext-ada')).toBeInTheDocument();
  });

  it('creates an end-user from the add form', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Ada');

    await user.click(screen.getByRole('button', { name: /add end-user/i }));

    const ext = await screen.findByLabelText(/external id/i);
    await user.type(ext, 'ext-grace');
    await user.click(screen.getByRole('button', { name: /^add$/i }));

    await waitFor(() => {
      expect(mockApi.createSubject).toHaveBeenCalledWith(
        expect.objectContaining({ externalId: 'ext-grace' }),
      );
    });
  });

  it('shows the admin-only note (no list) for a tenant member', async () => {
    mockApi.me.mockResolvedValue({ tenant_role: 'member' });
    renderPage();
    expect(await screen.findByRole('note')).toBeInTheDocument();
    expect(mockApi.listSubjects).not.toHaveBeenCalled();
  });
});
