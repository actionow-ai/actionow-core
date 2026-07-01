import type { Request, Response } from 'express';

import { config } from '../config.js';
import { callWithRetry } from '../core-kit/index.js';
import { userStore } from '../store/users.js';

/** POST /api/chat { userId, messages, stream? } — proxy /v1/chat/completions with the user's ak_. */
export function chatRoute() {
  return async (req: Request, res: Response): Promise<void> => {
    const { userId, messages, stream } = req.body ?? {};
    const row = userStore.get(String(userId));
    if (!row) {
      res.status(404).json({ error: 'unknown user — onboard first' });
      return;
    }
    const base = config.baseUrl();
    // Attribution on the chat path comes from the user's SUBJECT-SCOPED ak_ (minted
    // in onboard) — NOT from end_user (the chat relay ignores end_user; it would only
    // be forwarded to the upstream provider). So we don't send it here.
    const body = JSON.stringify({ model: config.model(), messages, stream: Boolean(stream) });
    // The relay dialect is UNTYPED → raw fetch. The credit hold runs before the
    // first byte, so a pre-commit failure is a real non-2xx (retry only on retryable);
    // callWithRetry returns only on res.ok, so a pre-commit 402/429 throws here and is
    // rendered by the error middleware BEFORE any SSE header is written.
    const upstream = await callWithRetry(() =>
      fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${row.apiKey}`, 'content-type': 'application/json' },
        body,
      }),
    );
    if (!stream) {
      res.json(await upstream.json());
      return;
    }
    res.setHeader('content-type', 'text/event-stream');
    for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>)
      res.write(chunk);
    res.end();
  };
}
