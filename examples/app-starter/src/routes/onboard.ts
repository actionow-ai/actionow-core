import type { Request, Response } from 'express';

import { config } from '../config.js';
import { consoleClient, rawPost, type ConsoleSession } from '../core-kit/index.js';
import { userStore } from '../store/users.js';

/** POST /api/users { userId } — onboard your user as a core subject + mint their ak_. */
export function onboardRoute(session: ConsoleSession) {
  return async (req: Request, res: Response): Promise<void> => {
    const userId = String(req.body?.userId ?? '');
    if (!userId) {
      res.status(400).json({ error: 'userId required' });
      return;
    }
    // Idempotent: onboarding the same user twice must NOT create a second subject/key.
    const existing = userStore.get(userId);
    if (existing) {
      res.json({ userId, subject_id: existing.subjectId });
      return;
    }
    const base = config.baseUrl();
    const jwt = await session.token();
    // /console/subjects is UNTYPED → rawPost. externalId = your user id.
    const subject = await rawPost<{ id: string }>(base, '/console/subjects', { externalId: userId, displayName: userId }, jwt);
    // /console/api-keys IS typed → SDK client.
    const { data, error } = await consoleClient(base, jwt).POST('/console/api-keys', { body: { subjectId: subject.id } });
    if (error) {
      res.status(502).json({ error });
      return;
    }
    userStore.put({ userId, subjectId: subject.id, apiKey: data.plaintext });
    res.json({ userId, subject_id: subject.id }); // never return the ak_ to the caller
  };
}
