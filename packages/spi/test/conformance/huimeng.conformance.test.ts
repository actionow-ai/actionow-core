// model-supply-greenfield 批次2 wave2 — 惠梦 (HuiMeng) clears the seven-gate
// conformance suite as a DSL pack (判据 2.4: openai/anthropic/gemini/火山/惠梦 5
// 方言全部过门). The dialects/huimeng.dialect.yaml pack compiles to a dialect and
// runs through `describeConformance`, expanding into real vitest cases — all
// green ⇒ the huimeng dialect clears the gate with ZERO adapter code.
//
// 惠梦 offers ONE task operation (images.generation, submit_poll +
// submit_callback). The DSL's parseQueryResponse/parseCallback resolve the task
// op WITHOUT an operation hint, so a single task op is mandatory (two would
// throw and fail gate ⑤). Gate ④ (streaming) legally SKIPS — a media task is
// not a stream capability, so no stream case is offered.
//
// The seven gates do NOT drive the inbound callback (gate ⑤ only polls). The
// HMAC callback门 (验签通过 / 坏签 / 过窗三态) is covered by bespoke `it()` cases
// below that drive the pipeline's `handleCallback` directly (研究判据: 回调用例
// 喂验签通过/失败/重放过窗三态; 回调密钥经 ctx.config.callbackSecret).
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { CredentialSecret } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

// The conformance suite pulls in vitest; import it from the dedicated module so
// it never rides the production barrel (@actionow/spi/conformance subpath).
import type { ConformanceSubject } from '../../src/conformance.js';
import { describeConformance, runConformanceSuite } from '../../src/conformance.js';
import type { DialectContext, RawCallback } from '../../src/index.js';
import { compileDialect, handleCallback, loadDialectPack } from '../../src/index.js';

const YAML = readFileSync(new URL('../../dialects/huimeng.dialect.yaml', import.meta.url), 'utf8');

// 惠梦 callback timestamps are unix SECONDS. ts * 1000 must land inside the
// window around ctx.nowMs → pick a nowMs that is exactly SECS * 1000.
const CALLBACK_SECRET = 'hm-callback-secret';
const NOW_MS = 1_752_000_000_000;

// Every gate ctx pins the single operation (harmless — a lone task op resolves
// anyway) and carries the callback-verification secret (§2.2 provider template)
// under ctx.config.callbackSecret, which the DSL's verifyHmacCallback reads.
const CTX: DialectContext = {
  baseUrl: 'https://api.huimengi.com',
  nowMs: NOW_MS,
  config: { operation: 'images.generation', callbackSecret: CALLBACK_SECRET },
};
const SECRET: CredentialSecret = { scheme: 'bearer', api_key: 'sk-hm' };

const dialect = compileDialect(loadDialectPack(YAML));

/**
 * The huimeng acceptance subject. `images.generation` (submit_poll +
 * submit_callback) exercises gates 1/2/3/5/6/7; gate 4 (streaming) SKIPS because
 * a media task has no stream capability. A canonical-only marker in
 * `params.canonical` proves aspect ① never leaks canonical values (§4.1 red
 * line). Bearer auth ⇒ gate 1 checks header placement (no signature vectors).
 */
const subject: ConformanceSubject = {
  label: 'huimeng@1.0.0 (DSL, bearer, submit_callback + hmac)',
  dialect,
  operations: [
    {
      operation: 'images.generation',
      upstreamModelName: 'seedream-4.5',
      params: {
        canonical: { origin_marker: 'CANON_ONLY_HM_IMG' },
        upstream: { prompt: 'a cat', size: '1024x1024' },
      },
      secret: SECRET,
      ctx: CTX,
      fetchMode: 'submit_poll',
      // Aspect ① result: bearer + the ref-image medium are NOT in this draft —
      // the body nests generation params under `params`, model at the top.
      expectedDraft: {
        method: 'POST',
        path: '/api/v1/tasks',
        bodyKind: 'json',
        body: {
          model: 'seedream-4.5',
          params: { prompt: 'a cat', size: '1024x1024' },
        },
      },
      canonicalLeakMarkers: ['CANON_ONLY_HM_IMG'],
      // Gate 7 drives runSync once — a submit-shaped 2xx is enough (output at
      // $.result is absent, normalize returns ok:true, only timeouts checked).
      successResponse: { body: { task_id: 'hm-task-1', status: 'pending' } },
      // Gate 3: the SAME ref-image medium in both placeable forms → $.params.image_url.
      media: {
        url: { param: 'image', form: 'url', url: 'https://cdn.huimengi.com/ref.png' },
        base64: { param: 'image', form: 'base64', bytes: new Uint8Array([1, 2, 3, 4, 5]) },
      },
      // Gate 5: every declared poll status maps to a legal TaskStatus; an
      // unknown status → legal + rawStatus preserved. Poll body echoes the id as
      // `id` (惠梦's id 陷阱), status/result/error_message at the TOP level.
      task: {
        knownStatuses: ['pending', 'processing', 'completed', 'failed'],
        unknownStatus: 'transcoding',
        pollBody: (status) => ({
          id: 'hm-task-1',
          status,
          ...(status === 'completed'
            ? {
                result: {
                  image_url: 'https://cdn.huimengi.com/out.png',
                  image_urls: ['https://cdn.huimengi.com/out.png'],
                  image_count: 1,
                  size: '1024x1024',
                },
              }
            : {}),
          ...(status === 'failed' ? { error_message: 'render failed' } : {}),
        }),
      },
    },
  ],
};

