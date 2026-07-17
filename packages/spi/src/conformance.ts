// packages/spi/src/conformance.ts
//
// model-supply-greenfield 批次2 slice 3 — the ADAPTER CONFORMANCE GATE (design
// docs/plans/draft_2026-07-10_model-supply-greenfield.md §6 一致性测试门). One
// reusable test-suite generator every dialect (DSL-compiled or code-authored)
// must pass before it may serve traffic. `runConformanceSuite` is the PURE
// programmatic checker (mock upstream, in-memory, no docker) returning a
// {@link ConformanceReport}; `describeConformance` expands the same verdicts
// into real vitest `describe/it` cases so `turbo run test` enforces the gate in
// CI with no YAML change.
//
// The seven gates (§6 一致性测试门, one assertion family each; a gate whose
// capability the operation lacks is SKIPPED with a reason, never silently
// dropped):
//   1. credential injection & signature byte comparison (+ post-③ deep freeze)
//   2. parameter mapping snapshot & the §4.1-layer-3 red line (upstream only)
//   3. media three reference forms (url / base64 placement + upload declares)
//   4. streaming half-frame / out-of-order / interruption / overflow resilience
//   5. task status mapping total coverage (unknown status → legal + no crash)
//   6. error-table completeness + retryable/failover flag sanity (soft)
//   7. three-level (four-field) timeout budget transport passthrough
//
// Dependencies: spi-internal aspects/pipeline + @actionow/contracts + vitest
// ONLY (the §6 gate red line). It never imports engine/adapters/llm-protocol.
import type {
  CredentialSecret,
  EffectiveParams,
  FetchMode,
  HttpClient,
  HttpRequest,
  Operation,
  StreamFrame,
} from '@actionow/contracts';
import { gatewayErrorSchema, taskUpdateSchema } from '@actionow/contracts';
import { beforeAll, describe, expect, it } from 'vitest';

import type {
  Dialect,
  DialectContext,
  RequestMappingInput,
  ResolvedMediaInput,
  TimeoutBudget,
  WireRequestDraft,
} from './aspects.js';
import {
  composeWireUrl,
  errorTableCompleteness,
  resolveError,
  STANDARD_ERROR_PROBES,
} from './aspects.js';
import type { SyncRunInput } from './pipeline.js';
import { deepFreeze, runStream, runSync } from './pipeline.js';

// --- public gate vocabulary ---------------------------------------------------

/** The seven conformance gates, in report order (§6 一致性测试门). */
export const CONFORMANCE_CATEGORIES = [
  'credential-injection-and-signature',
  'parameter-mapping-and-domain',
  'media-reference-forms',
  'streaming-resilience',
  'task-status-mapping',
  'error-table-completeness',
  'timeout-budget',
] as const;
export type ConformanceCategory = (typeof CONFORMANCE_CATEGORIES)[number];

// --- subject description (what a caller hands the gate) -----------------------

/**
 * One credential-injection byte vector (gate 1). Official public vectors are
 * preferred; providers without them record a snapshot from this implementation
 * (§6: 无公开向量的厂商以实测录制快照为准). The vector's `draft` MUST already
 * carry an ABSOLUTE url in `path` (signers need the host — the pipeline resolves
 * relative paths before aspect ③, so a vector mirrors that post-resolve state).
 * After injection every `expectedHeaders` entry must match the produced header
 * byte-for-byte, and `expectedUrl` (when set) the composed request URL.
 */
export interface SignatureVector {
  label: string;
  draft: WireRequestDraft;
  secret: CredentialSecret;
  ctx: DialectContext;
  expectedHeaders: Record<string, string>;
  expectedUrl?: string;
}

/** A media acceptance sample (gate 3): the SAME medium in both placeable forms. */
export interface ConformanceMediaCase {
  /** The resolved medium as a URL reference (`form: 'url'`). */
  url: ResolvedMediaInput;
  /** The resolved medium as raw bytes (`form: 'base64'`). */
  base64: ResolvedMediaInput;
}

