#!/usr/bin/env node
// run-and-poll.mjs — submit POST /v1/run/:resourceId (async-poll) and poll the job.
// Zero dependencies (global fetch, Node 18+). Mirrors what @actionow/sdk's
// submitAndWait() does, so you can see the raw contract.
//
//   Env:   ACTIONOW_BASE_URL, ACTIONOW_API_KEY
//   Usage: node run-and-poll.mjs <resourceId> '<inputs-json>' [endUser]
//   e.g.   node run-and-poll.mjs image-relay '{"prompt":"a red bicycle"}' user_42
//   NOTE: endUser is YOUR own user handle (the subject's external_id), NOT a
//   subject UUID — Actionow resolves/creates the subject by it. Omit it on a
//   subject-scoped key (already attributed).

const BASE = (process.env.ACTIONOW_BASE_URL ?? '').replace(/\/$/, '');
const KEY = process.env.ACTIONOW_API_KEY;
if (!BASE || !KEY) {
  console.error('set ACTIONOW_BASE_URL and ACTIONOW_API_KEY');
  process.exit(2);
}

const [resourceId, inputsJson, endUser] = process.argv.slice(2);
if (!resourceId) {
  console.error("usage: node run-and-poll.mjs <resourceId> '<inputs-json>' [endUser]");
  process.exit(2);
}

const headers = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };
const inputs = inputsJson ? JSON.parse(inputsJson) : {};
const POLL_MS = 1500;
const TIMEOUT_MS = 180_000;

// 1. submit — exec_mode async-poll → 202 { job_id, status:"queued" } (or 200 succeeded if the resource is sync)
const submit = await fetch(`${BASE}/v1/run/${encodeURIComponent(resourceId)}`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    inputs,
    exec_mode: 'async-poll',
    ...(endUser ? { end_user: endUser } : {}),
  }),
});
const submitBody = await submit.json().catch(() => ({}));
if (!submit.ok) {
  console.error(`submit HTTP ${submit.status}`, JSON.stringify(submitBody.error ?? submitBody));
  process.exit(1);
}

const jobId = submitBody.job_id;
console.error(`submitted → job ${jobId} (${submitBody.status})`);
if (submitBody.status === 'succeeded') {
  console.log(JSON.stringify(submitBody.output, null, 2));
  process.exit(0);
}

// 2. poll GET /v1/jobs/:id until terminal
const deadline = Date.now() + TIMEOUT_MS;
for (;;) {
  if (Date.now() > deadline) {
    console.error(`timeout after ${TIMEOUT_MS}ms; job ${jobId} still running`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
  const res = await fetch(`${BASE}/v1/jobs/${jobId}`, { headers });
  const job = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`poll HTTP ${res.status}`, JSON.stringify(job.error ?? job));
    process.exit(1);
  }
  process.stderr.write(`  status: ${job.status}\r`);
  if (job.status === 'succeeded') {
    console.error(`\nsucceeded · cost ${job.cost?.credits ?? '0'} µcredit`);
    // media output = { kind:"media", assets:[{ role, modality, url, mime, … }] } with directly-fetchable
    // urls (or legacy flat { image_url|video_url|audio_url }); outputs never contain file_ids.
    console.log(JSON.stringify(job.output, null, 2));
    process.exit(0);
  }
  if (job.status === 'failed' || job.status === 'canceled') {
    console.error(`\njob ${job.status}:`, JSON.stringify(job.error));
    process.exit(1);
  }
}
