import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '../../i18n';
import type { ChannelView } from '../../lib/api/types';

const mockApi = vi.hoisted(() => ({
  listModels: vi.fn(() => Promise.resolve([])),
  listSecrets: vi.fn(() => Promise.resolve([])),
  listFaultPolicies: vi.fn(() => Promise.resolve([])),
  createSecret: vi.fn(() => Promise.resolve({ id: 's1', provider: 'openai', created_at: '' })),
  updateChannel: vi.fn(() => Promise.resolve({})),
  createChannel: vi.fn(() => Promise.resolve({})),
}));
vi.mock('../../lib/api/useAdminApi', () => ({ useAdminApi: () => mockApi }));

const { ChannelEditor } = await import('./ChannelEditor');

function renderEd(el: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{el}</QueryClientProvider>);
}

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

beforeEach(() => {
  vi.clearAllMocks();
});

const channel: ChannelView = {
  id: 'c1',
  resource_id: 'r1',
  provider_type: 'openai',
  credential_ref: null,
  endpoint: null,
  model: null,
  proxy_ref: null,
  config: null,
  weight: 1,
  status: 'active',
  input_cost_per_1m: '500000',
  output_cost_per_1m: null,
  fault_policy_id: null,
  model_count: 0,
  icon: null,
  plugin_id: null,
  tags: ['canary'],
};

describe('ChannelEditor cost fields', () => {
  it('seeds the operator-cost field from a µUSD string as USD (500000µUSD → 0.5)', async () => {
    renderEd(<ChannelEditor resourceId="r1" channel={channel} open onClose={() => undefined} />);
    // Per-channel cost now lives behind the advanced toggle.
    fireEvent.click(await screen.findByRole('button', { name: /Advanced/i }));
    expect(await screen.findByDisplayValue('0.5')).toBeInTheDocument();
  });
});

describe('ChannelEditor route tags (染色/标签路由)', () => {
  it('seeds the tags chips from the channel and adds + persists a new tag on save', async () => {
    const user = userEvent.setup();
    renderEd(<ChannelEditor resourceId="r1" channel={channel} open onClose={() => undefined} />);
    // The seeded tag renders as a chip.
    expect(await screen.findByText('canary')).toBeInTheDocument();
    // The tags field's own input (last textbox in the form) accepts a new tag.
    const inputs = screen.getAllByRole('textbox');
    const tagInput = inputs[inputs.length - 1];
    await user.type(tagInput, 'beta{Enter}');
    await user.click(screen.getByRole('button', { name: /Save channel/i }));
    await waitFor(() => expect(mockApi.updateChannel).toHaveBeenCalled());
    const body = (mockApi.updateChannel.mock.calls[0] as unknown[])[2] as { tags: string[] };
    expect(body.tags).toEqual(['canary', 'beta']);
  });
});
