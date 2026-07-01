# 01 · Authentication & onboarding

The four credentials, how to get them, and how to onboard your end-users. See the plane table in [SKILL.md](../SKILL.md) for the big picture.

## Credentials at a glance

| Credential              | Looks like          | Sent as                                               | Plane / routes | Who holds it                    |
| ----------------------- | ------------------- | ----------------------------------------------------- | -------------- | ------------------------------- |
| **Data-plane API key**  | `ak_…`              | `Authorization: Bearer ak_…` **or** `x-api-key: ak_…` | `/v1/*`        | Your server, per end-user       |
| **Console USER JWT**    | opaque JWT          | `Authorization: Bearer <jwt>`                         | `/console/*`   | Your server only (tenant-admin) |
| **Admin service token** | `at_…`              | `Authorization: Bearer at_…`                          | `/admin/*`     | Platform operators — not you    |
| **Member JWT**          | JWT (`typ:subject`) | `Authorization: Bearer <jwt>`                         | `/member/*`    | End-user (Model-A only)         |

- The **console JWT is tenant-admin**: it can mint keys and move credits for _any_ subject in your tenant. Keep it server-side; never ship it to a browser.
- An API key is stored server-side only as a **SHA-256 hash** — the plaintext `ak_…` is shown **once** at creation and is unrecoverable. Store it immediately or plan to rotate.

## Getting a console JWT

```sh
curl -sX POST "$ACTIONOW_BASE_URL/auth/login" \
  -H 'content-type: application/json' \
  -d '{"email":"admin@yourapp.example","password":"…"}'
# → { "token":"<jwt>", "accessToken":"<jwt>", "refreshToken":"<rt>", "expiresIn":"12h" }
```

The response is a full token pair: `token` (a back-compat alias for `accessToken`), `refreshToken`, and `expiresIn` — a **duration STRING** like `"12h"` / `"45m"`, **not** a number of seconds. Don't do arithmetic on it; to track expiry, decode the JWT `exp` claim, or just rotate via `POST /auth/refresh` with the `refreshToken` before it expires. Keep the `refreshToken`. `/auth/login` predates the contract-first SDK and is **not** in the OpenAPI surface (call it with plain `fetch`/`curl`); `/auth/refresh` and `/auth/logout` **are** in the spec (`/auth/logout` takes `{ refreshToken }` in the body → `204`).

## Onboarding an end-user (Model-B, recommended)

### Step 1 — create the subject

`POST /console/subjects` — `external_id` = your own immutable user id.

```sh
curl -sX POST "$ACTIONOW_BASE_URL/console/subjects" \
  -H "authorization: Bearer $JWT" -H 'content-type: application/json' \
  -d '{"externalId":"user_42","displayName":"Ada Lovelace"}'
# → { "id":"<uuid>", "external_id":"user_42", "status":"active", … }
```

One of `externalId` / `email` is required; `displayName` and `limitPlanId` are optional. The subject `id` is a **bare UUID** (no `sub_` prefix — only the plaintext secrets `ak_`/`at_`/`rt_` carry prefixes).

> `/console/subjects` is **not** in the generated OpenAPI, so `@actionow/sdk` does not type it — call it with `fetch`. Persist the returned `id` (the `subject_id`) on your user row.

### Step 2 — mint a subject-scoped API key

`POST /console/api-keys` with `{ subjectId }`. The `ak_…` plaintext is returned **once**.

```sh
curl -sX POST "$ACTIONOW_BASE_URL/console/api-keys" \
  -H "authorization: Bearer $JWT" -H 'content-type: application/json' \
  -d '{"subjectId":"<subject-uuid>"}'
# → { "id":"<uuid>", "plaintext":"ak_…" }   ← store ak_… now; unrecoverable (key id is a bare UUID)
```

This route IS typed in the SDK: `consoleClient.POST('/console/api-keys', { body: { subjectId } })`.

