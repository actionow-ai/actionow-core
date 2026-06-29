# Actionow — Deployment Runbook

How to self-deploy Actionow and plug in your own LLM / image / video / audio provider keys, then run multiple externally-operated AIGC apps on one instance (each app = one tenant).

## 1. Architecture

Three runnable processes + three backing services:

| Process    | Package       | Role                                                                                                |
| ---------- | ------------- | --------------------------------------------------------------------------------------------------- |
| **API**    | `apps/api`    | NestJS HTTP server — `/v1` data plane, `/admin`, `/console`, `/app`, `/portal`, `/member`, `/auth`. |
| **Worker** | `apps/worker` | BullMQ consumer — async media jobs (image/video/audio), webhook dispatch, settle.                   |
| **Web**    | `apps/web`    | Vite/React SPA — operator console + tenant console + member portal. Static build.                   |

| Service           | Dev (docker-compose)   | Purpose                                                                                         |
| ----------------- | ---------------------- | ----------------------------------------------------------------------------------------------- |
| **PostgreSQL 16** | `localhost:5433`       | System of record (drizzle migrations).                                                          |
| **Redis 7**       | `localhost:6380`       | BullMQ queues, rate-limit + circuit-breaker windows.                                            |
| **S3-compatible** | MinIO `localhost:9100` | Media persistence (`/v1/files`, async media assets). Optional — endpoints fail closed if unset. |

## 2. Prerequisites

- Node ≥ 20, `pnpm` (repo uses pnpm workspaces + turbo).
- PostgreSQL 16, Redis 7, and an S3-compatible bucket (AWS S3, Cloudflare R2, MinIO). For local dev: `pnpm infra:up` (docker compose) brings up all three.

## 3. Environment

Copy `.env.example` → `.env` and fill in. The full contract is `packages/infra/src/config.ts` (`EnvSchema`). Booleans must be the literal strings `"true"`/`"false"`.

### Required (always)

| Var            | Notes                                       |
| -------------- | ------------------------------------------- |
| `DATABASE_URL` | `postgresql://user:pass@host:5432/actionow` |
| `REDIS_URL`    | `redis://host:6379`                         |

### Required in production

| Var                | Notes                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`         | `production`.                                                                                                               |
| `ADMIN_JWT_SECRET` | HMAC secret for admin/operator/member JWTs. **Boot fails in prod if unset.** Outside prod a well-known dev default is used. |

### Strongly recommended in production

| Var                             | Notes                                                                                                                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SECRET_ENCRYPTION_KEY`         | base64-encoded 32-byte (44-char) AES-256-GCM key for secret-at-rest (upstream API keys, proxies). Absence does not crash boot, but stored credentials are then unencrypted. |
| `ALLOW_DEV_TENANT_HEADER`       | Leave unset/`false` (default). When `true` (non-prod only) the `x-tenant-id` header bypasses API-key auth — never enable in prod.                                           |
| `WEBHOOK_ALLOW_PRIVATE_TARGETS` | Leave unset/`false` (default) — blocks SSRF to private/loopback/metadata IPs from tenant webhook callbacks.                                                                 |

### Object storage (optional — needed for `/v1/files` + media relay persistence)

`STORAGE_PROVIDER` (`minio`/`s3`/`r2`), `STORAGE_BUCKET`, `STORAGE_REGION`, `STORAGE_ENDPOINT`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`, `STORAGE_FORCE_PATH_STYLE`, `STORAGE_PUBLIC_BASE_URL` (public CDN base for persisted media, e.g. `https://asset.example.com`), `STORAGE_MAX_UPLOAD_BYTES` (default 100 MiB). If any required field is missing, media persistence no-ops and the file endpoints return `invalid_input`.

### Optional feature gates

