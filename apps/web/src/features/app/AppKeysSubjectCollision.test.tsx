import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsoleActionContext } from '../../components/console/ConsoleChrome';
import i18n from '../../i18n';
import { qk } from '../../lib/api/queryKeys';
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

// `/console/api-keys` returns a non-infinite `Page` ({rows,nextCursor}). AppKeys
// reads it through `useInfiniteQuery` ({pages,pageParams}); the Subjects drawer
// panel reads the SAME endpoint through a plain `useQuery`. The regression: if the
// panel shared AppKeys' query key, its `Page` shape would clobber the infinite
// cache entry and AppKeys' `data.pages.flatMap` would throw on its next mount.
const mockApi = vi.hoisted(() => ({
  me: vi.fn(() => Promise.resolve({ tenant_role: 'admin' as string | null })),
  listApiKeys: vi.fn(() => Promise.resolve({ rows: [] as unknown[], nextCursor: null })),
  createApiKey: vi.fn(),
  rotateApiKey: vi.fn(),
  disableApiKey: vi.fn(),
  getSubAccount: vi.fn(() => Promise.reject(new Error('404'))),
  openSubAccount: vi.fn(),
  topupSubAccount: vi.fn(),
  transferSubAccount: vi.fn(),
  setSubjectLimitPlan: vi.fn(),
}));
vi.mock('../../lib/api/useConsoleApi', () => ({ useConsoleApi: () => mockApi }));

const { AppKeys } = await import('./AppKeys');
const { AppSubjectDetailPanel } = await import('./AppSubjectDetailPanel');

function harness(node: ReactNode, qc: QueryClient) {
  return (
    <QueryClientProvider client={qc}>
      <ConsoleActionContext.Provider value={() => {}}>
        <MemoryRouter>{node}</MemoryRouter>
      </ConsoleActionContext.Provider>
    </QueryClientProvider>
  );
}

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  vi.clearAllMocks();
  mockApi.me.mockResolvedValue({ tenant_role: 'admin' });
  mockApi.listApiKeys.mockResolvedValue({ rows: [], nextCursor: null });
  mockApi.getSubAccount.mockRejectedValue(new Error('404'));
});

describe('AppKeys / Subjects-drawer query-key isolation', () => {
  it('does not white-screen AppKeys after the subject drawer populates the keys cache', async () => {
    // One shared client across both screens — the realistic SPA navigation flow.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    // 1. Open a subject drawer: the panel's keys `useQuery` resolves and writes
    //    the `Page` shape into ITS cache entry.
    const drawer = render(
      harness(<AppSubjectDetailPanel subject={ada} planOptions={[]} onClose={() => {}} />, qc),
    );
    await waitFor(() => {
      expect(qc.getQueryData(qk.consoleApiKeysForSubject(ada.id))).toBeDefined();
    });
    // The panel must NOT have written to AppKeys' shared infinite key.
    expect(qc.getQueryData(qk.consoleApiKeys())).toBeUndefined();
    drawer.unmount();

    // 2. Navigate to /app/keys: AppKeys mounts and reads `data.pages.flatMap`.
    //    Pre-fix this threw a TypeError during render (no error boundary).
    render(harness(<AppKeys />, qc));
    expect(await screen.findByText(/no api keys yet/i)).toBeInTheDocument();
  });
});