/** A streaming sample (gate 4): raw `data:` payloads the framer + aspect ⑤ turn into frames. */
export interface ConformanceStreamCase {
  /** Content `data:` payloads (no `data: ` prefix, no newlines), in order. */
  deltaFrames: string[];
  /** Stream terminator payload (default `[DONE]`). */
  doneSentinel?: string;
  /** An extra frame delivered BEFORE the content deltas — proves order tolerance (§6 乱序). */
  earlyFrame?: string;
}

/** A task-lifecycle sample (gate 5). */
export interface ConformanceTaskCase {
  /** Every upstream status string the dialect's statusMap declares (each must map to a legal TaskStatus). */
  knownStatuses: string[];
  /** A status the dialect does NOT declare — must map legal + preserve rawStatus + not throw (§6 未知状态告警不崩溃). */
  unknownStatus: string;
  /** Build a poll-response body carrying the given upstream status. */
  pollBody: (upstreamStatus: string) => unknown;
}

/**
 * One operation's acceptance sample. Absent sub-cases skip their gate for this
 * operation (e.g. no `media` → gate 3 skipped here). `canonicalLeakMarkers`
 * lists substrings living ONLY in `params.canonical` that must never appear in
 * the wire draft (§4.1 layer-3 red line); when omitted they are auto-derived
 * from top-level scalar canonical values absent from `params.upstream`.
 */
export interface ConformanceOpCase {
  operation: Operation;
  upstreamModelName: string;
  params: EffectiveParams;
  secret: CredentialSecret;
  ctx: DialectContext;
  /** The upstream fetch mode this case represents (annotation only; gates key off the sub-cases). */
  fetchMode?: FetchMode;
  /** Expected aspect-① draft (deep-equal, order-insensitive). Absent → describeConformance snapshots it. */
  expectedDraft?: WireRequestDraft;
  canonicalLeakMarkers?: string[];
  /** A representative success upstream response for the transport/timeout drive (gate 7). */
  successResponse?: { status?: number; body: unknown; text?: string };
  media?: ConformanceMediaCase;
  stream?: ConformanceStreamCase;
  task?: ConformanceTaskCase;
}

/** A dialect under test + its acceptance samples (§6 一致性测试门 input). */
export interface ConformanceSubject {
  label: string;
  dialect: Dialect;
  operations: ConformanceOpCase[];
  signatureVectors?: SignatureVector[];
}

// --- report shape -------------------------------------------------------------

export interface ConformanceCategoryResult {
  name: ConformanceCategory;
  status: 'pass' | 'fail' | 'skip';
  detail: string;
}

export interface ConformanceReport {
  label: string;
  passed: boolean;
  categories: ConformanceCategoryResult[];
  warnings: string[];
}

interface CategoryOutcome {
  status: 'pass' | 'fail' | 'skip';
  detail: string;
  warnings: string[];
}

