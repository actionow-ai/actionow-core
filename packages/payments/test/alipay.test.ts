import { createSign, generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createAlipayProvider } from '../src/alipay.js';
import { InvalidInputError, SignatureVerificationError } from '../src/types.js';

// Throwaway RSA keypair. The test signs the canonical notify string with the
// private key (as Alipay's gateway would); the provider verifies with the
// matching public key configured as `alipayPublicKey`.
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PUBLIC_KEY_PEM = publicKey.export({ type: 'spki', format: 'pem' });
// A throwaway app private key; the provider needs *some* private key to
// construct, but verification only uses the public key.
const APP_PRIVATE_KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });

/**
 * Assembles the Alipay async-notify canonical string exactly as the SDK's
 * `checkNotifySignV2` does (sorted keys, `k=v` joined by `&`, `sign` excluded,
 * raw values) and RSA2-signs it.
 */
function signNotify(form: Record<string, string>): Record<string, string> {
  const signContent = Object.keys(form)
    .sort()
    .filter((k) => k && k !== 'sign')
    .map((k) => `${k}=${form[k] ?? ''}`)
    .join('&');
  const sign = createSign('RSA-SHA256').update(signContent, 'utf8').sign(privateKey, 'base64');
  return { ...form, sign };
}

const CONFIG = {
  appId: '2021000000000000',
  privateKey: APP_PRIVATE_KEY_PEM,
  alipayPublicKey: PUBLIC_KEY_PEM,
};

describe('alipay provider', () => {
  describe('when configured', () => {
    const provider = createAlipayProvider(CONFIG);

    it('verifies a correctly-signed TRADE_SUCCESS notification', async () => {
      const form = signNotify({
        notify_id: 'notify_001',
        notify_type: 'trade_status_sync',
        trade_status: 'TRADE_SUCCESS',
        out_trade_no: 'OUT_TRADE_7',
        trade_no: '20240101_TXN',
        sign_type: 'RSA2',
      });

      const verified = await provider.verifyWebhook(JSON.stringify(form), {});

      expect(verified.eventId).toBe('notify_001');
      expect(verified.type).toBe('trade_status_sync');
      expect(verified.providerRef).toBe('OUT_TRADE_7');
      expect(verified.status).toBe('succeeded');
    });

    it('throws when the signature does not verify (tampered field)', async () => {
      const form = signNotify({
        notify_id: 'notify_002',
        trade_status: 'TRADE_SUCCESS',
        out_trade_no: 'OUT_TRADE_8',
        sign_type: 'RSA2',
      });
      const tampered = { ...form, out_trade_no: 'OUT_TRADE_EVIL' };

      await expect(provider.verifyWebhook(JSON.stringify(tampered), {})).rejects.toBeInstanceOf(
        SignatureVerificationError,
      );
    });

    it('throws when the sign field is absent', async () => {
      const form = {
        notify_id: 'notify_003',
        trade_status: 'TRADE_SUCCESS',
        out_trade_no: 'X',
        sign_type: 'RSA2',
      };
      await expect(provider.verifyWebhook(JSON.stringify(form), {})).rejects.toBeInstanceOf(
        SignatureVerificationError,
      );
    });

    it('maps TRADE_CLOSED to failed', async () => {
      const form = signNotify({
        notify_id: 'notify_004',
        notify_type: 'trade_status_sync',
        trade_status: 'TRADE_CLOSED',
        out_trade_no: 'OUT_TRADE_9',
        sign_type: 'RSA2',
      });
      const verified = await provider.verifyWebhook(JSON.stringify(form), {});
      expect(verified.status).toBe('failed');
    });
  });

  describe('when not configured (creds unset)', () => {
    const provider = createAlipayProvider({});

    it('createIntent throws invalid_input', async () => {
      await expect(
        provider.createIntent({
          tenantId: '11111111-1111-1111-1111-111111111111',
          provider: 'alipay',
          purpose: 'topup',
          amountMinor: 1000n,
          currency: 'cny',
        }),
      ).rejects.toBeInstanceOf(InvalidInputError);
    });

    it('verifyWebhook throws invalid_input', async () => {
      await expect(provider.verifyWebhook('{}', {})).rejects.toBeInstanceOf(InvalidInputError);
    });
  });
});
