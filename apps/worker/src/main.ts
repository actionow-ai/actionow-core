import 'reflect-metadata';

import { WORKER_HEALTH_PORT_DEFAULT } from '@actionow/infra';

import { startHealthServer } from './health-server.js';
import { createWorkerRuntime } from './runtime.js';
import { startWorkers } from './start.js';

/**
 * Worker entrypoint: build the production runtime from the environment and boot
 * the BullMQ Workers + repeatable sweeps via {@link startWorkers} (which logs
 * `worker ready` once the queues connect), bring up a minimal HTTP liveness
 * server on `WORKER_HEALTH_PORT` (so an orchestrator can probe the otherwise-
 * headless process), then register SIGTERM/SIGINT handlers that DRAIN and close
 * the workers (and the liveness server) before exit — so a routine deploy lets
 * in-flight jobs finish (or transition cleanly) instead of being hard-killed
 * mid-poll and stranded `running` until the reaper.
 */
function bootstrap(): void {
  const runtime = createWorkerRuntime();
  const workers = startWorkers(runtime);
  // Expose liveness only AFTER the workers are booted, so a 200 means the
  // process is up and processing. Pure Node http — no dependency checks.
  const health = startHealthServer(runtime.env.WORKER_HEALTH_PORT ?? WORKER_HEALTH_PORT_DEFAULT);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`received ${signal}, draining workers...`);
    health
      .close()
      .catch((err: unknown) => {
        console.error(`error closing worker liveness server: ${String(err)}`);
      })
      .then(() => workers.close())
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        console.error(`error during worker shutdown: ${String(err)}`);
        process.exit(1);
      });
  };
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
}

bootstrap();
