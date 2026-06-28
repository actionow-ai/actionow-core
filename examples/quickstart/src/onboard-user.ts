import type { ConsoleClient } from './client.js';

/**
 * Onboarding an end-user onto core is a TWO-STEP control-plane flow your thin
 * backend runs once per user (then stores the returned core IDs in YOUR app DB —
 * see the federation principle in docs/INTEGRATION.md).
 *
 *   1. Register the user as a core `subject` (Model-B: `external_id` = YOUR app's
 *      own user id). The subject is core's stable billing-attribution identity for
 *      that end-user. `external_id` is immutable, so it is the perfect join key.
 *   2. Mint a subject-scoped `ak_…` API key. All `/v1` traffic on that key is
 *      attributed to the subject — its spend, its governance limits, its jobs/files.
 *
 * Division of responsibility: YOUR app owns the user's profile, auth, and business
 * data. CORE owns the subject id, the wallet/limits, and the AI-relay plumbing.
 * You reference core only by the IDs it returns.
 */

/** The core `subject` view (`/console/subjects` is not yet in the OpenAPI, so typed by hand here). */
export interface SubjectView {
  id: string;
  tenant_id: string;
  external_id: string | null;
  email: string | null;
  display_name: string | null;
  limit_plan_id: string | null;
  status: string;
  created_at: string;
}

/** What onboarding returns: the two core IDs your app DB should persist against its user row. */
export interface OnboardResult {
  /** Core's stable subject id — store it on your user row to join future calls. */
  subjectId: string;
  /** A freshly minted `ak_…` data-plane key for this user (returned ONCE — store it, you cannot re-read it). */
  apiKey: string;
  /** The id of the api-key row (for later rotate/disable via `/console/api-keys/:id`). */
  apiKeyId: string;
}

/**
 * Register an app user as a core subject (idempotent on `external_id`? — NO:
 * creating a subject with an existing `external_id` 409s, so call this once and
 * persist `subjectId`; on a duplicate, look the subject up via `GET /console/subjects`).
 *
 * `/console/subjects` is not yet in the generated OpenAPI spec, so this uses the
 * console client's underlying fetch with an explicit body — the auth header is
 * still supplied by the typed client's configuration.
 */
export async function registerSubject(
  baseUrl: string,
  consoleToken: string,
  appUserId: string,
  displayName: string,
): Promise<SubjectView> {
  const res = await fetch(`${baseUrl}/console/subjects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${consoleToken}` },
    // Model-B: external_id IS your app's own user id. One of externalId/email is required.
    body: JSON.stringify({ externalId: appUserId, displayName }),
  });
  if (!res.ok) {
    throw new Error(`registerSubject failed: ${String(res.status)} ${await res.text()}`);
  }
  return (await res.json()) as SubjectView;
}

/**
 * Mint a subject-scoped data-plane API key. This route IS in the OpenAPI, so it
 * goes through the typed client: pass `subjectId` to bind the key to the subject
 * (omit it for a tenant-wide key). The `plaintext` `ak_…` is returned exactly ONCE
 * — persist it now (or store nothing and rotate when you need a fresh one).
 */
export async function mintSubjectKey(
  consoleClient: ConsoleClient,
  subjectId: string,
): Promise<{ apiKeyId: string; apiKey: string }> {
  const { data, error, response } = await consoleClient.POST('/console/api-keys', {
    body: { subjectId },
  });
  if (error !== undefined) {
    throw new Error(`mintSubjectKey failed: ${String(response.status)} ${JSON.stringify(error)}`);
  }
  return { apiKeyId: data.id, apiKey: data.plaintext };
}

/** Run the full onboarding flow and return the core IDs to persist in your app DB. */
export async function onboardUser(
  baseUrl: string,
  consoleClient: ConsoleClient,
  consoleToken: string,
  appUserId: string,
  displayName: string,
): Promise<OnboardResult> {
  const subject = await registerSubject(baseUrl, consoleToken, appUserId, displayName);
  const key = await mintSubjectKey(consoleClient, subject.id);
  return { subjectId: subject.id, apiKey: key.apiKey, apiKeyId: key.apiKeyId };
}
