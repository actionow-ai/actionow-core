#!/usr/bin/env node
// run-and-poll.mjs — task submit-and-wait over the NEW task paradigm:
// POST /v1/tasks (model addressing) → digest the 200/202 dual shape → poll
// GET /v1/tasks/:id to a terminal status. Zero dependencies (global fetch,
// Node 18+). Mirrors what @actionow/sdk's submitTaskAndWait() does, so you can
// see the raw contract.
//
//   Env:   ACTIONOW_BASE_URL, ACTIONOW_API_KEY
//   Usage: node run-and-poll.mjs <type> <model> '<params-json>'
//   e.g.   node run-and-poll.mjs video.generation seedance-pro '{"prompt":"a red bicycle"}'
//   e.g.   node run-and-poll.mjs images.generation gpt-image-1 '{"prompt":"a red bicycle"}'
//
//   <type> is the operation (video.generation | music.generation | images.generation | tts | …
//   — discover a model's operations via GET /v1/gateway/models). <params-json>
//   keys are canonical params of the model's contract; an unsupported param is
//   a 400 unsupported_parameter (nothing is silently dropped).
//
//   NOTE: the old `node run-and-poll.mjs <resourceId> …` form targeted the
//   DEPRECATED POST /v1/run/:resourceId face — that face is scheduled for
//   removal; this script now speaks the replacement API.

const BASE = (process.env.ACTIONOW_BASE_URL ?? '').replace(/\/$/, '');
const KEY = process.env.ACTIONOW_API_KEY;
if (!BASE || !KEY) {
  console.error('set ACTIONOW_BASE_URL and ACTIONOW_API_KEY');
  process.exit(2);
}

const [type, model, paramsJson] = process.argv.slice(2);
if (!type || !model) {
  console.error("usage: node run-and-poll.mjs <type> <model> '<params-json>'");
  process.exit(2);
}

const headers = {
  authorization: `Bearer ${KEY}`,
  'content-type': 'application/json',
  // Same key + same body replays the recorded task (no double-charge);
  // same key + different body → 409 conflict.
  'idempotency-key': crypto.randomUUID(),
};
const params = paramsJson ? JSON.parse(paramsJson) : {};
const POLL_MS = 2000;
const TIMEOUT_MS = 600_000; // media tasks run long

// 1. submit — the SERVER decides the shape: 200 sync result | 202 + Task.
const submit = await fetch(`${BASE}/v1/tasks`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ type, model, ...params }),
});
const body = await submit.json().catch(() => ({}));
if (!submit.ok && submit.status !== 202) {
  console.error(`submit HTTP ${submit.status}`, JSON.stringify(body.error ?? body));
  process.exit(1);
}

// Discriminate on the BODY shape (object === 'task'), not the status alone —
// an idempotent replay of an already-terminal task answers 200 with a Task body.
if (body.object !== 'task') {
  console.error('sync result (fast model answered 200 inline)');
  console.log(JSON.stringify(body.output ?? body, null, 2));
  process.exit(0);
}

console.error(`submitted → task ${body.id} (${body.status})`);
const TERMINAL = ['succeeded', 'failed', 'canceled', 'expired'];

// 2. poll GET /v1/tasks/:id until terminal.
let task = body;
const deadline = Date.now() + TIMEOUT_MS;
while (!TERMINAL.includes(task.status)) {
  if (Date.now() > deadline) {
    console.error(`timeout after ${TIMEOUT_MS}ms; task ${task.id} still ${task.status}`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
  const res = await fetch(`${BASE}/v1/tasks/${task.id}`, { headers });
  task = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`poll HTTP ${res.status}`, JSON.stringify(task.error ?? task));
    process.exit(1);
  }
  process.stderr.write(`  status: ${task.status}${task.progress != null ? ` (${task.progress}%)` : ''}\r`);
}

if (task.status === 'succeeded') {
  const metrics = task.usage?.metrics ? JSON.stringify(task.usage.metrics) : 'n/a';
  console.error(`\nsucceeded · usage ${metrics}${task.usage?.estimated ? ' (estimated)' : ''}`);
  // media output carries artifact URLs; signed-track URLs expire at task.expires_at.
  console.log(JSON.stringify(task.output, null, 2));
  process.exit(0);
}
console.error(`\ntask ${task.status}:`, JSON.stringify(task.error));
process.exit(1);
