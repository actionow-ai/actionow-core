# Adapter conformance gate (§6 一致性测试门)

Every dialect — DSL-compiled (`compileDialect`) or code-authored (six aspects by
hand) — must clear the seven-gate conformance suite before it may serve traffic.
The gate is plain vitest (mock upstream, in-memory, no docker), so `turbo run
test` picks it up automatically and `quality.yml` enforces it in CI **with no
workflow change**. (A dedicated gate job or a `required` status check is a
wave2/ops decision — not done here.)

## The seven gates

| #   | gate name (`ConformanceCategory`)    | what it asserts                                                                                                                                        |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `credential-injection-and-signature` | signature byte vectors match; bearer/x-api-key/query land in the right slot; the post-③ request is deep-frozen                                         |
| 2   | `parameter-mapping-and-domain`       | aspect ① draft is stable AND reflects `params.upstream` only — a canonical-only value must never leak (§4.1 layer-3 red line)                          |
| 3   | `media-reference-forms`              | a `url` and a `base64` medium both place correctly; `file_api`/`bucket` upload forms are declared (upload I/O is upper-layer)                          |
| 4   | `streaming-resilience`               | half-frames split across chunks reassemble; out-of-order frames tolerate; an empty stream / over-ceiling event terminate with an error frame (no hang) |
| 5   | `task-status-mapping`                | every declared upstream status maps to a legal `TaskStatus`; an UNKNOWN status → legal status + verbatim `rawStatus` + no crash                        |
| 6   | `error-table-completeness`           | every `STANDARD_ERROR_PROBES` tier reaches an explicit row and a valid `GatewayError`; retryable/failover deviations are **warnings**, not failures    |
| 7   | `timeout-budget`                     | all four `TimeoutBudget` fields map onto `HttpRequest` and transport verbatim                                                                          |

## How to add a dialect to the gate

Write `test/conformance/<dialect>.conformance.test.ts`:

```ts
import { compileDialect, describeConformance, loadDialectPack } from '../../src/index.js';
import type { ConformanceSubject } from '../../src/index.js';

const dialect = compileDialect(loadDialectPack(YAML)); // or a hand-authored Dialect

const subject: ConformanceSubject = {
  label: '<provider>@<version>',
  dialect,
  operations: [
    {
      operation: 'chat.completions',
      upstreamModelName: '...',
      params: { canonical: { marker: 'CANON_ONLY' }, upstream: { /* real upstream values */ } },
      secret: { scheme: 'bearer', api_key: '...' },
      ctx: { baseUrl: 'https://...', nowMs: 1_752_000_000_000 },
      expectedDraft: { /* the aspect-① wire draft; omit to record a snapshot instead */ },
      canonicalLeakMarkers: ['CANON_ONLY'], // values that must NOT leak into the draft
      successResponse: { body: { /* a representative 2xx */ } },
      stream: { deltaFrames: ['...'], doneSentinel: '[DONE]' },   // if the op streams
      media: { url: { param: 'image', form: 'url', url: '...' },  // if the op takes media
               base64: { param: 'image', form: 'base64', bytes: new Uint8Array([...]) } },
      task: { knownStatuses: ['queued', 'done', ...],             // if the op is submit_poll/callback
              unknownStatus: 'made_up', pollBody: (s) => ({ task_id: 't', status: s }) },
    },
  ],
  signatureVectors: [ /* for signature dialects — see below */ ],
};

describeConformance(subject); // expands into real vitest cases; all green = passes the gate
```

Put `canonical` and `upstream` **deliberately at odds** (a marker in canonical
that is absent from upstream) so gate 2 actually proves the red line. Pin
`expectedDraft` for a stable regression, or omit it to let `describeConformance`
record a `toMatchSnapshot`.

### Signature dialects (gate 1)

`ak_sk` / `oauth` dialects delegate to a shared code signer (`volc-v4` /
`tencent-tc3` / `kling-jwt`). Supply `signatureVectors`: official public vectors
when they exist, otherwise a **recorded** vector captured from this
implementation (§6: 无公开向量以实测录制快照为准). The regression baseline already
lives in `test/signers.test.ts` (inline snapshots) — reuse those byte values as
`expectedHeaders`. `harness.test.ts` shows the pattern end-to-end for `volc-v4`.

## wave2 — the five real dialects (TODO, not done in this slice)

This slice ships the **gate framework + the mock vendor passing it**. The five
production dialects get their own `*.conformance.test.ts` in wave2. Classification
(DSL vs code aspect) follows the slice-2 dialect inventory — confirm there before
implementing:

- [ ] **openai** — bearer, standard SSE. Expected: **DSL pack**. Needs: chat
      direct+stream op cases, embeddings op case; no signature vector (bearer →
      header-placement path).
- [ ] **anthropic** — `x-api-key` + static `anthropic-version` header, `event:`+
      `data:` SSE. Expected: **DSL pack** (standard SSE framing, not private
      framing). Needs: chat direct+stream op cases; no signature vector.
- [ ] **gemini** — `?key=` query auth, `alt=sse` streaming. Expected: **DSL
      pack** (query scheme). Needs: chat direct+stream op cases; no signature
      vector.
- [ ] **火山 / volcengine** — AK/SK SigV4 (`volc-v4` shared signer), jimeng image
      submit_poll. Expected: **DSL pack + `auth.signer: volc-v4`** (signature is
      the only code-aspect part). Needs: a **recorded volc-v4 signature vector**
      (reuse `signers.test.ts`), image submit_poll + media + task op cases.
- [ ] **惠梦 / huimeng** — seed media relay (seedream/seedance), async media with
      an `hmac_sha256_timestamp` callback. Expected: **DSL pack** (callback verify
      is a DSL-supported strategy; auth bearer). Needs: image/video
      submit_callback + media + task op cases; no signature vector if bearer.

If any dialect turns out to need **private framing / multi-step / WS** (the §6
"升代码切面" cases the DSL cannot express), author it as code aspects and hand the
resulting `Dialect` to the same `describeConformance` — the gate is identical for
both authoring modes.
