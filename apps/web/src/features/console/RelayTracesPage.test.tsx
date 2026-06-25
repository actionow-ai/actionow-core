import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '../../i18n';
import type { RelayTraceView } from '../../lib/api/types';

function trace(over: Partial<RelayTraceView> = {}): RelayTraceView {
  return {
    id: 't1',
    created_at: '2026-06-25T00:00:00.000Z',
    tenant_id: null,
    job_id: null,
    channel_id: null,
    provider_type: 'openai',
    method: 'POST',
    url: 'https://api.openai.com/v1/chat/completions',
    request_headers: null,
    request_body: null,
    response_status: 200,
    response_body: null,
    is_stream: false,
    latency_ms: 42,
    error: null,
    truncated: false,
    route_tag: null,
    ...over,
  };
}

const mockApi = vi.hoisted(() => ({
  listRelayTraces: vi.fn(() => Promise.resolve({ rows: [] as unknown[], nextCursor: null })),
}));
vi.mock('../../lib/api/useAdminApi', () => ({ useAdminApi: () => mockApi }));

const { RelayTracesPage } = await import('./RelayTracesPage');

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <RelayTracesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  mockApi.listRelayTraces.mockReset();
  mockApi.listRelayTraces.mockResolvedValue({ rows: [], nextCursor: null });
});

describe('RelayTracesPage route_tag column (染色)', () => {
  it('renders the route-tag header column', async () => {
    renderPage();
    expect(await screen.findByText(i18n.t('console:relayTraces.cols.routeTag'))).toBeInTheDocument();
  });

  it('renders a colored row tag as a chip and null as a dash', async () => {
    mockApi.listRelayTraces.mockResolvedValue({
      rows: [trace({ id: 'a', route_tag: 'canary' }), trace({ id: 'b', route_tag: null })],
      nextCursor: null,
    });
    renderPage();
    // The colored call shows the tag value.
    expect(await screen.findByText('canary')).toBeInTheDocument();
    // The header-less call renders an em-dash placeholder in its route-tag cell.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});

describe('RelayTracesPage route_tag filter (染色)', () => {
  it('passes the typed route tag into the list query (server-side filter)', async () => {
    const user = userEvent.setup();
    renderPage();
    // Wait for the initial (unfiltered) load.
    await waitFor(() => expect(mockApi.listRelayTraces).toHaveBeenCalled());

    const input = screen.getByPlaceholderText(i18n.t('console:relayTraces.routeTagPlaceholder'));
    await user.type(input, 'canary');

    // The debounced commit eventually fires a query carrying routeTag.
    await waitFor(
      () =>
        expect(
          (mockApi.listRelayTraces.mock.calls as unknown[][]).some(
            (c) => (c[0] as { routeTag?: string } | undefined)?.routeTag === 'canary',
          ),
        ).toBe(true),
      { timeout: 2000 },
    );
  });
});
