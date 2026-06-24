import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

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
};

describe('ChannelEditor cost fields', () => {
  it('seeds the operator-cost field from a µUSD string as USD (500000µUSD → 0.5)', async () => {
    renderEd(<ChannelEditor resourceId="r1" channel={channel} open onClose={() => undefined} />);
    expect(await screen.findByDisplayValue('0.5')).toBeInTheDocument();
  });
});
