import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  API_PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  // Dev-only fallback tenant id when no `x-tenant-id` header is supplied. The
  // ApiKeyGuard honors this only outside production (real keys are required in
  // prod).
  DEV_TENANT_ID: z.string().uuid().optional(),
  // Two-level rate-limit defaults (requests per minute). The per-tenant bucket
  // is a coarse account-wide cap; the per-(tenant,resource) bucket defaults to
  // this value unless an API key carries its own `rateLimit`.
  RATE_LIMIT_TENANT_PER_MIN: z.coerce.number().int().positive().default(600),
  RATE_LIMIT_RESOURCE_PER_MIN: z.coerce.number().int().positive().default(120),
});

export type AppEnv = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  return EnvSchema.parse(source);
}
