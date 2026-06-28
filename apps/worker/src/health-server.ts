import { createServer, type Server } from 'node:http';

/** A running liveness server; `close()` stops accepting and shuts it down. */
export interface RunningHealthServer {
  /** Stop the server (idempotent). Resolves once it has fully closed. */
  close: () => Promise<void>;
}

/**
 * Start a minimal, dependency-free HTTP liveness server for the headless
 * worker. `GET /health` (and `/`) returns `200 {"status":"ok"}` — proving the
 * worker process is up and its BullMQ workers have been booted; any other path
 * is `404`. This is LIVENESS only (no dependency checks): an orchestrator uses
 * it to decide whether to RESTART the worker, so it must not flap on a transient
 * Redis blip. Closed on graceful shutdown so the port is released cleanly.
 *
 * Kept tiny and self-contained (Node `http`, no Nest/express) since the worker
 * is otherwise a pure BullMQ process.
 */
export function startHealthServer(port: number): RunningHealthServer {
  const server: Server = createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'not_found' }));
  });

  server.listen(port, () => {
    console.log(`worker liveness server listening on :${String(port)}`);
  });

  let closed = false;
  return {
    close(): Promise<void> {
      if (closed) return Promise.resolve();
      closed = true;
      return new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err !== undefined) reject(err);
          else resolve();
        });
      });
    },
  };
}