// --- small shared helpers -----------------------------------------------------

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function ser(value: unknown): string {
  // JSON.stringify returns undefined for these top-level kinds; guard so the
  // result is always a string (nested undefined/function are omitted by JSON).
  if (value === undefined) return 'undefined';
  if (typeof value === 'function' || typeof value === 'symbol') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

/** Order-insensitive structural equality — expectedDraft field order is authored, not load-bearing. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  const arrA = Array.isArray(a);
  if (arrA !== Array.isArray(b)) return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

function didThrow(fn: () => void): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

function isApiKeyScheme(scheme: CredentialSecret['scheme']): boolean {
  return scheme === 'bearer' || scheme === 'x_api_key' || scheme === 'query';
}

function apiKeyValue(secret: CredentialSecret): string | undefined {
  return secret.scheme === 'bearer' || secret.scheme === 'x_api_key' || secret.scheme === 'query'
    ? secret.api_key
    : undefined;
}

function mappingInputOf(op: ConformanceOpCase, stream: boolean): RequestMappingInput {
  return {
    operation: op.operation,
    upstreamModelName: op.upstreamModelName,
    params: op.params,
    stream,
    ctx: op.ctx,
  };
}

function mapDraft(dialect: Dialect, op: ConformanceOpCase): WireRequestDraft {
  return dialect.requestMapping.map(mappingInputOf(op, false));
}

/** Mirror the pipeline's pre-③ URL resolve (prefix-join, keeps base path segments) so signers bind an absolute URL. */
function resolveDraftPath(draft: WireRequestDraft, baseUrl: string | undefined): WireRequestDraft {
  if (/^https?:\/\//i.test(draft.path)) return draft;
  if (baseUrl === undefined || baseUrl.length === 0) return draft;
  const joined = `${baseUrl.replace(/\/+$/, '')}/${draft.path.replace(/^\/+/, '')}`;
  return { ...draft, path: joined };
}

function injectForOp(dialect: Dialect, op: ConformanceOpCase): WireRequestDraft {
  const resolved = resolveDraftPath(mapDraft(dialect, op), op.ctx.baseUrl);
  return dialect.credentialInjection.injectCredential(resolved, op.secret, op.ctx);
}

function syncInputOf(op: ConformanceOpCase): SyncRunInput {
  return {
    operation: op.operation,
    upstreamModelName: op.upstreamModelName,
    params: op.params,
    secret: op.secret,
    ctx: op.ctx,
  };
}

/** Derive canonical-only leak markers: top-level scalar canonical values whose string form is absent from upstream. */
function autoLeakMarkers(params: EffectiveParams): string[] {
  const upstreamScalars = new Set<string>();
  for (const value of Object.values(params.upstream)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      upstreamScalars.add(String(value));
    }
  }
  const markers: string[] = [];
  for (const value of Object.values(params.canonical)) {
    if (typeof value === 'string' && value.length >= 3 && !upstreamScalars.has(value)) {
      markers.push(value);
    }
  }
  return markers;
}

function fold(
  fails: string[],
  ran: boolean,
  skipReason: string,
  passDetail: string,
): CategoryOutcome {
  if (fails.length > 0) return { status: 'fail', detail: fails.join(' | '), warnings: [] };
  if (!ran) return { status: 'skip', detail: skipReason, warnings: [] };
  return { status: 'pass', detail: passDetail, warnings: [] };
}

// --- internal fake HTTP (mock upstream, in-memory) ---------------------------

function streamHttp(status: number, chunks: string[]): HttpClient {
  return {
    request: () => {
      throw new Error('request() is not used on the stream path');
    },
    stream: () =>
      Promise.resolve({
        status,
        ok: status >= 200 && status < 300,
        // eslint-disable-next-line @typescript-eslint/require-await
        lines: (async function* () {
          for (const chunk of chunks) yield chunk;
        })(),
      }),
  };
}

function recordingHttp(
  capture: (req: HttpRequest) => void,
  status: number,
  body: unknown,
  text: string,
): HttpClient {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    request: async (req) => {
      capture(req);
      return { status, ok: status >= 200 && status < 300, body, text };
    },
  };
}

async function collectFrames(frames: AsyncIterable<StreamFrame>): Promise<StreamFrame[]> {
  const out: StreamFrame[] = [];
  for await (const frame of frames) out.push(frame);
  return out;
}

const sseData = (payload: string): string => `data: ${payload}\n\n`;

async function driveStream(
  dialect: Dialect,
  op: ConformanceOpCase,
  chunks: string[],
): Promise<StreamFrame[]> {
  const handle = runStream(dialect, syncInputOf(op), { http: streamHttp(200, chunks) });
  return collectFrames(handle.frames);
}

// --- gate 1: credential injection & signature byte comparison ----------------

