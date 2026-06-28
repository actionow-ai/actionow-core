import { loginConsole } from './client.js';
import { chat, chatStream } from './chat.js';
import { openSubWallet, topupSubWallet } from './fund-user.js';
import { downloadUrl, uploadFile } from './files.js';
import { generateImage, submitImageWithCallback } from './media.js';
import { onboardUser } from './onboard-user.js';

/**
 * End-to-end "thin app backend" walkthrough. Each step is annotated with WHICH
 * PLANE it uses and WHY core (not the app) owns it. This file is a script-shaped
 * narrative — in a real app these steps are spread across your request handlers
 * and run on demand, not top-to-bottom. It typechecks but is not meant to run
 * against a live core without the env below.
 *
 * The federation principle: after onboarding, your app DB stores core's
 * `subjectId` (+ optionally the `apiKey`) on its own user row. Every later call
 * is keyed off those stable core IDs. Core never knows your business data; your
 * app never reimplements relay/credits/storage.
 */
async function main(): Promise<void> {
  const baseUrl = process.env.ACTIONOW_BASE_URL ?? 'https://gateway.example.com';
  const consoleEmail = process.env.ACTIONOW_CONSOLE_EMAIL ?? 'admin@yourapp.example';
  const consolePassword = process.env.ACTIONOW_CONSOLE_PASSWORD ?? 'change-me';

  // (a) Hold a tenant-admin CONTROL-PLANE credential. The app's server logs in
  //     once with the tenant-admin account and reuses the JWT (refresh before
  //     expiry). This high-trust token never leaves the server.
  const cfg = { baseUrl, consoleEmail, consolePassword };
  const consoleClient = await loginConsole(cfg);
  // We also need the raw token for the console routes not yet in the typed SDK.
  const consoleToken = await rawConsoleToken(cfg);

  // (b)+(c) Onboard one of YOUR app users as a core subject (Model-B
  //     external_id = your user id) and mint that subject a data-plane `ak_…` key.
  //     Persist `subjectId` (and the key, or rotate later) on your user row.
  const appUserId = 'user_42'; // <- your app's own primary key for this user
  const { subjectId, apiKey } = await onboardUser(
    baseUrl,
    consoleClient,
    consoleToken,
    appUserId,
    'Ada Lovelace',
  );

  // Give that end-user a metered budget: open a HARD sub-wallet and allocate
  // credits from the tenant pool (conserving — never minted). Skip this to let
  // the user spend against the shared tenant pool instead.
  await openSubWallet(baseUrl, consoleToken, subjectId, 100);
  await topupSubWallet(baseUrl, consoleToken, subjectId, 50);

  // (d) DATA-PLANE chat on the user's key — spend attributes to the subject.
  const reply = await chat(baseUrl, apiKey, 'gpt-4o', [
    { role: 'user', content: 'Say hello in one word.' },
  ]);
  process.stdout.write(`chat reply: ${reply}\n`);

  // Streaming variant — token deltas as they arrive (SSE via the SDK reader).
  for await (const delta of chatStream(baseUrl, apiKey, 'gpt-4o', [
    { role: 'user', content: 'Count to three.' },
  ])) {
    process.stdout.write(delta);
  }

  // (e) Async media job: submit + poll to completion (the SDK does the loop).
  //     `image-relay` is an example resource id; discover yours via /v1/resources.
  const output = await generateImage(baseUrl, apiKey, 'image-relay', 'a red bicycle', subjectId);
  process.stdout.write(`\nimage output: ${JSON.stringify(output)}\n`);

  // Or skip polling entirely: register a callback_url and let core push the
  // signed job-done webhook to your receiver (see webhook-receiver.ts).
  const jobId = await submitImageWithCallback(
    baseUrl,
    apiKey,
    'image-relay',
    'a blue car',
    `${baseUrl.replace(/\/$/, '')}/webhooks/actionow`,
  );
  process.stdout.write(`submitted callback job: ${jobId}\n`);

  // (f) Object storage: upload bytes through the presign flow, get a file_id,
  //     then mint a presigned download URL. file_id is a stable core handle you
  //     can pass as a `file` run input or persist in your app DB.
  const fileId = await uploadFile(
    baseUrl,
    apiKey,
    'note.txt',
    'text/plain',
    new TextEncoder().encode('hello from the app'),
  );
  const { url } = await downloadUrl(baseUrl, apiKey, fileId);
  process.stdout.write(`uploaded ${fileId}, download: ${url}\n`);
}

/** Pull just the raw JWT string (the console fetch routes need the bearer token directly). */
async function rawConsoleToken(cfg: {
  baseUrl: string;
  consoleEmail: string;
  consolePassword: string;
}): Promise<string> {
  const res = await fetch(`${cfg.baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: cfg.consoleEmail, password: cfg.consolePassword }),
  });
  if (!res.ok) throw new Error(`login failed: ${String(res.status)}`);
  const { token } = (await res.json()) as { token: string };
  return token;
}

// Run only when invoked directly (so importing a helper doesn't kick off the flow).
main().catch((err: unknown) => {
  process.stderr.write(`${String(err)}\n`);
  process.exitCode = 1;
});
