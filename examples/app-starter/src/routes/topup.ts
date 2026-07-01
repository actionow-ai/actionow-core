import type { Request, Response } from 'express';

import { config } from '../config.js';
import { consoleClient, rawPost, type ConsoleSession } from '../core-kit/index.js';

/**
 * POST /api/topup { code } — redeem a 卡密, OR { provider, amount_minor, currency } — a payment intent.
 * Recharge is a control-plane action (tenant-admin), NOT something a member JWT can do.
 */
export function topupRoute(session: ConsoleSession) {
  return async (req: Request, res: Response): Promise<void> => {
    const base = config.baseUrl();
    const jwt = await session.token();
    if (req.body?.code) {
      // /console/redeem is UNTYPED → rawPost. Returns { credited, balance } (µcredit strings).
      res.json(await rawPost(base, '/console/redeem', { code: req.body.code }, jwt));
      return;
    }
    const { provider, currency } = req.body ?? {};
    const amount_minor = Number(req.body?.amount_minor); // contract wants an integer (minor units)
    if (!provider || !Number.isInteger(amount_minor) || amount_minor <= 0) {
      res.status(400).json({ error: 'provider + positive integer amount_minor required' });
      return;
    }
    // /console/payments/intents IS typed → SDK. Returns { intent_id, redirect_url?, qr? }.
    const { data, error } = await consoleClient(base, jwt).POST('/console/payments/intents', {
      body: { provider, amount_minor, currency },
    });
    if (error) {
      res.status(502).json({ error });
      return;
    }
    res.json(data);
  };
}
