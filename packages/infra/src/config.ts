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
    // Gate for the dev-only `x-tenant-id` fallback in the ApiKeyGuard. Default
    // `false`: even outside production the guard requires a real key unless an
    // operator explicitly opts in. Hardens self-deploy (a misconfigured non-prod
    // instance no longer silently accepts an unauthenticated tenant header).
    ALLOW_DEV_TENANT_HEADER: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .default('false'),
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
    // OAuth provider credentials (Phase 9). All optional so the API boots
    // without OAuth configured; a provider whose creds are unset has its routes
    // return `invalid_input` (it never crashes). Secrets are never logged.
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    GITHUB_CLIENT_ID: z.string().min(1).optional(),
    GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
    // Base URL the provider redirects back to (e.g. `http://localhost:3000`);
    // the per-provider callback path is appended. Optional; required only to use
    // OAuth.
    OAUTH_REDIRECT_BASE: z.string().url().optional(),
    // Payment provider credentials (Phase 10). All optional so the API boots
    // without payments configured; a provider whose creds are unset is simply
    // not registered and its `/v1/payments` routes return `invalid_input`.
    // Secrets, signatures, and keys are never logged.
    STRIPE_SECRET_KEY: z.string().min(1).optional(),
    STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
    // Hosted-checkout redirect targets (optional; the provider has defaults).
    STRIPE_SUCCESS_URL: z.string().url().optional(),
    STRIPE_CANCEL_URL: z.string().url().optional(),
    ALIPAY_APP_ID: z.string().min(1).optional(),
    ALIPAY_PRIVATE_KEY: z.string().min(1).optional(),
    ALIPAY_PUBLIC_KEY: z.string().min(1).optional(),
    ALIPAY_GATEWAY: z.string().url().optional(),
    WECHAT_APP_ID: z.string().min(1).optional(),
    WECHAT_MCH_ID: z.string().min(1).optional(),
    WECHAT_API_V3_KEY: z.string().min(1).optional(),
    WECHAT_PUBLIC_KEY: z.string().min(1).optional(),
    WECHAT_PUBLIC_KEY_ID: z.string().min(1).optional(),
    CRYPTO_WEBHOOK_SECRET: z.string().min(1).optional(),
    // µcredits granted per one currency *minor unit* (e.g. 1 USD cent). Frozen
    // onto each topup intent at creation, so a later change never re-prices an
    // in-flight intent. Carried as a bigint downstream; coerced from the string
    // env here.
    CREDIT_RATE: z.coerce.number().int().positive().default(1000),
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
