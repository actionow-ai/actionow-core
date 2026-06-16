import { STORAGE_PROVIDERS } from '@actionow/contracts';
import { z } from 'zod';

/** A weak, well-known secret used ONLY outside production for local dev/tests. */
const DEV_ADMIN_JWT_SECRET = 'dev-admin-jwt-secret-do-not-use-in-prod';

/** Default ceiling on a presigned upload's declared size: 100 MiB. */
const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const EnvSchema = z
  .object({
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
    // HMAC secret for admin JWTs. Required in production; outside production a
    // well-known dev default is filled in below. Never logged.
    ADMIN_JWT_SECRET: z.string().min(1).optional(),
    // Default S3-compatible object-storage provider. All STORAGE_* fields are
    // optional so the API boots without storage configured; the /v1/files
    // endpoints guard usage and fail with `invalid_input` when unconfigured.
    // Credentials are never logged.
    STORAGE_PROVIDER: z.enum(STORAGE_PROVIDERS).optional(),
    STORAGE_BUCKET: z.string().min(1).optional(),
    STORAGE_REGION: z.string().min(1).optional(),
    STORAGE_ENDPOINT: z.string().url().optional(),
    STORAGE_ACCESS_KEY_ID: z.string().min(1).optional(),
    STORAGE_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    STORAGE_FORCE_PATH_STYLE: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    // Ceiling on a presigned upload's declared size (bytes). Defaults to 100 MiB.
    STORAGE_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(DEFAULT_MAX_UPLOAD_BYTES),
  })
  .transform((env) => ({
    ...env,
    ADMIN_JWT_SECRET:
      env.ADMIN_JWT_SECRET ?? (env.NODE_ENV === 'production' ? undefined : DEV_ADMIN_JWT_SECRET),
  }))
  .superRefine((env, ctx) => {
    if (env.ADMIN_JWT_SECRET === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ADMIN_JWT_SECRET'],
        message: 'ADMIN_JWT_SECRET is required in production',
      });
    }
  });

export type AppEnv = z.infer<typeof EnvSchema> & { ADMIN_JWT_SECRET: string };

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const env = EnvSchema.parse(source);
  // The superRefine guarantees ADMIN_JWT_SECRET is set; narrow the type.
  return env as AppEnv;
}