| Var                                                         | Default       | Effect                                                                                                                                                                                                                    |
| ----------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CREDIT_RATE`                                               | `10000`       | µUSD granted per currency minor unit (1 USD cent → 10 000 µUSD → $1 = 1 credit = 1e6 µUSD).                                                                                                                               |
| `UPSTREAM_PROXY_URL`                                        | —             | Global egress proxy for upstream provider calls (per-channel `proxy_ref` overrides). Treated as a secret.                                                                                                                 |
| `RELAY_TRACE`                                               | `off`         | `full` stores each upstream call's request/response (incl. streaming bytes) in `relay_trace`, secrets redacted. `RELAY_TRACE_MAX_BYTES` caps body size (default 1 MB).                                                    |
| `RATE_LIMIT_TENANT_PER_MIN` / `RATE_LIMIT_RESOURCE_PER_MIN` | `600` / `120` | Two-level default request caps.                                                                                                                                                                                           |
| `AUTH_RATE_LIMIT_PER_MIN`                                   | —             | Per-IP cap on unauthenticated `/auth/*` + `/admin/auth/login` (fails open).                                                                                                                                               |
| Payments (optional)                                         | —             | `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` (+ success/cancel URLs); Alipay (`ALIPAY_*`); WeChat (`WECHAT_*`); `CRYPTO_WEBHOOK_SECRET`. An unset provider's `/v1/payments` routes return `invalid_input` (never crash). |
| OAuth login (optional)                                      | —             | `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET`, `OAUTH_REDIRECT_BASE`.                                                                                                                                              |
| `ENABLE_OAUTH_CHANNELS`                                     | `false`       | Gate for BYO OAuth-subscription upstream channels (operator's own paid sub). Keep `false` unless intentionally used.                                                                                                      |

### Sessions + refresh-token rotation + JWKS/RS256 (all optional — defaults preserve today's behavior)

Login/register/admin-login responses are **additive**: `{ token, accessToken, refreshToken, expiresIn }` where `token === accessToken` (the `token` field is retained for back-compat). `POST /auth/refresh` rotates the pair (reuse of a rotated refresh revokes the whole session family — theft detection); `POST /auth/logout` revokes it. RS256 asymmetric signing + a published JWKS are **opt-in and OFF by default** — with no JWT\_\* vars set, access tokens stay HS256 (signed with `ADMIN_JWT_SECRET`) at a 12h TTL, exactly as before.

| Var                       | Default | Effect                                                                                                                                                         |
| ------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_SIGNING_ALG`         | `HS256` | `RS256` switches access-token signing to the asymmetric key + publishes a JWKS. Strictly opt-in.                                                               |
| `JWT_PRIVATE_KEY`         | —       | RS256 private key, as PEM **or base64-encoded PEM**. Required when `JWT_SIGNING_ALG=RS256` in production. Never logged or returned.                            |
| `JWT_PUBLIC_KEY`          | —       | RS256 public key (PEM/base64-PEM). Optional — derived from the private key when unset. Published via `/.well-known/jwks.json`.                                 |
| `JWT_KID`                 | —       | Stable `kid` for the published JWK + token header. Defaults to the key's JWK thumbprint (so adding a second key under a new `kid` is non-breaking).            |
| `JWT_ACCESS_TTL`          | `12h`   | Access-token lifetime. Kept at 12h to match existing sessions — do not shorten without planning for re-auth.                                                   |
| `JWT_REFRESH_TTL`         | `30d`   | Refresh-token (session) lifetime.                                                                                                                              |
| `JWT_VERIFY_LEGACY_HS256` | `true`  | Guards accept legacy HS256 tokens even under an RS256 config (so flipping to RS256 does not invalidate live sessions). Set `false` after HS256 tokens age out. |
| `JWT_ISSUER`              | —       | Optional `iss` claim stamped on issued tokens and checked on verify.                                                                                           |

The `/.well-known/jwks.json` endpoint is **unauthenticated and public**; it returns `{ keys: [] }` under HS256 (it never exposes the HMAC secret) and the public JWK array under RS256.

**Safe rollout order** (no big-bang cutover; each step is independently shippable):

1. Ship this release as-is — clients gain `refreshToken` and the `/auth/refresh` + `/auth/logout` endpoints while access tokens stay HS256/12h. Nothing else changes.
2. Later, generate an RSA keypair and set `JWT_SIGNING_ALG=RS256` + `JWT_PRIVATE_KEY` (base64-PEM). New tokens are RS256; `JWT_VERIFY_LEGACY_HS256=true` (default) keeps existing HS256 sessions valid.
3. After all HS256 tokens have expired (≥ `JWT_ACCESS_TTL`), set `JWT_VERIFY_LEGACY_HS256=false` and rotate `ADMIN_JWT_SECRET`.

## 4. Build + migrate

```bash
pnpm install
pnpm build                 # turbo build all packages + apps (13 tasks)
pnpm db:migrate            # apply drizzle migrations 0000→latest to DATABASE_URL
```

`pnpm db:migrate` is idempotent — it records applied migrations in `drizzle.__drizzle_migrations` and re-running is a no-op. (For a fresh DB it applies everything from `0000`.)

## 5. Seed the first admin

```bash
pnpm --filter @actionow/api seed
```

Prints the admin email/password, the first tenant, and a tenant API key (**plaintext shown once**). Override the defaults via the seed's env (`SEED_ADMIN_PASSWORD`, etc. — see `apps/api/src/seed/seed.ts`). Log in to the operator console at the web app with the admin credentials.

## 6. Run

```bash
# API  (built dist)
node --env-file=.env --import tsx apps/api/dist/main.js     # serves API_PORT (default 3000)

# Worker (async media + webhooks)
cd apps/worker && node --import tsx src/main.ts

# Web (static SPA) — build then serve apps/web/dist behind your web server / CDN,
# proxying /v1, /admin, /console, /app, /auth, /portal, /member to the API.
pnpm --filter @actionow/web build
```

Health check: `GET /health` → `{"status":"ok"}`.

**Reverse-proxy note (SSE):** the streaming relay (`/v1/chat/completions` with `stream:true`) and the async-job progress stream (`GET /v1/jobs/:id/stream`) both emit SSE; the API already sets `X-Accel-Buffering: no`, but ensure your proxy (nginx/Cloudflare) does **not** buffer responses for the API origin, or streamed tokens/progress will be held back. For the jobs stream also raise the proxy's read/idle timeout above `JOB_STREAM_HEARTBEAT_MS` (default 15s) — the endpoint sends a `:` keep-alive comment at that cadence and is bounded by `JOB_STREAM_MAX_MS` (default 10 min).

## 7. Plug in your provider keys

Upstream credentials resolve by a channel's `credential_ref` locator (`apps/api/src/common/secret-resolver.ts`):

1. **Env (simplest):** set `SECRET_<LOCATOR>` (uppercase, dashes→underscores). e.g. locator `openai` → env `SECRET_OPENAI=sk-…`. Then in the operator console (**模型接入 → 通道**) create a channel whose `credential_ref` is `openai`.
2. **Encrypted at rest:** with `SECRET_ENCRYPTION_KEY` set, store the key through the admin secret APIs (AES-256-GCM); the channel references it by id.

Wire each modality the same way — text/image/video/audio channels all use the provider-plugin + channel + model hierarchy. Use the connectivity **test-on-add** probe before enabling a channel.

## 8. Multi-app tenancy model

One Actionow instance hosts many externally-operated AIGC apps. Per [the unified tenancy design]:

- **You (operator)** manage everything on `/admin` (system-admin).
- **Each app = a tenant.** Its tenant-admin self-serves on `/console` + `/app`: end-users (subjects), scoped API keys, sub-wallets, tenant-owned quota plans, members (RBAC). Tenant queries are server-forced to the caller's `tenant_id`.
- **Each app's end-users** self-serve read-only on `/portal` + `/member` (balance, usage, keys, limits).

So you deploy once, plug in keys, create a tenant per app, and hand each app's admin a self-service console — without rebuilding accounts/billing/governance per app.

## 9. Production hardening checklist

- [ ] `NODE_ENV=production` + `ADMIN_JWT_SECRET` set (boot enforces it).
- [ ] `SECRET_ENCRYPTION_KEY` set (encrypt upstream credentials at rest).
- [ ] `ALLOW_DEV_TENANT_HEADER` unset/`false`; `WEBHOOK_ALLOW_PRIVATE_TARGETS` unset/`false`.
- [ ] TLS terminated upstream; proxy buffering disabled for SSE.
- [ ] Managed Postgres + Redis with backups; S3 bucket with a public CDN base for media.
- [ ] Rate limits (`RATE_LIMIT_*`, `AUTH_RATE_LIMIT_PER_MIN`) tuned for your traffic.
- [ ] Run the worker process (async media + webhooks won't drain without it).
