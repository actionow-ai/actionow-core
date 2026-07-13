import type { StorageProviderConfig } from '@actionow/contracts';
import { STORAGE_PROVIDERS } from '@actionow/contracts';
import { z } from 'zod';

/** A weak, well-known secret used ONLY outside production for local dev/tests. */
const DEV_ADMIN_JWT_SECRET = 'dev-admin-jwt-secret-do-not-use-in-prod';

/** Default ceiling on a presigned upload's declared size: 100 MiB. */
const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * Default port for the worker's HTTP liveness server when `WORKER_HEALTH_PORT`
 * is unset. Applied at the worker bootstrap (not as a zod `.default`, to keep
 * the inferred `AppEnv` field optional).
 */
export const WORKER_HEALTH_PORT_DEFAULT = 3001;

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    API_PORT: z.coerce.number().int().positive().default(3000),
    // Port the headless worker's minimal HTTP liveness server binds (GET
    // /health → 200 once the BullMQ workers are running). Optional and left
    // un-defaulted here so adding it does not turn the inferred `AppEnv` field
    // required (which would force every explicit env literal to set it); the
    // worker bootstrap applies the `WORKER_HEALTH_PORT_DEFAULT` fallback.
    WORKER_HEALTH_PORT: z.coerce.number().int().positive().optional(),
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
    // AES-256-GCM key for secret-at-rest encryption (Track F0). Optional — the
    // enc path uses it; absence does NOT crash boot (unencrypted refs still work).
    // Must be a base64-encoded 32-byte key (44 chars). Never logged or returned.
    SECRET_ENCRYPTION_KEY: z.string().optional(),
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
    // Max accepted audio upload for the STT relay (`POST /v1/audio/transcriptions`),
    // in bytes. Enforced by the controller's multer `limits.fileSize`; an oversize
    // upload is rejected with `invalid_input` (400). Optional — left un-defaulted so
    // adding it does not turn the inferred `AppEnv` field required (the controller
    // applies the 25 MiB default via `?? …`, matching OpenAI's Whisper limit).
    STT_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().optional(),
    // Conservative bytes-per-second divisor used to ESTIMATE an audio file's
    // duration from its size, sizing the STT credit hold. Deliberately LOW (~4000)
    // so a typical 128 kbps file (≈16 KB/s) OVER-holds rather than under-holds —
    // the settle then re-prices on the upstream's ACTUAL duration (capped at the
    // hold, refunding the rest). Optional; the relay applies the 4000 default.
    STT_HOLD_BYTES_PER_SECOND: z.coerce.number().int().positive().optional(),
    // Optional per-tenant TOTAL object-storage cap (bytes); unset → no cap. A
    // per-tenant override lives in `account.config.storage_quota_bytes`. Enforced
    // at presign-upload against current usage (Σ live `file_object.size`).
    STORAGE_TENANT_QUOTA_BYTES: z.coerce.number().int().positive().optional(),
    // Public custom-domain base for persisted media (e.g. https://asset.actionow.ai).
    // Optional: when unset (or storage unconfigured) the settle paths skip media
    // persistence and the job settles with the temp upstream URL.
    STORAGE_PUBLIC_BASE_URL: z.string().url().optional(),
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
    // Opt-in gate for the BYO OAuth-subscription channels (Phase 1a codex-oauth).
    // Default falsy: the operator-facing `POST /admin/oauth-sessions` acquisition
    // endpoint is disabled unless this is explicitly set to `'true'` (operator
    // uses THEIR OWN paid subscription, ToS-acknowledged). Env always arrives as a
    // string, so an enum-transform is used (NOT `z.coerce.boolean`, whose JS
    // truthiness would turn `'false'`/`'0'`/`'off'` into `true`).
    ENABLE_OAUTH_CHANNELS: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
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
    // µUSD granted per one currency *minor unit* (e.g. 1 USD cent). Under the
    // µUSD doctrine (1 credit = $1 = 1_000_000 µUSD) a USD payment must yield
    // 1e6 µUSD per dollar, i.e. 10_000 µUSD per cent — so the default is 10_000
    // (`$1 = 100 cents × 10_000 = 1_000_000 µUSD`). Frozen onto each topup intent
    // at creation, so a later change never re-prices an in-flight intent.
    // Carried as a bigint downstream; coerced from the string env here.
    CREDIT_RATE: z.coerce.number().int().positive().default(10000),
    // Global egress-proxy URL applied to upstream provider calls when a channel
    // carries no per-channel `proxy_ref`. Optional. May embed credentials, so it
    // is treated as a secret: never logged and never returned to clients.
    UPSTREAM_PROXY_URL: z.string().url().optional(),
    // Upstream request/response AUDIT TRACE gate. Default `off`. When `full`, the
    // engine wraps `ctx.http` in a TracingHttpClient that stores each upstream
    // call's FULL request+response bodies (INCLUDING raw streaming SSE bytes) in
    // the `relay_trace` table. Secrets in headers are redacted (`[redacted]`) and
    // never stored; secret-looking url query params are redacted; large bodies
    // are truncated at `RELAY_TRACE_MAX_BYTES` with a `truncated` flag.
    RELAY_TRACE: z.enum(['off', 'full']).default('off'),
    // Byte cap per captured body (request and response each). A body over this is
    // sliced to the cap and the row's `truncated` flag is set — a safety valve so
    // a pathological payload can't bloat a `relay_trace` row unbounded.
    RELAY_TRACE_MAX_BYTES: z.coerce.number().int().positive().default(1_000_000),
    // Retention for the unbounded debug `relay_trace` table: the worker's
    // relay-trace-reaper sweep hard-deletes rows older than this many days. Unset
    // → NO pruning (today's behavior). relay_trace is NOT system-of-record, so a
    // short window (e.g. 7–30) keeps full request/response bodies from filling PG.
    RELAY_TRACE_RETENTION_DAYS: z.coerce.number().int().positive().optional(),
    // Retention for the task center's `task_events` stream (批次4, design §7.1/
    // §9.3: same policy shape as relay_trace but NOT forever-by-default). The
    // worker's sweep hard-deletes events older than this many days. Optional
    // env; when unset a CODE default applies (see settings.ts
    // DEFAULT_TASK_EVENTS_RETENTION_DAYS) — an admin override (动态配置) can
    // still change it at runtime.
    TASK_EVENTS_RETENTION_DAYS: z.coerce.number().int().positive().optional(),
    // §9.4 signed-track artifact retention platform default (批次4 slice5): a
    // task's artifact_expires_at = settle time + this many days when neither
    // the model's artifact.retention_days nor an admin override supplies one.
    // Optional env; unset → the CODE default (settings.ts
    // DEFAULT_ARTIFACT_RETENTION_DAYS, 30). Dynamic-config overridable.
    ARTIFACT_RETENTION_DAYS: z.coerce.number().int().positive().optional(),
    // §9.2 对账 (批次4 slice6): the deviation percentage threshold the
    // official-channel daily auto-reconciliation alerts on (cost side computed
    // from usage vs the upstream bill line). Optional env; unset → the CODE
    // default (settings.ts DEFAULT_RECONCILIATION_DEVIATION_PCT, 5). Dynamic-
    // config overridable — the monthly report endpoint ships in 批次4; the
    // automated daily comparer consumes this key in 批次5 (对账自动化).
    RECONCILIATION_DEVIATION_PCT: z.coerce.number().positive().optional(),
    // R5 探测预算 (批次5 slice1 golden probe): the daily USD budget for
    // PLATFORM-FUNDED golden probes (real-upstream small-sample tests; BYOK
    // channels probe on the tenant's own key and are NOT counted) and the
    // per-offering minimum interval between probes. Optional env; unset → the
    // CODE defaults (settings.ts: 5 USD / 60 s). Dynamic-config overridable.
    PROBE_DAILY_BUDGET_USD: z.coerce.number().positive().optional(),
    PROBE_MIN_INTERVAL_SEC: z.coerce.number().int().nonnegative().optional(),
    // 切换预案② (plan v3): the PLATFORM default for the per-tenant gateway-v2
    // gray-release flag — whether a tenant's LEGACY sync surfaces (chat/
    // embeddings…) route through the NEW supply gateway. Per-tenant override
    // rides `tenant.config.gateway_v2` (see @actionow/db
    // getTenantGatewayV2Flag). Default false: the new task-paradigm endpoints
    // are fully live for everyone (预案①), but the legacy-surface cutover is
    // opt-in per tenant during the migration window. Enum-transform (the
    // WEBHOOK_ALLOW_PRIVATE_TARGETS pattern — z.coerce.boolean is a truthiness
    // trap).
    GATEWAY_V2_DEFAULT: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    // Opt-in platform-wide default for the per-tenant file lifecycle / TTL sweep:
    // the worker's file-lifecycle-reaper soft-deletes (+ best-effort bucket-deletes)
    // file_object rows older than this many days for any tenant WITHOUT its own
    // account.config.file_ttl_days override. Unset → NO platform-wide auto-delete
    // (files retained forever unless a tenant opts in). Apps own their data and hold
    // file_ids as references, so this MUST stay unset by default. Mirrors
    // RELAY_TRACE_RETENTION_DAYS' shape (a strictly-positive day count).
    FILE_RETENTION_DAYS: z.coerce.number().int().positive().optional(),
    // SSRF opt-in for webhook `callback_url` delivery. Default falsy: a tenant-
    // supplied callback can NEVER reach a private/loopback/link-local/reserved
    // address (notably the cloud metadata IP 169.254.169.254) — the dispatcher
    // dead-letters such a target. Set `'true'` ONLY for self-hosted/dev setups
    // that deliver to a private/loopback callback. Enum-transform (not
    // `z.coerce.boolean`, whose JS truthiness turns `'false'` into `true`).
    WEBHOOK_ALLOW_PRIVATE_TARGETS: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    // Per-IP attempts/min allowed on the UNAUTHENTICATED auth endpoints
    // (/auth/login, /auth/register, /admin/auth/login) to blunt credential
    // stuffing. The throttle is best-effort and FAILS OPEN if the limiter is
    // slow/unreachable (a limiter outage must not lock everyone out of login).
    // Optional; absent → a built-in default (see LoginThrottleGuard).
    AUTH_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().optional(),
    // Tuning for the job-progress SSE endpoint (`GET /v1/jobs/:id/stream`). All
    // optional — the JobStreamService applies safe CODE defaults so zero-config
    // works. JOB_STREAM_HEARTBEAT_MS: keep-alive comment cadence (default 15000).
    // JOB_STREAM_POLL_MS: DB-poll backstop cadence that GUARANTEES terminal
    // delivery even if pub/sub drops (default 2500). JOB_STREAM_MAX_MS: hard cap
    // on a single stream's lifetime, bounding stuck/auth-revoked connections
    // since the api-key guard only runs at connect (default 600000).
    JOB_STREAM_HEARTBEAT_MS: z.coerce.number().int().positive().optional(),
    JOB_STREAM_POLL_MS: z.coerce.number().int().positive().optional(),
    JOB_STREAM_MAX_MS: z.coerce.number().int().positive().optional(),

    // --- platform sessions + refresh-token rotation + opt-in JWKS/RS256 -------
    // All keys are left optional (un-defaulted) — like WORKER_HEALTH_PORT above —
    // so adding them does NOT turn the inferred `AppEnv` field required (which would
    // force every explicit env literal in tests to set them). The consumers apply
    // the documented defaults via `?? …`, so the EFFECTIVE defaults are still
    // HS256 / 12h / 30d / legacy-accept-on; RS256/JWKS stays strictly opt-in.
    //
    // The signing algorithm for ACCESS tokens. Effective default `HS256` (today's
    // behavior: signed with ADMIN_JWT_SECRET). Set `RS256` to sign with an
    // asymmetric private key + publish a JWKS — strictly opt-in, OFF by default.
    JWT_SIGNING_ALG: z.enum(['HS256', 'RS256']).optional(),
    // RS256 PRIVATE key (PEM or base64-encoded PEM). Required only when
    // JWT_SIGNING_ALG=RS256 in production (see superRefine). NEVER logged/returned.
    JWT_PRIVATE_KEY: z.string().min(1).optional(),
    // RS256 PUBLIC key (PEM or base64-PEM). Optional even under RS256 — when
    // absent it is DERIVED from the private key. Published via /.well-known/jwks.json.
    JWT_PUBLIC_KEY: z.string().min(1).optional(),
    // Stable `kid` for the published JWK + signed token header. Optional; when
    // unset under RS256 a JWK thumbprint is used so rotation stays non-breaking.
    JWT_KID: z.string().min(1).optional(),
    // Access-token TTL. Effective default `12h` (the current value) — do NOT shorten.
    JWT_ACCESS_TTL: z.string().min(1).optional(),
    // Refresh-token TTL (the session's hard expiry). Effective default 30 days.
    JWT_REFRESH_TTL: z.string().min(1).optional(),
    // When unset/`true` (effective default), guards also accept legacy HS256 tokens
    // even under an RS256 config — so flipping to RS256 does not invalidate live
    // sessions. Set `false` (after HS256 tokens age out) to drop legacy acceptance.
    JWT_VERIFY_LEGACY_HS256: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    // Optional `iss` claim stamped on issued access tokens + checked on verify.
    JWT_ISSUER: z.string().min(1).optional(),
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
    // RS256 needs a private key to sign with. Enforced only in production so dev
    // can flip JWT_SIGNING_ALG=RS256 for a quick local test without keys (the
    // token-issuer fails closed at mint time if it truly can't sign).
    if (
      env.JWT_SIGNING_ALG === 'RS256' &&
      env.NODE_ENV === 'production' &&
      env.JWT_PRIVATE_KEY === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_PRIVATE_KEY'],
        message: 'JWT_PRIVATE_KEY is required when JWT_SIGNING_ALG=RS256 in production',
      });
    }
  });

