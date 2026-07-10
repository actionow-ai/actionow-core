import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
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
  listSecretsPage: vi.fn(() => Promise.resolve({ rows: [] as unknown[], nextCursor: null })),
  revokeOAuthSession: vi.fn(() => Promise.resolve()),
  bulkRevokeOAuthSessions: vi.fn(
    (): Promise<{ succeeded: string[]; failed: { id: string; error: string }[] }> =>
      Promise.resolve({ succeeded: [], failed: [] }),
  ),
  deleteSecret: vi.fn(() => Promise.resolve()),
  updateOAuthSession: vi.fn(() => Promise.resolve({})),
  updateSecret: vi.fn(() => Promise.resolve({})),
  startCodexLogin: vi.fn(() => Promise.resolve({ authorize_url: 'https://x', state: 'st' })),
  completeCodexLogin: vi.fn(() => Promise.resolve({ id: 's2' })),
  createOAuthSession: vi.fn(() => Promise.resolve({ id: 's3' })),
}));
vi.mock('../../lib/api/useAdminApi', () => ({ useAdminApi: () => mockApi }));

const mockToast = vi.hoisted(() => vi.fn());
vi.mock('../../components/ui/toast', () => ({ toast: mockToast }));

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
  mockApi.bulkRevokeOAuthSessions.mockClear();
  mockApi.bulkRevokeOAuthSessions.mockResolvedValue({ succeeded: ['s1'], failed: [] });
  mockToast.mockClear();
  mockApi.listOAuthSessions.mockResolvedValue({ rows: [session], nextCursor: null });
  mockApi.listSecretsPage.mockResolvedValue({ rows: [], nextCursor: null });
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
    // ConfirmDialog confirm button — now shares the row's "revoke" verb, so scope
    // to the dialog to disambiguate from the still-mounted row action.
    const dialog = await screen.findByRole('dialog');
    await user.click(
      within(dialog).getByRole('button', { name: i18n.t('console:oauthSessions.revoke') }),
    );

    expect(mockApi.revokeOAuthSession).toHaveBeenCalledWith('s1');
  });

  it('bulk-revokes selected sessions via ONE call + result toast', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('me@example.com');
    // Select the row → the bulk-action bar appears.
    await user.click(screen.getByRole('checkbox', { name: i18n.t('console:table.selectRow') }));
    await user.click(
      await screen.findByRole('button', {
        name: i18n.t('console:credentials.bulkRevoke', { n: 1 }),
      }),
    );

    // ONE bulk call (not N single revokes), then a result toast.
    expect(mockApi.bulkRevokeOAuthSessions).toHaveBeenCalledTimes(1);
    expect(mockApi.bulkRevokeOAuthSessions).toHaveBeenCalledWith(['s1']);
    expect(mockApi.revokeOAuthSession).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        i18n.t('console:admin.bulk.result', { ok: 1, failed: 0 }),
      );
    });
  });
});
