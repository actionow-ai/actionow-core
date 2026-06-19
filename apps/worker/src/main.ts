import 'reflect-metadata';

import { createWorkerRuntime } from './runtime.js';
import { startWorkers } from './start.js';

/**
 * Worker entrypoint: build the production runtime from the environment and boot
 * the BullMQ Workers + repeatable sweeps via {@link startWorkers} (which logs
 * `worker ready` once `job-exec` connects), then register SIGTERM/SIGINT
 * handlers that DRAIN and close the workers before exit — so a routine deploy
 * lets in-flight jobs finish (or transition cleanly) instead of being hard-
 * killed mid-poll and stranded `running` until the reaper.
 */
function bootstrap(): void {
  const runtime = createWorkerRuntime();
  const workers = startWorkers(runtime);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`received ${signal}, draining workers...`);
    workers
      .close()
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