function checkCredentialAndSignature(subject: ConformanceSubject): CategoryOutcome {
  const fails: string[] = [];
  let ran = false;

  for (const vector of subject.signatureVectors ?? []) {
    ran = true;
    try {
      const injected = subject.dialect.credentialInjection.injectCredential(
        vector.draft,
        vector.secret,
        vector.ctx,
      );
      for (const [key, expected] of Object.entries(vector.expectedHeaders)) {
        const got = injected.headers?.[key];
        if (got !== expected) {
          fails.push(
            `vector "${vector.label}": header ${key} byte mismatch (expected ${ser(expected)}, got ${ser(got)})`,
          );
        }
      }
      if (vector.expectedUrl !== undefined) {
        const gotUrl = composeWireUrl(injected);
        if (gotUrl !== vector.expectedUrl) {
          fails.push(
            `vector "${vector.label}": url mismatch (expected ${vector.expectedUrl}, got ${gotUrl})`,
          );
        }
      }
      const frozen = deepFreeze(injected);
      if (!didThrow(() => ((frozen as { path: string }).path = '__mutation__'))) {
        fails.push(
          `vector "${vector.label}": post-③ request was NOT deep-frozen (mutation allowed)`,
        );
      }
    } catch (err) {
      fails.push(`vector "${vector.label}" threw during injection: ${msgOf(err)}`);
    }
  }

  for (const op of subject.operations) {
    ran = true;
    try {
      const draft = resolveDraftPath(mapDraft(subject.dialect, op), op.ctx.baseUrl);
      const injected = subject.dialect.credentialInjection.injectCredential(
        draft,
        op.secret,
        op.ctx,
      );
      const key = apiKeyValue(op.secret);
      if (isApiKeyScheme(op.secret.scheme) && key !== undefined) {
        const after = ser({ headers: injected.headers ?? {}, query: injected.query ?? {} });
        if (!after.includes(key)) {
          fails.push(
            `op ${op.operation}: ${op.secret.scheme} api key was not placed into a header or query slot after ③`,
          );
        }
      } else if (!isApiKeyScheme(op.secret.scheme)) {
        // Signature schemes without a byte vector: prove determinism under fixed nowMs.
        const again = subject.dialect.credentialInjection.injectCredential(
          draft,
          op.secret,
          op.ctx,
        );
        if (ser(injected) !== ser(again)) {
          fails.push(`op ${op.operation}: signature is non-deterministic under a fixed nowMs`);
        }
      }
      const frozen = deepFreeze(injected);
      if (!didThrow(() => ((frozen as { path: string }).path = '__mutation__'))) {
        fails.push(`op ${op.operation}: post-③ request was NOT deep-frozen (mutation allowed)`);
      }
    } catch (err) {
      fails.push(`op ${op.operation} credential injection threw: ${msgOf(err)}`);
    }
  }

  return fold(
    fails,
    ran,
    'no operations or signature vectors to inject',
    `credential placement + post-③ freeze verified (${String((subject.signatureVectors ?? []).length)} byte vectors)`,
  );
}

// --- gate 2: parameter mapping snapshot & the §4.1-layer-3 red line -----------

function checkParameterMapping(subject: ConformanceSubject): CategoryOutcome {
  const fails: string[] = [];
  let ran = false;

  for (const op of subject.operations) {
    ran = true;
    try {
      const draft = mapDraft(subject.dialect, op);
      if (op.expectedDraft !== undefined && !deepEqual(draft, op.expectedDraft)) {
        fails.push(
          `op ${op.operation}: aspect-① draft drifted from the expected snapshot (got ${ser(draft)})`,
        );
      }
      const markers = op.canonicalLeakMarkers ?? autoLeakMarkers(op.params);
      const serialized = ser(draft);
      for (const marker of markers) {
        if (serialized.includes(marker)) {
          fails.push(
            `op ${op.operation}: canonical-only value "${marker}" LEAKED into the wire draft (§4.1 layer-3 red line — aspect ① must consume upstream only)`,
          );
        }
      }
    } catch (err) {
      fails.push(`op ${op.operation} request mapping threw: ${msgOf(err)}`);
    }
  }

  return fold(
    fails,
    ran,
    'no operations to map',
    'aspect-① drafts are stable and reflect params.upstream only (no canonical leak)',
  );
}

// --- gate 3: media three reference forms -------------------------------------

