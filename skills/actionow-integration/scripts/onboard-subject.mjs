#!/usr/bin/env node
// onboard-subject.mjs — Model-B onboarding: login → create subject → mint ak_ key.
// Zero dependencies (global fetch, Node 18+). Run this ONCE per end-user; persist
// the printed subject_id (and optionally the ak_ key) on your own user row.
//
//   Env:   ACTIONOW_BASE_URL, ACTIONOW_CONSOLE_EMAIL, ACTIONOW_CONSOLE_PASSWORD
//   Usage: node onboard-subject.mjs <yourUserId> [displayName]
//   e.g.   node onboard-subject.mjs user_42 "Ada Lovelace"

const BASE = (process.env.ACTIONOW_BASE_URL ?? '').replace(/\/$/, '');
const EMAIL = process.env.ACTIONOW_CONSOLE_EMAIL;
const PASSWORD = process.env.ACTIONOW_CONSOLE_PASSWORD;
if (!BASE || !EMAIL || !PASSWORD) {
  console.error('set ACTIONOW_BASE_URL, ACTIONOW_CONSOLE_EMAIL, ACTIONOW_CONSOLE_PASSWORD');
  process.exit(2);
}
const [externalId, displayName] = process.argv.slice(2);
if (!externalId) { console.error('usage: node onboard-subject.mjs <yourUserId> [displayName]'); process.exit(2); }

async function post(path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status} ${JSON.stringify(json.error ?? json)}`);
  return json;
}

// 1. control-plane login → USER JWT (keep this server-side only)
//    /auth/login is outside the OpenAPI surface — plain fetch.
const { token } = await post('/auth/login', { email: EMAIL, password: PASSWORD });
console.error('logged in as tenant admin');

// 2. create the subject — external_id = YOUR immutable user id (the reverse-join key)
//    /console/subjects is not typed in the SDK — plain fetch.
const subject = await post('/console/subjects', { externalId, displayName: displayName ?? externalId }, token);
console.error(`subject: ${subject.id} (external_id=${subject.external_id})`);

// 3. mint a subject-scoped ak_ key — plaintext returned ONCE
const key = await post('/console/api-keys', { subjectId: subject.id }, token);
console.error(`api key: ${key.id}`);

// Machine-readable result to stdout — persist these on your user row.
console.log(JSON.stringify({ subject_id: subject.id, external_id: subject.external_id, api_key: key.plaintext }, null, 2));
console.error('\n⚠  store api_key now — it is unrecoverable. Fund the subject before its first billable call (see 04-billing-and-limits.md).');
