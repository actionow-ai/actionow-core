import { afterEach, describe, expect, it } from 'vitest';

import { type RunningHealthServer, startHealthServer } from '../src/health-server.js';

/**
 * Unit test for the worker's minimal liveness server. Binds an ephemeral port
 * (0), then asserts:
 *   - `GET /health` → 200 `{status:'ok'}`
 *   - `GET /` → 200 `{status:'ok'}`
 *   - an unknown path → 404
 *   - `close()` releases the port (a subsequent request is refused)
 * Pure Node `http` + the global `fetch`; no Redis/BullMQ.
 */

let handle: RunningHealthServer | undefined;

afterEach(async () => {
  if (handle !== undefined) {
    await handle.close();
    handle = undefined;
  }
});

/** Start the server on a high, unlikely-to-collide port and wait for the bind. */
async function start(): Promise<number> {
  const port = 30_000 + Math.floor(Math.random() * 20_000);
  handle = startHealthServer(port);
  // Give listen() a tick to bind before the first request.
  await new Promise((resolve) => setTimeout(resolve, 50));
  return port;
}

describe('startHealthServer', () => {
  it('serves 200 ok on /health and /, 404 elsewhere, and releases the port on close', async () => {
    const port = await start();

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });

    const root = await fetch(`http://127.0.0.1:${port}/`);
    expect(root.status).toBe(200);
    expect(await root.json()).toEqual({ status: 'ok' });

    const missing = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(missing.status).toBe(404);

    await handle?.close();
    handle = undefined;

    // After close the port is released; a fetch is refused (connection error).
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });

  it('close() is idempotent', async () => {
    await start();
    await handle?.close();
    // A second close resolves without throwing.
    await expect(handle?.close()).resolves.toBeUndefined();
    handle = undefined;
  });
});
