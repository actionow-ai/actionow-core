import type { Request, Response } from 'express';

import { config } from '../config.js';
import { dataClient } from '../core-kit/index.js';
import { userStore } from '../store/users.js';

/** POST /api/files { userId, filename, content_type, size } → presign for a client-side PUT. */
export function filesRoute() {
  return async (req: Request, res: Response): Promise<void> => {
    const { userId, filename, content_type, size } = req.body ?? {};
    const row = userStore.get(String(userId));
    if (!row) {
      res.status(404).json({ error: 'unknown user' });
      return;
    }
    const { data, error } = await dataClient(config.baseUrl(), row.apiKey).POST('/v1/files/presign-upload', {
      body: { filename, content_type, size },
    });
    if (error) {
      res.status(502).json({ error });
      return;
    }
    res.json(data); // { file_id, upload_url, key, expires_in }
  };
}
