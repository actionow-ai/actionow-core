// model-supply-greenfield 批次2 wave2 — the 火山 / 即梦 (volc / jimeng) dialect
// clears the seven-gate conformance suite (判据 2.4: "火山(AK/SK 签名) ... 全部
// 过门"). volc is CODE-authored (see src/dialects/volc.dialect.ts for why the
// DSL cannot express it): one operation, images.generation, submit_poll only.
//
// Active gates for this dialect:
//   1 credential-injection-and-signature — a RECORDED volc-v4 byte vector
//     (byte-exact, @nowMs=1752000000000, reusing the signers.test.ts snapshot)
//     + per-op signature determinism + post-③ deep freeze.
//   2 parameter-mapping-and-domain — the aspect-① submit draft is pinned and a
//     canonical-only marker must not leak (§4.1 layer-3 red line).
//   3 media-reference-forms — img2img reference image in BOTH forms:
//     url → image_urls[], base64 → binary_data_base64[].
//   4 streaming-resilience — SKIPPED (images.generation is not stream-capable;
//     legitimate skip, not a fake pass — no stream case is supplied).
//   5 task-status-mapping — every declared GetResult status maps to a legal
//     TaskStatus; an unknown status → legal + rawStatus preserved + no crash.
//   6 error-table-completeness — every standard HTTP/timeout/network tier hits
//     an explicit row.
//   7 timeout-budget — the four-field budget rides the transport verbatim.
import type { CredentialSecret } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

// The conformance suite pulls in vitest; import it from the dedicated module so
// it never rides the production barrel (@actionow/spi/conformance subpath).
import type { ConformanceSubject, SignatureVector } from '../../src/conformance.js';
import { describeConformance, runConformanceSuite } from '../../src/conformance.js';
import { volcDialect } from '../../src/dialects/volc.dialect.js';
import type { DialectContext, WireRequestDraft } from '../../src/index.js';

const NOW_MS = 1_752_000_000_000; // 2025-07-08T18:40:00.000Z — the recorded-vector clock.

// The channel credential (ak_sk) + the channel-scoped dialect context. `service`
// MUST be 'cv' for jimeng Visual (the volc-v4 credential-scope service
// component); `req_key` is threaded so the poll's GetResult body carries it;
// region falls back from the secret.
const VOLC_SECRET: CredentialSecret = {
  scheme: 'ak_sk',
  access_key: 'AKLT-test-ak',
  secret_key: 'test-sk',
  region: 'cn-north-1',
};
const VOLC_CTX: DialectContext = {
  nowMs: NOW_MS,
  config: { service: 'cv', region: 'cn-north-1', req_key: 'jimeng_t2i_v30' },
};

// --- gate 1: the RECORDED volc-v4 signature vector (byte-exact) ---------------
//
// The exact draft/secret/ctx from the wire study; expectedHeaders are the bytes
// recorded in packages/spi/test/signers.test.ts:95-101 (no public volc vectors →
// §6 record path). Hardcoded, compared byte-for-byte — never recompute-and-trust.
const RECORDED_VOLC_V4_VECTOR: SignatureVector = {
  label: 'volc-v4 submit (recorded @nowMs=1752000000000)',
  draft: {
    method: 'POST',
    path: 'https://visual.volcengineapi.com/',
    query: { Action: 'CVSync2AsyncSubmitTask', Version: '2022-08-31' },
    headers: {},
    bodyKind: 'json',
    body: { req_key: 'jimeng_t2i_v30', prompt: 'a cat' },
  },
  secret: {
    scheme: 'ak_sk',
    access_key: 'AKLT-test-ak',
    secret_key: 'test-sk',
    region: 'cn-north-1',
  },
  ctx: { nowMs: NOW_MS, config: { service: 'cv' } },
  expectedHeaders: {
    Authorization:
      'HMAC-SHA256 Credential=AKLT-test-ak/20250708/cn-north-1/cv/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=7026de3cdd79c054a45f8f33d560faef7153b6c773931ca3064d50f480096a5d',
    'X-Date': '20250708T184000Z',
    'X-Content-Sha256': 'bfab69fb5361a5af769744a0592c3e1bee34e2aa5d7fdfc85bb486582d30c9c0',
  },
};

