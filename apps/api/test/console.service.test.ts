import type { Database } from '@actionow/db';
import type { PaymentService } from '@actionow/engine';
import { describe, expect, it, vi } from 'vitest';

import { ConsoleService } from '../src/console/console.service.js';
import type { ModelsPort } from '../src/console/models.port.js';

const fakeDb = {} as Database;

function service(overrides: {
  models?: ModelsPort;
  payments?: Pick<PaymentService, 'createIntent'>;
}): ConsoleService {
  const models: ModelsPort = overrides.models ?? { listVisibleModels: () => Promise.resolve([]) };
  const payments = (overrides.payments ?? {
    createIntent: vi.fn().mockResolvedValue({ intentId: 'pi_1', redirectUrl: 'https://x' }),
  }) as PaymentService;
  return new ConsoleService(fakeDb, payments, models);
}

describe('ConsoleService', () => {
  it('listModels delegates to the ModelsPort with the caller tenant', async () => {
    const listVisibleModels = vi
      .fn()
      .mockResolvedValue([
        {
          name: 'gpt-4o',
          display: 'GPT-4o',
          modality: 'chat',
          capabilities: {},
          visibility: 'public',
        },
      ]);
    const svc = service({ models: { listVisibleModels } });
    const out = await svc.listModels('tenant-1');
    expect(listVisibleModels).toHaveBeenCalledWith(fakeDb, 'tenant-1');
    expect(out[0]?.name).toBe('gpt-4o');
  });

  it('selfTopup creates a topup intent scoped to the caller tenant', async () => {
    const createIntent = vi.fn().mockResolvedValue({ intentId: 'pi_2' });
    const svc = service({ payments: { createIntent } });
    const res = await svc.selfTopup(
      { provider: 'stripe', amount_minor: 5000, currency: 'usd' },
      'tenant-9',
    );
    expect(createIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-9',
        provider: 'stripe',
        purpose: 'topup',
        amountMinor: 5000n,
        currency: 'usd',
      }),
    );
    expect(res.intent_id).toBe('pi_2');
  });
});