Runnable end-to-end: [scripts/onboard-subject.mjs](../scripts/onboard-subject.mjs).

## Tenant-level vs subject-scoped keys

|                    | `subjectId = null` (tenant key)                                        | `subjectId = <uuid>` (subject key)                |
| ------------------ | ---------------------------------------------------------------------- | ------------------------------------------------- |
| Charged wallet     | Tenant pool                                                            | Subject's sub-wallet (falls back to pool if none) |
| Attribution        | Whole tenant                                                           | One end-user                                      |
| Serving many users | Yes — pass `end_user: <externalId>` per call on `/v1/run` to tag usage | N/A — already scoped                              |

**`end_user` is your own user handle (the subject's `external_id`), NOT the subject UUID.** On `/v1/run`, Actionow resolves `end_user` by `external_id` (creating the subject if new) — passing a subject UUID would mis-attribute spend to a bogus new subject. On a **subject-scoped** key, omit `end_user` (already scoped); if you pass one it must be that same subject's `external_id`, else `401`.

**Recommendation:** one subject-scoped key per end-user, so spend, governance limits, and job/file ownership all attribute to that subject automatically.

### Key scoping options (on the mint call)

`POST /console/api-keys` accepts only `{ subjectId?, resourceAllowlist?, rateLimit? }`:

- `resourceAllowlist`: restrict the key to specific resource ids (empty = all). A call to a disallowed `/v1/run/:resourceId` → `401 unauthorized`.
- `rateLimit`: a per-key RPM cap.

Governance plans are **not** bound on the key here — bind them to the **subject** via `POST /console/subjects/:id/limit-plan { planId }` (see [04-billing-and-limits.md](04-billing-and-limits.md)).

## Rotating & revoking keys

- **Rotate (one shot):** `POST /console/api-keys/:id/rotate` → returns a fresh `{ id, plaintext }` and disables the old key. This is typed in the SDK; prefer it over manual mint-then-revoke.
- **Revoke:** `DELETE /console/api-keys/:id`.
- A disabled key → `401 unauthorized`. A disabled subject also disables its keys → `401`.

## Subject lifecycle (offboarding / suspending a user)

- `GET /console/subjects/:id` — fetch one subject.
- `PATCH /console/subjects/:id` — update `displayName` / `status` / `email` / `limitPlanId`. **`external_id` is immutable** and cannot be changed.
- `DELETE /console/subjects/:id` — soft-delete → `{ id, status:"deleted" }`; cascades: sweeps the subject's sub-wallet back to the tenant pool and disables the subject's keys.

## Model-A (Actionow authenticates your users)

Only if you want Actionow to own end-user login:

```
POST /auth/register-member   { email, password, tenantId, … }   → creates a subject + credentials
POST /auth/login-member      { email, password, tenantId }       → member JWT (typ:subject)
```

**`tenantId` is required** on both — omitting it is a hard `400 invalid_input`. (Your app knows which tenant it operates under.)

The member JWT unlocks the **read-only** self-service plane:

| Route                                                   | Returns                             |
| ------------------------------------------------------- | ----------------------------------- |
| `GET /member/me`                                        | identity + status                   |
| `GET /member/usage`                                     | own per-call usage log (paginated)  |
| `GET /member/balance`                                   | own wallet balance + held           |
| `GET /member/api-keys`                                  | own keys (masked)                   |
| `GET /member/limits`                                    | effective limit plan + usage-vs-cap |
| `PATCH /member/me` · `POST /member/me/password`         | update own profile / password       |
| `POST /member/api-keys` · `DELETE /member/api-keys/:id` | self-mint / revoke own key          |

With Model-B you typically don't touch `/member/*` at all.

## Dev-only shortcut

In non-production builds with `ALLOW_DEV_TENANT_HEADER=true`, `/v1/*` accepts an `x-tenant-id` header instead of an API key. **Never rely on this in production** — it is a local convenience only.