export type AppEnv = z.infer<typeof EnvSchema> & { ADMIN_JWT_SECRET: string };

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const env = EnvSchema.parse(source);
  // The superRefine guarantees ADMIN_JWT_SECRET is set; narrow the type.
  return env as AppEnv;
}

/**
 * Assemble a {@link StorageProviderConfig} from `STORAGE_*` env, or `null` when
 * any required field is missing (so apps still boot without storage configured;
 * the storage-dependent paths then no-op / fail closed). The optional
 * `endpoint`/`forcePathStyle` are only included when set so the S3 SDK derives
 * AWS defaults otherwise. Reads env only (boundary-safe, infra→contracts), so it
 * is shared by the api FilesModule and the worker runtime. Credentials are never
 * logged here — callers log only whether storage was configured.
 */
export function storageConfigFromEnv(env: AppEnv): StorageProviderConfig | null {
  const { STORAGE_PROVIDER, STORAGE_BUCKET, STORAGE_REGION } = env;
  const { STORAGE_ACCESS_KEY_ID, STORAGE_SECRET_ACCESS_KEY } = env;
  if (
    STORAGE_PROVIDER === undefined ||
    STORAGE_BUCKET === undefined ||
    STORAGE_REGION === undefined ||
    STORAGE_ACCESS_KEY_ID === undefined ||
    STORAGE_SECRET_ACCESS_KEY === undefined
  ) {
    return null;
  }
  const cfg: StorageProviderConfig = {
    kind: STORAGE_PROVIDER,
    bucket: STORAGE_BUCKET,
    region: STORAGE_REGION,
    accessKeyId: STORAGE_ACCESS_KEY_ID,
    secretAccessKey: STORAGE_SECRET_ACCESS_KEY,
  };
  if (env.STORAGE_ENDPOINT !== undefined) cfg.endpoint = env.STORAGE_ENDPOINT;
  if (env.STORAGE_FORCE_PATH_STYLE !== undefined) cfg.forcePathStyle = env.STORAGE_FORCE_PATH_STYLE;
  return cfg;
}
