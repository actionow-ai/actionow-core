#!/usr/bin/env node
// onboard-and-call.mjs — scenario 2 (capability base) end to end:
// login → create subject (Model-B) → mint ak_ → (optional redeem topup) → chat.
// Zero deps (global fetch, Node 18+).
//   Env:   ACTIONOW_BASE_URL, ACTIONOW_CONSOLE_EMAIL, ACTIONOW_CONSOLE_PASSWORD
//          ACTIONOW_MODEL (optional, default gpt-4o)
//   Usage: node onboard-and-call.mjs <yourUserId> [redeemCode]
//   e.g.   node onboard-and-call.mjs user_42 GIFT-XXXX
//
// NOTE: the console creds MUST be a TENANT ADMIN — create-subject, mint-key, and
// redeem all require tenant_role=admin (else HTTP 403). A self-registered console
// user is admin by default; an invited sub-user (/console/users) is a member.

const BASE = (process.env.ACTIONOW_BASE_URL ?? '').replace(/\/$/, '');
const EMAIL = process.env.ACTIONOW_CONSOLE_EMAIL;
const PASSWORD = process.env.ACTIONOW_CONSOLE_PASSWORD;
if (!BASE || !EMAIL || !PASSWORD) {
  console.error('set ACTIONOW_BASE_URL, ACTIONOW_CONSOLE_EMAIL, ACTIONOW_CONSOLE_PASSWORD');
  process.exit(2);
}
const [externalId, redeemCode] = process.argv.slice(2);
if (!externalId) { console.error('usage: node onboard-and-call.mjs <yourUserId> [redeemCode]'); process.exit(2); }

async function jpost(path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status} ${JSON.stringify(json.error ?? json)}`);
  return json;
}

// 1. control-plane login → USER JWT (full token pair; token === accessToken alias)
const { token } = await jpost('/auth/login', { email: EMAIL, password: PASSWORD });

// 2. Model-B subject: externalId = YOUR immutable user id (the reverse-join key).
//    /console/subjects is not in the OpenAPI surface → plain fetch.
const subject = await jpost('/console/subjects', { externalId, displayName: externalId }, token);

// 3. mint a subject-scoped ak_ (plaintext returned ONCE — persist it on your user row)
const key = await jpost('/console/api-keys', { subjectId: subject.id }, token);
console.error(`subject ${subject.id} · key minted`);

// 4. optional: top up the tenant pool with a redemption code (卡密).
//    → { credited, balance } — both µcredit DECIMAL STRINGS (parse with BigInt, never float).
if (redeemCode) {
  const r = await jpost('/console/redeem', { code: redeemCode }, token);
  console.error(`redeemed → pool balance ${r.balance} µcredit`);
}

// 5. call /v1 as that end-user with THEIR ak_ (spend attributes to the subject)
const chat = await fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${key.plaintext}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    model: process.env.ACTIONOW_MODEL ?? 'gpt-4o',
    messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
  }),
});
const cj = await chat.json().catch(() => ({}));
if (!chat.ok) throw new Error(`chat → HTTP ${chat.status} ${JSON.stringify(cj.error ?? cj)}`);

// Machine-readable result — persist subject_id + api_key on your user row (encrypted).
console.log(JSON.stringify({
  subject_id: subject.id,
  api_key: key.plaintext,
  reply: cj.choices?.[0]?.message?.content,
  usage: cj.usage,
}, null, 2));
