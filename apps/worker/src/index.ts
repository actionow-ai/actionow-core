/**
 * Public surface of `@actionow/worker`. The api's full-stack e2e imports
 * {@link startWorkers} + {@link createWorkerRuntime} to boot a real worker
 * against a Testcontainers Redis. `main.ts` is the process entrypoint and is
 * NOT re-exported (importing it would run `bootstrap`).
 */
export { createWorkerRuntime, type WorkerRuntime } from './runtime.js';
export { type RunningWorkers, startWorkers, type StartWorkersOptions } from './start.js';
