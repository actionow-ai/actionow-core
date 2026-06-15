import 'reflect-metadata';

import { loadEnv } from '@actionow/infra';
import type { Job } from 'bullmq';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';

function bootstrap(): void {
  const env = loadEnv();
  const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const worker = new Worker(
    'job-exec',
    (job: Job) => {
      // placeholder: real processor added in Phase 3
      return Promise.resolve({ received: job.id });
    },
    { connection },
  );
  worker.on('ready', () => {
    console.log('worker ready: job-exec');
  });
}

bootstrap();