// The gate, expanded into real vitest cases. All green (with gate 4 skipped) ⇒
// the huimeng dialect passes.
describeConformance(subject);

// A programmatic sanity assertion: green report, gate 4 skipped (legal — no
// stream capability), no other gate skipped or failed, no soft-flag warnings.
describe('huimeng conformance report (programmatic)', () => {
  it('passes every applicable gate; streaming legally skips', async () => {
    const report = await runConformanceSuite(subject);
    expect(report.passed).toBe(true);
    expect(report.categories.map((c) => c.status)).toEqual([
      'pass', // credential-injection-and-signature
      'pass', // parameter-mapping-and-domain
      'pass', // media-reference-forms
      'skip', // streaming-resilience — images.generation is not a stream capability
      'pass', // task-status-mapping
      'pass', // error-table-completeness
      'pass', // timeout-budget
    ]);
    expect(report.warnings).toEqual([]);
  });
});

// --- bespoke: the hmac_sha256_timestamp callback门 (验签通过 / 坏签 / 过窗) --------
//
// handleCallback verifies BEFORE it parses: verifyHmacCallback reads the shared
// secret from ctx.config.callbackSecret (it IGNORES the CredentialSecret arg —
// the new world treats the callback secret as a §2.2 provider template, not the
// bearer api key), checks the replay window, then timing-safe compares
// HMAC-SHA256(secret, `${ts}.${rawBody}`) hex. Header keys are lower-cased by
// the receiving edge, so the raw callback carries lower-case header names.
function signHex(secret: string, ts: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${ts}.${rawBody}`, 'utf8').digest('hex');
}

// A completed-task callback body: id back to `task_id`, status/result NESTED
// under `data` (distinct from the top-level poll shape).
const CALLBACK_BODY = JSON.stringify({
  event: 'task.completed',
  task_id: 'hm-cb-1',
  data: {
    status: 'completed',
    result: {
      image_url: 'https://cdn.huimengi.com/out.png',
      image_urls: ['https://cdn.huimengi.com/out.png'],
      image_count: 1,
      size: '1024x1024',
    },
    cost: 123,
  },
});

function callbackRaw(ts: string, signature: string): RawCallback {
  return {
    rawBody: CALLBACK_BODY,
    headers: {
      'x-huimeng-signature': signature,
      'x-huimeng-timestamp': ts,
    },
  };
}

describe('huimeng submit_callback — hmac_sha256_timestamp verification (三态)', () => {
  it('验签通过: a correctly signed, in-window callback verifies and parses to succeeded', () => {
    const ts = String(NOW_MS / 1000); // unix seconds → ts * 1000 === NOW_MS (diff 0)
    const raw = callbackRaw(ts, signHex(CALLBACK_SECRET, ts, CALLBACK_BODY));

    const result = handleCallback(dialect, raw, SECRET, CTX);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.update.upstreamTaskId).toBe('hm-cb-1');
      expect(result.update.status).toBe('succeeded');
      // output = $.data.result (nested); the media urls survive the round-trip.
      expect(JSON.stringify(result.update.output)).toContain('https://cdn.huimengi.com/out.png');
    }
  });

  it('坏签: a valid-timestamp callback with a wrong signature is rejected unauthorized (unparsed)', () => {
    const ts = String(NOW_MS / 1000);
    // Same length (hex sha256 = 64 chars) so it reaches the timing-safe compare
    // and fails there — signed with the WRONG secret.
    const raw = callbackRaw(ts, signHex('not-the-callback-secret', ts, CALLBACK_BODY));

    const result = handleCallback(dialect, raw, SECRET, CTX);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unauthorized');
  });

  it('过窗: a correctly signed but out-of-window (replay) callback is rejected unauthorized', () => {
    // ts 1000s in the past → |nowMs - ts*1000| = 1_000_000ms > the 300_000ms
    // window. The window check runs BEFORE the signature compare, so even a
    // correct signature is rejected.
    const ts = String(NOW_MS / 1000 - 1000);
    const raw = callbackRaw(ts, signHex(CALLBACK_SECRET, ts, CALLBACK_BODY));

    const result = handleCallback(dialect, raw, SECRET, CTX);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unauthorized');
  });
});
