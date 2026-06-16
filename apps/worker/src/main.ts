import 'reflect-metadata';

import { createWorkerRuntime } from './runtime.js';
import { startWorkers } from './start.js';

/**
 * Worker entrypoint: build the production runtime from the environment and boot
 * the three BullMQ Workers + repeatable sweeps via {@link startWorkers} (which
 * logs `worker ready` once `job-exec` connects). Behavior is unchanged from the
 * pre-refactor inline boot; `startWorkers` is the shared, testable core.
 */
function bootstrap(): void {
  const runtime = createWorkerRuntime();
  startWorkers(runtime);
}

bootstrap();
