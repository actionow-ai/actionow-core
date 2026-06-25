import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsoleActionContext } from '../../components/console/ConsoleChrome';
import i18n from '../../i18n';

const mockApi = vi.hoisted(() => ({
  me: vi.fn(() => Promise.resolve({ tenant_role: 'admin' as string | null })),
  listApiKeys: vi.fn(() => Promise.resolve({ rows: [] as unknown[], nextCursor: null })),
  createApiKey: vi.fn(),
  rotateApiKey: vi.fn(),
  disableApiKey: vi.fn(),
}));
vi.mock('../../lib/api/useConsoleApi', () => ({ useConsoleApi: () => mockApi }));

const { AppKeys } = await import('./AppKeys');

/** Render AppKeys, capturing the node it publishes into the TopBar action slot. */
function renderKeys() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let action: ReactNode = null;
  render(
    <QueryClientProvider client={qc}>
      <ConsoleActionContext.Provider
        value={(node) => {
          action = node;
        }}
      >
        <MemoryRouter>
          <AppKeys />
        </MemoryRouter>
      </ConsoleActionContext.Provider>
    </QueryClientProvider>,
  );
  return { getAction: () => action };
}

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  mockApi.listApiKeys.mockResolvedValue({ rows: [], nextCursor: null });
});

describe('AppKeys role gating', () => {
  it('hides the mint action for a tenant member', async () => {
    mockApi.me.mockResolvedValue({ tenant_role: 'member' });
    const { getAction } = renderKeys();
    // Once `me` resolves to a member, the published action is cleared (null).
    await waitFor(() => {
      expect(getAction()).toBeNull();
    });
  });

  it('publishes the mint action for a tenant admin', async () => {
    mockApi.me.mockResolvedValue({ tenant_role: 'admin' });
    const { getAction } = renderKeys();
    await waitFor(() => {
      expect(getAction()).not.toBeNull();
    });
    // The empty-list copy renders for both roles.
    expect(await screen.findByText(/no api keys yet/i)).toBeInTheDocument();
  });
});
