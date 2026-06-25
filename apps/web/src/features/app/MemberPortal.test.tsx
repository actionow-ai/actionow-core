import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '../../i18n';
import type {
  MemberBalanceView,
  MemberKeyView,
  MemberLimitsView,
  MemberMeView,
  MemberUsageList,
} from '../../lib/api/types';
import { ThemeProvider } from '../../lib/theme/ThemeProvider';

const me: MemberMeView = {
  id: 'sub-1',
  status: 'active',
  tenant_id: 't1',
  external_id: null,
  email: 'enduser@example.com',
  display_name: 'End User',
};

const balance: MemberBalanceView = { mode: 'hard', balance: '5000000', held: '0' };

const usage: MemberUsageList = {
  data: [
    {
      id: 'u1',
      model: 'gpt-5.5',
      input_tokens: 100,
      output_tokens: 200,
      cost: '12000',
      latency_ms: 540,
      status: 'success',
      created_at: '2026-06-20T10:00:00Z',
    },
  ],
  next_cursor: null,
};

const keys: MemberKeyView[] = [
  { id: 'key-1', name: 'default', status: 'active', created_at: '2026-06-01T00:00:00Z', last4: 'ab12' },
];

const limits: MemberLimitsView = {
  plan: { id: 'lp-1', name: 'Starter' },
  rules: [
    {
      dimension: 'spend',
      period: 'month',
      cap: '100000000',
      used: '20000000',
      model_scope: null,
      alert_pct: 80,
      enforce: 'block',
    },
  ],
};

const mockApi = vi.hoisted(() => ({
  me: vi.fn(() => Promise.resolve(me)),
  balance: vi.fn(() => Promise.resolve(balance)),
  usage: vi.fn(() => Promise.resolve(usage)),
  apiKeys: vi.fn(() => Promise.resolve(keys)),
  limits: vi.fn(() => Promise.resolve(limits)),
}));
vi.mock('../../lib/api/useMemberApi', () => ({ useMemberApi: () => mockApi }));

const auth = vi.hoisted(() => ({ logout: vi.fn() }));
vi.mock('../../lib/auth/AuthProvider', () => ({
  useAuth: () => ({ ...auth, user: { id: 'sub-1', role: 'member', tenantId: 't1' } }),
}));

const { MemberPortal } = await import('./MemberPortal');

function renderPortal() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ThemeProvider>
        <MemoryRouter>
          <MemberPortal />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  vi.clearAllMocks();
  mockApi.me.mockResolvedValue(me);
  mockApi.balance.mockResolvedValue(balance);
  mockApi.usage.mockResolvedValue(usage);
  mockApi.apiKeys.mockResolvedValue(keys);
  mockApi.limits.mockResolvedValue(limits);
});

describe('MemberPortal self-service', () => {
  it('renders the member identity (email)', async () => {
    renderPortal();
    expect(await screen.findByText('enduser@example.com')).toBeInTheDocument();
  });

  it('renders the wallet balance (5 credits from 5000000 µUSD)', async () => {
    renderPortal();
    // BalanceCard formats µUSD → credits (5000000 µUSD = 5 credits).
    expect(await screen.findByText('5')).toBeInTheDocument();
  });

  it('renders a usage-log row (model)', async () => {
    renderPortal();
    expect(await screen.findByText('gpt-5.5')).toBeInTheDocument();
  });

  it("renders the member's masked api key (last4)", async () => {
    renderPortal();
    expect(await screen.findByText(/ab12/)).toBeInTheDocument();
  });

  it('renders the bound plan + a usage-vs-cap bar', async () => {
    renderPortal();
    expect(await screen.findByText('Starter')).toBeInTheDocument();
    // UsageBar renders "used / cap (pct%)" in credits: 20 / 100 (20%) from µUSD.
    expect(screen.getByText(/20 \/ 100/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });
});
