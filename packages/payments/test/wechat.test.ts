import { createCipheriv, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { InvalidInputError, SignatureVerificationError } from '../src/types.js';
import { createWechatProvider } from '../src/wechat.js';

// A throwaway RSA keypair: the test signs with the private key; the provider is
// configured with the matching public key (simulating WeChat's public-key mode).
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PUBLIC_KEY_PEM = publicKey.export({ type: 'spki', format: 'pem' });

const SERIAL = 'PUB_KEY_ID_0123456789ABCDEF';
const APIV3_KEY = '01234567890123456789012345678901'; // 32 bytes for AES-256-GCM

/** Encrypts a plaintext resource the way WeChat does (AES-256-GCM, base64). */
function encryptResource(plaintext: string): {
  ciphertext: string;
  nonce: string;
  associated_data: string;
} {
  const nonce = randomBytes(12).toString('hex').slice(0, 12);
  const associatedData = 'transaction';
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(APIV3_KEY, 'utf8'), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(associatedData, 'utf8'));
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // WeChat appends the 16-byte auth tag to the ciphertext, then base64-encodes.
  const ciphertext = Buffer.concat([enc, tag]).toString('base64');
  return { ciphertext, nonce, associated_data: associatedData };
}

/** Builds a signed WeChat APIv3 webhook: body + Wechatpay-* headers. */
function signedNotification(
  resourcePlain: string,
  eventType = 'TRANSACTION.SUCCESS',
): {
  body: string;
  headers: Record<string, string>;
} {
  const resource = encryptResource(resourcePlain);
  const body = JSON.stringify({
    id: 'wx_evt_1',
    event_type: eventType,
    resource_type: 'encrypt-resource',
    resource: {
      algorithm: 'AEAD_AES_256_GCM',
      original_type: 'transaction',
      ...resource,
    },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = 'abc123nonce';
  const message = `${timestamp}\n${nonce}\n${body}\n`;
  const signature = createSign('RSA-SHA256').update(message, 'utf8').sign(privateKey, 'base64');
  return {
    body,
    headers: {
      'wechatpay-serial': SERIAL,
      'wechatpay-timestamp': timestamp,
      'wechatpay-nonce': nonce,
      'wechatpay-signature': signature,
    },
  };
}

const CONFIG = {
  appId: 'wx_app',
  mchId: '1900000001',
  apiV3Key: APIV3_KEY,
  publicKey: PUBLIC_KEY_PEM,
  publicKeyId: SERIAL,
};

describe('wechat (APIv3) provider', () => {
  describe('when configured', () => {
    const provider = createWechatProvider(CONFIG);

    it('verifies + decrypts a correctly-signed TRANSACTION.SUCCESS notification', async () => {
      const resource = JSON.stringify({
        out_trade_no: 'OUT_TRADE_42',
        trade_state: 'SUCCESS',
        transaction_id: 'wx_txn_99',
      });
      const { body, headers } = signedNotification(resource);

      const verified = await provider.verifyWebhook(body, headers);

      expect(verified.eventId).toBe('wx_evt_1');
      expect(verified.type).toBe('TRANSACTION.SUCCESS');
      expect(verified.providerRef).toBe('OUT_TRADE_42');
      expect(verified.status).toBe('succeeded');
    });

    it('throws on a tampered body (signature no longer matches)', async () => {
      const { body, headers } = signedNotification(
        JSON.stringify({ out_trade_no: 'X', trade_state: 'SUCCESS' }),
      );
      const tampered = body.replace('wx_evt_1', 'wx_evt_evil');
      await expect(provider.verifyWebhook(tampered, headers)).rejects.toBeInstanceOf(
        SignatureVerificationError,
      );
    });

    it('throws when a signature header is missing', async () => {
      const { body, headers } = signedNotification(
        JSON.stringify({ out_trade_no: 'X', trade_state: 'SUCCESS' }),
      );
      const rest = { ...headers };
      delete rest['wechatpay-signature'];
      await expect(provider.verifyWebhook(body, rest)).rejects.toBeInstanceOf(
        SignatureVerificationError,
      );
    });

    it('throws when the serial does not match the configured public key id', async () => {
      const { body, headers } = signedNotification(
        JSON.stringify({ out_trade_no: 'X', trade_state: 'SUCCESS' }),
      );
      await expect(
        provider.verifyWebhook(body, { ...headers, 'wechatpay-serial': 'PUB_KEY_ID_OTHER' }),
      ).rejects.toBeInstanceOf(SignatureVerificationError);
    });
  });

  describe('when not configured (creds unset)', () => {
    const provider = createWechatProvider({});

    it('createIntent throws invalid_input', async () => {
      await expect(
        provider.createIntent({
          tenantId: '11111111-1111-1111-1111-111111111111',
          provider: 'wechat',
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
