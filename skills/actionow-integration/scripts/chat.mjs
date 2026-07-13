#!/usr/bin/env node
// chat.mjs — call POST /v1/chat/completions, blocking or streaming.
// Zero dependencies: uses the global `fetch` (Node 18+), no @actionow/sdk needed.
//
//   Env:   ACTIONOW_BASE_URL, ACTIONOW_API_KEY
//   Usage: node chat.mjs [--stream] [--model gpt-4o] "your prompt"
//   e.g.   node chat.mjs --stream --model gpt-4o "write a haiku about credits"

const BASE = (process.env.ACTIONOW_BASE_URL ?? '').replace(/\/$/, '');
const KEY = process.env.ACTIONOW_API_KEY;
if (!BASE || !KEY) {
  console.error('set ACTIONOW_BASE_URL and ACTIONOW_API_KEY');
  process.exit(2);
}

const args = process.argv.slice(2);
const stream = args.includes('--stream');
const mi = args.indexOf('--model');
const model = mi >= 0 ? args[mi + 1] : 'gpt-4o';
const prompt = args.filter((a, i) => a !== '--stream' && a !== '--model' && i !== mi + 1).join(' ') || 'Say hello in one sentence.';

const res = await fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream }),
});

// The credit hold runs BEFORE the first SSE byte, so a pre-commit failure
// (insufficient_credits / invalid_input / unauthorized / rate_limited) is a real
// non-2xx here — check status before consuming the stream.
if (!res.ok) {
  const body = await res.json().catch(() => ({}));
  console.error(`HTTP ${res.status}`, JSON.stringify(body.error ?? body));
  process.exit(1);
}

if (!stream) {
  const json = await res.json();
  process.stdout.write((json.choices?.[0]?.message?.content ?? '') + '\n');
  if (json.usage) console.error('usage:', JSON.stringify(json.usage));
  process.exit(0);
}

// --- streaming: parse SSE frames, print each delta, stop on [DONE] ---
// Contract: a clean stream ends with `data: [DONE]`. A post-commit failure is a
// terminal `data: {"error":{…}}` frame and the stream ends WITHOUT [DONE] —
// treat any missing [DONE] as an abnormal end, not a complete response.
const decoder = new TextDecoder();
let buffer = '';
for await (const chunk of res.body) {
  buffer += decoder.decode(chunk, { stream: true });
  let idx;
  // SSE frames are separated by a blank line; each frame may have several lines.
  while ((idx = buffer.indexOf('\n\n')) !== -1) {
    const frame = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue;      // ignore `event:` / comments
      const data = line.slice(5).trim();
      if (data === '[DONE]') { process.stdout.write('\n'); process.exit(0); }
      try {
        const obj = JSON.parse(data);
        if (obj.error) {
          console.error(`\nstream failed: ${obj.error.code ?? obj.error.type ?? '?'}: ${obj.error.message ?? ''}`);
          process.exit(1);
        }
        process.stdout.write(obj.choices?.[0]?.delta?.content ?? '');
      } catch { /* keep-alive / non-JSON frame */ }
    }
  }
}
// The iterator drained without [DONE] — abnormal end.
console.error('\nstream ended without data: [DONE] — treat as failed');
process.exit(1);