async function checkMediaForms(subject: ConformanceSubject): Promise<CategoryOutcome> {
  const fails: string[] = [];
  const details: string[] = [];
  let ran = false;

  for (const op of subject.operations) {
    if (op.media === undefined) continue;
    ran = true;
    const media = op.media;
    const aspect = subject.dialect.mediaInjection;
    if (aspect === undefined) {
      fails.push(
        `op ${op.operation}: a media case is declared but the dialect exposes no mediaInjection aspect`,
      );
      continue;
    }
    try {
      if (aspect.deliveryForms.length === 0) {
        fails.push(`op ${op.operation}: mediaInjection declares no deliveryForms`);
      }
      const base = mapDraft(subject.dialect, op);

      const urlValue = media.url.url;
      if (urlValue === undefined) {
        fails.push(`op ${op.operation}: url media case carries no url`);
      } else {
        const placed = await aspect.inject(base, [media.url], op.ctx);
        if (!ser(placed).includes(urlValue)) {
          fails.push(`op ${op.operation}: url medium was not placed into the wire draft`);
        }
      }

      const bytes = media.base64.bytes;
      if (bytes === undefined) {
        fails.push(`op ${op.operation}: base64 media case carries no bytes`);
      } else {
        const placed = await aspect.inject(base, [media.base64], op.ctx);
        const expectedB64 = Buffer.from(bytes).toString('base64');
        if (!ser(placed).includes(expectedB64)) {
          fails.push(`op ${op.operation}: base64 medium was not placed into the wire draft`);
        }
      }

      const uploadForms = aspect.deliveryForms.filter((f) => f === 'file_api' || f === 'bucket');
      if (uploadForms.length > 0) {
        details.push(
          `op ${op.operation} declares upload delivery forms ${uploadForms.join('/')} (upload I/O is upper-layer; the gate only checks the declaration exists)`,
        );
      }
    } catch (err) {
      fails.push(`op ${op.operation} media injection threw: ${msgOf(err)}`);
    }
  }

  const passDetail =
    details.length > 0
      ? `url + base64 placements verified; ${details.join('; ')}`
      : 'url + base64 placements verified';
  return fold(fails, ran, 'no operation declares a media case', passDetail);
}

// --- gate 4: streaming half-frame / out-of-order / interruption / overflow ----

async function checkStreamingResilience(subject: ConformanceSubject): Promise<CategoryOutcome> {
  const fails: string[] = [];
  let ran = false;

  for (const op of subject.operations) {
    const streamCase = op.stream;
    if (streamCase === undefined) continue;
    ran = true;
    const sentinel = streamCase.doneSentinel ?? '[DONE]';
    const deltas = streamCase.deltaFrames;
    if (deltas.length === 0) {
      fails.push(`op ${op.operation}: stream case declares no deltaFrames`);
      continue;
    }
    try {
      const doneChunk = sseData(sentinel);
      const baselineChunks = [...deltas.map(sseData), doneChunk];
      const baseline = await driveStream(subject.dialect, op, baselineChunks);
      if (baseline.some((f) => f.kind === 'error')) {
        fails.push(`op ${op.operation}: a clean stream produced an error frame`);
      }

      // Half frame: split the first content frame across two chunks.
      const firstChunk = sseData(deltas[0] ?? '');
      const mid = Math.max(1, Math.floor(firstChunk.length / 2));
      const halfChunks = [
        firstChunk.slice(0, mid),
        firstChunk.slice(mid),
        ...deltas.slice(1).map(sseData),
        doneChunk,
      ];
      const half = await driveStream(subject.dialect, op, halfChunks);
      if (ser(half) !== ser(baseline)) {
        fails.push(
          `op ${op.operation}: a half-frame split across chunks did NOT reassemble to the same frames (bounded framer defect)`,
        );
      }

      // Out of order: an extra frame delivered before the content deltas.
      if (streamCase.earlyFrame !== undefined) {
        const reordered = await driveStream(subject.dialect, op, [
          sseData(streamCase.earlyFrame),
          ...deltas.map(sseData),
          doneChunk,
        ]);
        if (reordered.some((f) => f.kind === 'error')) {
          fails.push(`op ${op.operation}: an out-of-order (early) frame produced an error frame`);
        }
      }

      // Interruption A: some content then the stream ENDS without a terminator → must terminate, not hang.
      const cut = await driveStream(subject.dialect, op, [sseData(deltas[0] ?? '')]);
      if (!Array.isArray(cut)) {
        fails.push(`op ${op.operation}: a mid-stream cut did not terminate`);
      }

      // Interruption B: an empty 2xx stream → ONE synthesized error terminal frame (never a silent empty success).
      const empty = await driveStream(subject.dialect, op, []);
      const emptyError = empty.length === 1 && empty[0]?.kind === 'error';
      if (!emptyError) {
        fails.push(
          `op ${op.operation}: an empty 2xx stream must synthesize exactly one error terminal frame (got ${ser(empty.map((f) => f.kind))})`,
        );
      } else {
        const only = empty[0];
        if (only?.kind === 'error' && !only.error.message.includes('before producing any frame')) {
          fails.push(`op ${op.operation}: empty-stream error frame carries an unexpected message`);
        }
      }

      // Overflow: an over-ceiling event → a bounded-overflow error terminal frame.
      const giant = 'a'.repeat(1_100_000);
      const overflow = await driveStream(subject.dialect, op, [
        sseData(deltas[0] ?? ''),
        sseData(giant),
      ]);
      const overflowError = overflow.find((f) => f.kind === 'error');
      if (overflowError === undefined) {
        fails.push(
          `op ${op.operation}: an over-ceiling event did not produce a bounded-overflow error frame`,
        );
      } else if (!overflowError.error.message.includes('bounded buffer overflow')) {
        fails.push(`op ${op.operation}: overflow error frame carries an unexpected message`);
      }
    } catch (err) {
      fails.push(`op ${op.operation} streaming drive threw: ${msgOf(err)}`);
    }
  }

  return fold(
    fails,
    ran,
    'no operation declares a stream case',
    'half-frame reassembly, order tolerance, interruption + overflow all terminate correctly',
  );
}