// The pinned aspect-① submit draft (Action/Version in query; body = req_key +
// verbatim upstream params). Canonical-only 'CANON_ONLY_VOLC' lives ONLY in
// params.canonical so gate 2 proves the red line.
const EXPECTED_SUBMIT_DRAFT: WireRequestDraft = {
  method: 'POST',
  path: 'https://visual.volcengineapi.com/',
  query: { Action: 'CVSync2AsyncSubmitTask', Version: '2022-08-31' },
  headers: {},
  bodyKind: 'json',
  body: { req_key: 'jimeng_t2i_v30', prompt: 'a cat', width: 512, height: 512 },
};

const subject: ConformanceSubject = {
  label: 'volc@1.0.0 (code, volc-v4 AK/SK, jimeng images.generation submit_poll)',
  dialect: volcDialect,
  signatureVectors: [RECORDED_VOLC_V4_VECTOR],
  operations: [
    {
      operation: 'images.generation',
      upstreamModelName: 'jimeng_t2i_v30',
      params: {
        canonical: { origin_marker: 'CANON_ONLY_VOLC' },
        upstream: { prompt: 'a cat', width: 512, height: 512 },
      },
      secret: VOLC_SECRET,
      ctx: VOLC_CTX,
      fetchMode: 'submit_poll',
      expectedDraft: EXPECTED_SUBMIT_DRAFT,
      canonicalLeakMarkers: ['CANON_ONLY_VOLC'],
      // A representative 2xx submit envelope (drives gate 7's transport).
      successResponse: {
        status: 200,
        body: {
          code: 10_000,
          message: 'Success',
          request_id: 'volc-req-1',
          data: { task_id: 'vt-1' },
        },
      },
      // img2img reference image in both delivery forms (gate 3).
      media: {
        url: { param: 'image', form: 'url', url: 'https://cdn.volc.example/ref.png' },
        base64: { param: 'image', form: 'base64', bytes: new Uint8Array([1, 2, 3, 4, 5]) },
      },
      // GetResult status vocabulary (gate 5): full known set + an unknown probe.
      task: {
        knownStatuses: ['in_queue', 'generating', 'done', 'not_found', 'expired'],
        unknownStatus: 'reticulating',
        pollBody: (status) => ({
          code: 10_000,
          message: 'Success',
          request_id: 'volc-req-1',
          status: 10_000,
          data: {
            status,
            image_urls: status === 'done' ? ['https://cdn.volc.example/out.png'] : [],
            binary_data_base64: [],
          },
        }),
      },
    },
  ],
};

// The gate, expanded into real vitest cases. All green ⇒ volc clears the gate.
describeConformance(subject);

// A programmatic assertion over the same subject — the four ACTIVE gates pass,
// gate 4 (streaming) legitimately SKIPS (images.generation is not stream-capable),
// and no gate fails. Warnings are informational (403 failover:true is tolerated).
describe('volc conformance report (programmatic)', () => {
  it('passes every active gate; streaming skips legitimately', async () => {
    const report = await runConformanceSuite(subject);
    expect(report.passed).toBe(true);
    const byName = Object.fromEntries(report.categories.map((c) => [c.name, c.status]));
    expect(byName['credential-injection-and-signature']).toBe('pass');
    expect(byName['parameter-mapping-and-domain']).toBe('pass');
    expect(byName['media-reference-forms']).toBe('pass');
    expect(byName['streaming-resilience']).toBe('skip'); // not stream-capable
    expect(byName['task-status-mapping']).toBe('pass');
    expect(byName['error-table-completeness']).toBe('pass');
    expect(byName['timeout-budget']).toBe('pass');
  });
});
