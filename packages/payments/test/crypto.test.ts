import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createCryptoProvider } from '../src/crypto.js';
import { InvalidInputError, SignatureVerificationError } from '../src/types.js';

const SHARED_SECRET = 'coinbase_commerce_shared_secret';

function sign(body: string, secret = SHARED_SECRET): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

describe('crypto (Coinbase Commerce) provider', () => {
  describe('when configured', () => {
    const provider = createCryptoProvider({ webhookSecret: SHARED_SECRET });

    it('verifies a correctly-signed charge:confirmed event', async () => {
      const body = JSON.stringify({
        event: {
          id: 'evt_cb_1',
          type: 'charge:confirmed',
          data: { code: 'CHARGE_CODE_1' },
        },
      });
      const verified = await provider.verifyWebhook(body, {
        'x-cc-webhook-signature': sign(body),
      });

      expect(verified.eventId).toBe('evt_cb_1');
      expect(verified.type).toBe('charge:confirmed');
      expect(verified.providerRef).toBe('CHARGE_CODE_1');
      expect(verified.status).toBe('succeeded');
    });

    it('throws on a signature computed with the wrong secret', async () => {
      const body = JSON.stringify({
        event: { id: 'evt_cb_2', type: 'charge:confirmed', data: { code: 'C2' } },
      });
      await expect(
        provider.verifyWebhook(body, { 'x-cc-webhook-signature': sign(body, 'wrong') }),
      ).rejects.toBeInstanceOf(SignatureVerificationError);
    });

    it('throws when the signature header is absent', async () => {
      const body = JSON.stringify({
        event: { id: 'e', type: 'charge:confirmed', data: { code: 'c' } },
      });
      await expect(provider.verifyWebhook(body, {})).rejects.toBeInstanceOf(
        SignatureVerificationError,
      );
    });

    it('throws when the body is tampered after signing', async () => {
      const body = JSON.stringify({
        event: { id: 'evt_cb_3', type: 'charge:confirmed', data: { code: 'C3' } },
      });
      const header = sign(body);
      const tampered = body.replace('C3', 'EVIL');
      await expect(
        provider.verifyWebhook(tampered, { 'x-cc-webhook-signature': header }),
      ).rejects.toBeInstanceOf(SignatureVerificationError);
    });

    it('maps a non-confirmed event to a non-succeeded status', async () => {
      const body = JSON.stringify({
        event: { id: 'evt_cb_4', type: 'charge:failed', data: { code: 'C4' } },
      });
      const verified = await provider.verifyWebhook(body, {
        'x-cc-webhook-signature': sign(body),
      });
      expect(verified.status).toBe('failed');
    });
  });

  describe('when not configured (creds unset)', () => {
    const provider = createCryptoProvider({});

    it('createIntent throws invalid_input', async () => {
      await expect(
        provider.createIntent({
          tenantId: '11111111-1111-1111-1111-111111111111',
          provider: 'crypto',
          purpose: 'topup',
          amountMinor: 1000n,
          currency: 'usd',
        }),
      ).rejects.toBeInstanceOf(InvalidInputError);
    });

    it('verifyWebhook throws invalid_input', async () => {
      await expect(
        provider.verifyWebhook('{}', { 'x-cc-webhook-signature': 'x' }),
      ).rejects.toBeInstanceOf(InvalidInputError);
    });
  });
});