// --- gate 5: task status mapping total coverage ------------------------------

function checkTaskStatusMapping(subject: ConformanceSubject): CategoryOutcome {
  const fails: string[] = [];
  let ran = false;

  for (const op of subject.operations) {
    const taskCase = op.task;
    if (taskCase === undefined) continue;
    ran = true;
    const tl = subject.dialect.taskLifecycle;
    if (tl === undefined) {
      fails.push(
        `op ${op.operation}: a task case is declared but the dialect exposes no taskLifecycle aspect`,
      );
      continue;
    }
    try {
      for (const status of taskCase.knownStatuses) {
        let update;
        try {
          update = tl.parseQueryResponse({
            status: 200,
            headers: {},
            body: taskCase.pollBody(status),
          });
        } catch (err) {
          fails.push(
            `op ${op.operation}: declared status "${status}" threw during parse: ${msgOf(err)}`,
          );
          continue;
        }
        if (didThrow(() => void taskUpdateSchema.parse(update))) {
          fails.push(
            `op ${op.operation}: declared status "${status}" produced an invalid TaskUpdate`,
          );
        }
      }

      let unknown;
      try {
        unknown = tl.parseQueryResponse({
          status: 200,
          headers: {},
          body: taskCase.pollBody(taskCase.unknownStatus),
        });
      } catch (err) {
        fails.push(
          `op ${op.operation}: UNKNOWN status "${taskCase.unknownStatus}" threw — §6 requires a legal status + alert, never a crash: ${msgOf(err)}`,
        );
        continue;
      }
      if (didThrow(() => void taskUpdateSchema.parse(unknown))) {
        fails.push(`op ${op.operation}: unknown status produced an invalid TaskUpdate`);
      } else if (unknown.rawStatus !== taskCase.unknownStatus) {
        fails.push(
          `op ${op.operation}: unknown status did NOT preserve rawStatus verbatim (got ${ser(unknown.rawStatus)})`,
        );
      }
    } catch (err) {
      fails.push(`op ${op.operation} task status mapping threw: ${msgOf(err)}`);
    }
  }

  return fold(
    fails,
    ran,
    'no operation declares a task case',
    'every declared status maps to a legal TaskStatus; unknown status → legal + rawStatus preserved + no crash',
  );
}

