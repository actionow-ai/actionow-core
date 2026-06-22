import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '../../i18n';
import type { OAuthSessionListView } from '../../lib/api/types';

const session: OAuthSessionListView = {
  id: 's1',
  provider_kind: 'codex-oauth',
  account_label: 'me@example.com',
  account_id: 'acct_1',
  name: null,
  notes: null,
  group: null,
  status: 'active',
  expires_at: null,
  last_refresh_at: null,
};

const mockApi = vi.hoisted(() => ({
  listOAuthSessions: vi.fn(() => Promise.resolve({ rows: [] as unknown[], nextCursor: null })),
  listSecrets: vi.fn(() => Promise.resolve([] as unknown[])),
  revokeOAuthSession: vi.fn(() => Promise.resolve()),
  deleteSecret: vi.fn(() => Promise.resolve()),
  startCodexLogin: vi.fn(() => Promise.resolve({ authorize_url: 'https://x', state: 'st' })),
  completeCodexLogin: vi.fn(() => Promise.resolve({ id: 's2' })),
  createOAuthSession: vi.fn(() => Promise.resolve({ id: 's3' })),
}));
vi.mock('../../lib/api/useAdminApi', () => ({ useAdminApi: () => mockApi }));

const { OAuthSessionsPage } = await import('./OAuthSessionsPage');

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <OAuthSessionsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  mockApi.revokeOAuthSession.mockClear();
  mockApi.listOAuthSessions.mockResolvedValue({ rows: [session], nextCursor: null });
  mockApi.listSecrets.mockResolvedValue([]);
});

describe('OAuthSessionsPage', () => {
  it('lists upstream OAuth subscription sessions', async () => {
    renderPage();
    expect(await screen.findByText('me@example.com')).toBeInTheDocument();
    expect(screen.getByText('codex-oauth')).toBeInTheDocument();
  });

  it('revokes a session via DELETE after confirming', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('me@example.com');
    await user.click(screen.getByRole('button', { name: i18n.t('console:oauthSessions.revoke') }));
    // ConfirmDialog confirm button.
    await user.click(await screen.findByRole('button', { name: i18n.t('console:common.delete') }));

    expect(mockApi.revokeOAuthSession).toHaveBeenCalledWith('s1');
  });
});
