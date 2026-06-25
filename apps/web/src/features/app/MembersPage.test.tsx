import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsoleActionContext } from '../../components/console/ConsoleChrome';
import i18n from '../../i18n';
import type { ConsoleUserView } from '../../lib/api/types';

const admin: ConsoleUserView = {
  id: 'u-admin',
  email: 'owner@acme.test',
  status: 'active',
  tenant_role: 'admin',
  created_at: '2026-06-01T00:00:00Z',
};
const member: ConsoleUserView = {
  id: 'u-member',
  email: 'staff@acme.test',
  status: 'active',
  tenant_role: 'member',
  created_at: '2026-06-02T00:00:00Z',
};

const mockApi = vi.hoisted(() => ({
  me: vi.fn(() => Promise.resolve({ tenant_role: 'admin' as string | null })),
  listUsers: vi.fn(() => Promise.resolve([] as ConsoleUserView[])),
  createUser: vi.fn(() => Promise.resolve({ id: 'u-new', email: 'new@acme.test' })),
  updateUser: vi.fn((id: string) => Promise.resolve({ ...member, id })),
  disableUser: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../lib/api/useConsoleApi', () => ({ useConsoleApi: () => mockApi }));

const { MembersPage } = await import('./MembersPage');

/**
 * The shell renders the page's published TopBar action (the "Invite member"
 * trigger). Mirror that here with a tiny host so the action is in the DOM, just
 * like `ConsoleLayout` does in the real app.
 */
function ActionHost() {
  const [action, setAction] = useState<React.ReactNode>(null);
  return (
    <ConsoleActionContext.Provider value={setAction}>
      <div>{action}</div>
      <MembersPage />
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
  mockApi.me.mockResolvedValue({ tenant_role: 'admin' });
  mockApi.listUsers.mockResolvedValue([admin, member]);
  mockApi.createUser.mockResolvedValue({ id: 'u-new', email: 'new@acme.test' });
});

describe('MembersPage', () => {
  it('lists the tenant seats with their email + role', async () => {
    renderPage();
    expect(await screen.findByText(admin.email)).toBeInTheDocument();
    expect(screen.getByText(member.email)).toBeInTheDocument();
  });

  it('creates a sub-user from the invite form', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(admin.email);

    // Open the invite form via the published TopBar action (rendered by the host).
    await user.click(screen.getByRole('button', { name: /invite member/i }));

    const email = await screen.findByLabelText(/email/i);
    const password = screen.getByLabelText(/password/i);
    await user.type(email, 'new@acme.test');
    await user.type(password, 'sup3rsecret');
    await user.click(screen.getByRole('button', { name: /create member/i }));

    await waitFor(() => {
      expect(mockApi.createUser).toHaveBeenCalledWith({
        email: 'new@acme.test',
        password: 'sup3rsecret',
      });
    });
  });
});