// --- gate 6: error-table completeness + retryable/failover flag sanity --------

function checkErrorTableCompleteness(subject: ConformanceSubject): CategoryOutcome {
  const fails: string[] = [];
  const warnings: string[] = [];
  const report = errorTableCompleteness(subject.dialect.errorTable);

  if (!report.complete) {
    fails.push(
      `error table only fallbacks the standard probes: ${report.missing.join(', ')} (§6 requires an explicit row each)`,
    );
  }
  for (const { probe, label } of STANDARD_ERROR_PROBES) {
    if (
      didThrow(() => void gatewayErrorSchema.parse(resolveError(subject.dialect.errorTable, probe)))
    ) {
      fails.push(`probe "${label}" resolved to an invalid GatewayError envelope`);
    }
  }

  // Soft flag sanity (§6: 偏离 warn 不 fail) — deviations are informational, never a hard fail.
  const noRetry = new Set(['http:400', 'http:401', 'http:403', 'http:404']);
  const wantFailover = new Set(['http:500', 'http:502', 'http:503', 'http:504']);
  const wantRetry = new Set(['timeout', 'network']);
  for (const entry of report.entries) {
    if (noRetry.has(entry.probe) && entry.retryable) {
      warnings.push(
        `${entry.probe} is marked retryable — a client error rarely benefits from a same-hop retry`,
      );
    }
    if (wantFailover.has(entry.probe) && !entry.failover) {
      warnings.push(
        `${entry.probe} is not marked failover — a 5xx usually should let routing try the next offering`,
      );
    }
    if (wantRetry.has(entry.probe) && !entry.retryable) {
      warnings.push(
        `${entry.probe} is not marked retryable — a transport ${entry.probe} error is usually retryable`,
      );
    }
  }

  if (fails.length > 0) return { status: 'fail', detail: fails.join(' | '), warnings };
  return {
    status: 'pass',
    detail: 'all standard probes reach an explicit row and resolve to a valid GatewayError',
    warnings,
  };
}

// --- gate 7: three-level (four-field) timeout budget passthrough --------------

async function checkTimeoutBudget(subject: ConformanceSubject): Promise<CategoryOutcome> {
  const op = subject.operations[0];
  if (op === undefined) {
    return { status: 'skip', detail: 'no operation to drive the transport', warnings: [] };
  }
  const budget: TimeoutBudget = {
    connectTimeoutMs: 1111,
    ttftTimeoutMs: 2222,
    totalTimeoutMs: 3333,
    idleTimeoutMs: 4444,
  };
  const status = op.successResponse?.status ?? 200;
  const body = op.successResponse?.body ?? {};
  const text = op.successResponse?.text ?? ser(body);
  let seen: HttpRequest | undefined;
  try {
    await runSync(subject.dialect, syncInputOf(op), {
      http: recordingHttp((req) => (seen = req), status, body, text),
      budget,
    });
  } catch (err) {
    return {
      status: 'fail',
      detail: `runSync threw while driving the transport: ${msgOf(err)}`,
      warnings: [],
    };
  }
  if (seen === undefined) {
    return {
      status: 'fail',
      detail: 'the transport never received a request (aspects ①–④ failed before the HTTP client)',
      warnings: [],
    };
  }
  const fails: string[] = [];
  if (seen.timeoutMs !== 3333)
    fails.push(`total→timeoutMs not transported (${ser(seen.timeoutMs)})`);
  if (seen.firstChunkTimeoutMs !== 2222) {
    fails.push(`ttft→firstChunkTimeoutMs not transported (${ser(seen.firstChunkTimeoutMs)})`);
  }
  if (seen.connectTimeoutMs !== 1111) {
    fails.push(`connect→connectTimeoutMs not transported (${ser(seen.connectTimeoutMs)})`);
  }
  if (seen.idleTimeoutMs !== 4444)
    fails.push(`idle→idleTimeoutMs not transported (${ser(seen.idleTimeoutMs)})`);
  if (fails.length > 0) return { status: 'fail', detail: fails.join(' | '), warnings: [] };
  return {
    status: 'pass',
    detail: 'all four TimeoutBudget fields map onto HttpRequest and transport verbatim',
    warnings: [],
  };
}

// --- orchestration ------------------------------------------------------------

async function runCategory(
  name: ConformanceCategory,
  run: () => Promise<CategoryOutcome> | CategoryOutcome,
): Promise<{ result: ConformanceCategoryResult; warnings: string[] }> {
  let outcome: CategoryOutcome;
  try {
    outcome = await run();
  } catch (err) {
    outcome = { status: 'fail', detail: `gate runner crashed: ${msgOf(err)}`, warnings: [] };
  }
  return {
    result: { name, status: outcome.status, detail: outcome.detail },
    warnings: outcome.warnings,
  };
}

/**
 * Run the full seven-gate suite against a subject (PURE — mock upstream,
 * in-memory, never throws). `passed` is true iff no gate FAILED (skips are
 * fine). Used directly for programmatic checks and negative-case harnesses;
 * {@link describeConformance} wraps it into vitest cases for CI.
 */
export async function runConformanceSuite(subject: ConformanceSubject): Promise<ConformanceReport> {
  const runs = [
    await runCategory('credential-injection-and-signature', () =>
      checkCredentialAndSignature(subject),
    ),
    await runCategory('parameter-mapping-and-domain', () => checkParameterMapping(subject)),
    await runCategory('media-reference-forms', () => checkMediaForms(subject)),
    await runCategory('streaming-resilience', () => checkStreamingResilience(subject)),
    await runCategory('task-status-mapping', () => checkTaskStatusMapping(subject)),
    await runCategory('error-table-completeness', () => checkErrorTableCompleteness(subject)),
    await runCategory('timeout-budget', () => checkTimeoutBudget(subject)),
  ];
  const categories = runs.map((r) => r.result);
  const warnings = runs.flatMap((r) => r.warnings);
  return {
    label: subject.label,
    passed: categories.every((c) => c.status !== 'fail'),
    categories,
    warnings,
  };
}

/**
 * Expand the seven gates into real vitest `describe/it` cases so `turbo run
 * test` enforces the gate in CI (§6 合入 CI 强制). The suite runs ONCE in a
 * `beforeAll`; each gate becomes an `it` that fails loudly with the gate detail.
 * Operations without an `expectedDraft`, and signature dialects without byte
 * vectors, additionally get a recorded `toMatchSnapshot` case (§6: 无公开向量以
 * 实测录制快照为准).
 */
export function describeConformance(subject: ConformanceSubject): void {
  describe(`conformance gate: ${subject.label}`, () => {
    let report: ConformanceReport;
    beforeAll(async () => {
      report = await runConformanceSuite(subject);
    });

    for (const name of CONFORMANCE_CATEGORIES) {
      it(`§6 gate — ${name}`, () => {
        const category = report.categories.find((c) => c.name === name);
        if (category === undefined) throw new Error(`gate ${name} missing from the report`);
        if (category.status === 'fail') throw new Error(`[${name}] FAILED: ${category.detail}`);
        expect(['pass', 'skip']).toContain(category.status);
      });
    }

    it('overall gate passes (no gate failed)', () => {
      expect(report.passed).toBe(true);
    });

    // Recorded param-mapping snapshots for operations that did not pin an expectedDraft.
    for (const op of subject.operations) {
      if (op.expectedDraft === undefined) {
        it(`recorded snapshot — aspect ① draft (${op.operation})`, () => {
          expect(mapDraft(subject.dialect, op)).toMatchSnapshot();
        });
      }
    }

    // Recorded signature snapshots for signature dialects lacking public byte vectors.
    if ((subject.signatureVectors ?? []).length === 0) {
      for (const op of subject.operations) {
        if (!isApiKeyScheme(op.secret.scheme)) {
          it(`recorded snapshot — signed headers (${op.operation})`, () => {
            expect(injectForOp(subject.dialect, op).headers ?? {}).toMatchSnapshot();
          });
        }
      }
    }
  });
}
