// packages/spi/src/dsl/engine.ts
//
// model-supply-greenfield 批次2 slice 2 — the DSL → SIX-ASPECT INTERPRETER
// (§6 作者方式: DSL 覆盖简单 REST 厂商). `compileDialect` turns a validated
// {@link DialectPack} into a slice-1 {@link Dialect}; `loadDialectPack` /
// `registerPack` are the YAML front doors.
//
// Boundaries the compiler enforces (§6 升代码切面 red line):
// - aspect ①: PURE wire-structure porterage — every placed value is read from
//   `EffectiveParams.upstream` (or `upstreamModelName`); the compiler never
//   reads `params.canonical`, never scales, never maps a value. §4.1 layer 3.
// - signature / token schemes (ak_sk / oauth) DELEGATE to the shared code
//   signer (a pack that omits `signer` is rejected here, not silently faked).
// - private framing / multi-step / WS have NO DSL expression at all, so a pack
//   simply cannot describe them — they must be authored as code aspects.
import { createHmac, timingSafeEqual } from 'node:crypto';

import type {
  CredentialSecret,
  GatewayUsage,
  Operation,
  ProviderModel,
  StreamFrame,
  TaskStatus,
  TaskUpdate,
} from '@actionow/contracts';
import { gatewayUsageSchema, OPERATIONS, taskUpdateSchema } from '@actionow/contracts';
import { parse as parseYaml } from 'yaml';

import type {
  CredentialInjectionAspect,
  Dialect,
  DialectContext,
  ErrorProbe,
  ErrorTable,
  ErrorTableMatch,
  ErrorTableRow,
  MediaDeliveryForm,
  MediaInjectionAspect,
  NormalizedResponse,
  OperationSupport,
  RawCallback,
  RequestMappingInput,
  ResolvedMediaInput,
  ResponseNormalizationAspect,
  StreamFrameResult,
  SubmitParse,
  TaskLifecycleAspect,
  WireBodyKind,
  WireMethod,
  WireRequestDraft,
  WireResponse,
} from '../aspects.js';
import { resolveError } from '../aspects.js';
import type { DialectRegistry } from '../registry.js';
import { signerCredentialInjection } from '../signers.js';
import { getPath, setPath } from './jsonpath.js';
import type {
  AuthSpec,
  BusinessErrorSpec,
  CallbackVerifySpec,
  DialectPack,
  ErrorTableSpec,
  OperationSpec,
  RequestSpec,
  ResponseSpec,
  SimpleRequestSpec,
  TaskParseSpec,
  UsageMap,
} from './schema.js';
import { dialectPackSchema } from './schema.js';

// --- small shared utilities ---------------------------------------------------

/** The reserved placement source that resolves to the offering's upstream model name. */
const MODEL_NAME_TOKEN = 'upstream_model_name';

function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function safeStringify(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * The wire STRING form of an upstream value for a path segment / query slot —
 * a serialization necessity (paths and query params are text), NOT a value
 * transform: strings pass through, scalars stringify, structured values
 * JSON-encode. Body placement never calls this (json bodies keep native types).
 */
function wireString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value);
}

function packLabel(pack: DialectPack): string {
  return `${pack.ref}@${pack.version}`;
}

/** Read a pack operation as possibly-absent (zod records over an enum key are not exhaustive). */
function opSpec(pack: DialectPack, operation: Operation): OperationSpec | undefined {
  return pack.operations[operation];
}

function operationEntries(pack: DialectPack): [Operation, OperationSpec][] {
  const out: [Operation, OperationSpec][] = [];
  for (const [key, spec] of Object.entries(pack.operations) as [
    Operation,
    OperationSpec | undefined,
  ][]) {
    if (spec !== undefined) out.push([key, spec]);
  }
  return out;
}

function operationFromCtx(ctx: DialectContext | undefined): Operation | undefined {
  const raw = ctx?.config?.operation;
  if (typeof raw !== 'string') return undefined;
  return (OPERATIONS as readonly string[]).includes(raw) ? (raw as Operation) : undefined;
}

function providerSlug(ctx: DialectContext | undefined): string | undefined {
  const raw = ctx?.config?.provider;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function hasMetrics(usage: GatewayUsage): boolean {
  return Object.keys(usage.metrics).length > 0;
}

// --- error table compilation (spec → slice-1 ErrorTable) ----------------------

function toErrorMatch(match: ErrorTableSpec['rows'][number]['match']): ErrorTableMatch {
  const out: ErrorTableMatch = {};
  if (match.httpStatus !== undefined) out.httpStatus = match.httpStatus;
  if (match.upstreamCode !== undefined) out.upstreamCode = match.upstreamCode;
  if (match.messageIncludes !== undefined) out.messageIncludes = match.messageIncludes;
  if (match.kind !== undefined) out.kind = match.kind;
  return out;
}

function toErrorTable(spec: ErrorTableSpec): ErrorTable {
  const rows: ErrorTableRow[] = spec.rows.map((row) => ({
    code: row.code,
    retryable: row.retryable,
    failover: row.failover,
    match: toErrorMatch(row.match),
  }));
  return {
    rows,
    fallback: {
      code: spec.fallback.code,
      retryable: spec.fallback.retryable,
      failover: spec.fallback.failover,
    },
  };
}

// --- usage / business-error extraction (aspect ⑤ shared) ----------------------

function extractUsage(map: UsageMap | undefined, body: unknown): GatewayUsage {
  const metrics: Record<string, number> = {};
  if (map !== undefined) {
    for (const [metric, path] of Object.entries(map)) {
      const value = getPath(body, path);
      if (typeof value === 'number' && Number.isFinite(value)) metrics[metric] = value;
    }
  }
  return gatewayUsageSchema.parse({ metrics });
}

function detectBusinessError(spec: BusinessErrorSpec | undefined, body: unknown): boolean {
  if (spec === undefined) return false;
  if (spec.errorWhenPresent !== undefined) {
    const value = getPath(body, spec.errorWhenPresent);
    if (value !== undefined && value !== null) return true;
  }
  if (spec.successField !== undefined) {
    const value = getPath(body, spec.successField);
    if (!value) return true;
  }
  return false;
}

function extractCode(spec: BusinessErrorSpec | undefined, body: unknown): string | undefined {
  if (spec?.codePath === undefined) return undefined;
  const value = getPath(body, spec.codePath);
  return value === undefined || value === null ? undefined : wireString(value);
}

function extractMessage(spec: BusinessErrorSpec | undefined, body: unknown): string | undefined {
  if (spec?.messagePath === undefined) return undefined;
  const value = getPath(body, spec.messagePath);
  if (typeof value === 'string') return value;
  return value === undefined || value === null ? undefined : wireString(value);
}

function httpErrorProbe(
  response: ResponseSpec,
  res: WireResponse,
  ctx: DialectContext,
): ErrorProbe {
  const probe: ErrorProbe = { httpStatus: res.status };
  const provider = providerSlug(ctx);
  if (provider !== undefined) probe.provider = provider;
  const code = extractCode(response.businessError, res.body);
  if (code !== undefined) probe.upstreamCode = code;
  const message =
    extractMessage(response.businessError, res.body) ?? res.text ?? safeStringify(res.body);
  if (message !== undefined) probe.message = message;
  return probe;
}

/** A 200-carried business error is matched on code/message ONLY (200 is not an error status). */
function businessErrorProbe(
  response: ResponseSpec,
  body: unknown,
  ctx: DialectContext | undefined,
): ErrorProbe {
  const probe: ErrorProbe = {};
  const provider = providerSlug(ctx);
  if (provider !== undefined) probe.provider = provider;
  const code = extractCode(response.businessError, body);
  if (code !== undefined) probe.upstreamCode = code;
  const message = extractMessage(response.businessError, body);
  if (message !== undefined) probe.message = message;
  return probe;
}

// --- aspect ①: request mapping (STRUCTURE ONLY, §4.1 layer 3) ------------------

function resolvePathTemplate(template: string, input: RequestMappingInput): string {
  const upstream = input.params.upstream;
  return template.replace(/\{([^}]+)\}/g, (_match: string, token: string): string => {
    if (token === MODEL_NAME_TOKEN) return input.upstreamModelName;
    if (token.startsWith('param:')) {
      const name = token.slice('param:'.length);
      const value = upstream[name];
      return value === undefined || value === null ? '' : wireString(value);
    }
    throw new TypeError(`unknown path placeholder "{${token}}"`);
  });
}

/**
 * Build the aspect-① {@link WireRequestDraft} from a {@link RequestSpec}. RED
 * LINE: values come SOLELY from `input.params.upstream` (or `upstreamModelName`)
 * — `params.canonical` is never read; no value is scaled, mapped, or
 * conditioned. Absent upstream params are skipped (no null holes).
 */
function buildRequestDraft(spec: RequestSpec, input: RequestMappingInput): WireRequestDraft {
  const upstream = input.params.upstream;
  const hasBody = spec.body !== undefined && Object.keys(spec.body).length > 0;
  const bodyKind: WireBodyKind = spec.bodyKind ?? (hasBody ? 'json' : 'none');
  const method: WireMethod = spec.method ?? 'POST';
  const draft: WireRequestDraft = {
    method,
    path: resolvePathTemplate(spec.path, input),
    bodyKind,
  };

  if (spec.headers !== undefined && Object.keys(spec.headers).length > 0) {
    draft.headers = { ...spec.headers };
  }

  if (spec.query !== undefined) {
    const query: Record<string, string> = {};
    for (const [param, key] of Object.entries(spec.query)) {
      const value = param === MODEL_NAME_TOKEN ? input.upstreamModelName : upstream[param];
      if (value === undefined || value === null) continue;
      query[key] = wireString(value);
    }
    if (Object.keys(query).length > 0) draft.query = query;
  }

  if (bodyKind === 'json' && spec.body !== undefined) {
    const body: Record<string, unknown> = {};
    for (const [param, jsonPath] of Object.entries(spec.body)) {
      const value = param === MODEL_NAME_TOKEN ? input.upstreamModelName : upstream[param];
      if (value === undefined) continue; // skip absent; an explicit null IS placed
      setPath(body, jsonPath, value);
    }
    draft.body = body;
  }

  return draft;
}

function resolveTaskPathTemplate(template: string, taskId: string): string {
  return template.replace(/\{([^}]+)\}/g, (_match: string, token: string): string => {
    if (token === 'task_id') return taskId;
    throw new TypeError(`unknown task path placeholder "{${token}}"`);
  });
}

function buildSimpleDraft(
  spec: SimpleRequestSpec,
  path: string,
  defaultMethod: WireMethod,
): WireRequestDraft {
  const bodyKind: WireBodyKind = spec.bodyKind ?? (spec.body !== undefined ? 'json' : 'none');
  const draft: WireRequestDraft = { method: spec.method ?? defaultMethod, path, bodyKind };
  if (spec.headers !== undefined && Object.keys(spec.headers).length > 0) {
    draft.headers = { ...spec.headers };
  }
  if (spec.query !== undefined && Object.keys(spec.query).length > 0) {
    draft.query = { ...spec.query };
  }
  if (bodyKind === 'json' && spec.body !== undefined) draft.body = spec.body;
  return draft;
}

// --- aspect ②: media injection ------------------------------------------------

function mediaValue(media: ResolvedMediaInput): string {
  if (media.form === 'url') {
    if (media.url === undefined) {
      throw new TypeError(`media input for "${media.param}" is form=url but carries no url`);
    }
    return media.url;
  }
  if (media.bytes === undefined) {
    throw new TypeError(`media input for "${media.param}" is form=base64 but carries no bytes`);
  }
  return Buffer.from(media.bytes).toString('base64');
}

function buildMediaInjection(pack: DialectPack): MediaInjectionAspect | undefined {
  const placements = new Map<string, string>();
  const forms = new Set<MediaDeliveryForm>();
  for (const [, spec] of operationEntries(pack)) {
    const media = spec.request.media;
    if (media === undefined) continue;
    for (const form of media.deliveryForms) forms.add(form);
    for (const placement of media.placements) {
      const existing = placements.get(placement.param);
      if (existing !== undefined && existing !== placement.path) {
        throw new TypeError(
          `dialect ${packLabel(pack)} declares conflicting media placements for "${placement.param}" ("${existing}" vs "${placement.path}")`,
        );
      }
      placements.set(placement.param, placement.path);
    }
  }
  if (placements.size === 0) return undefined;

  const deliveryForms: readonly MediaDeliveryForm[] = [...forms];
  return {
    deliveryForms,
    inject(draft, media) {
      const body: Record<string, unknown> = isPlainObject(draft.body) ? { ...draft.body } : {};
      for (const item of media) {
        const path = placements.get(item.param);
        if (path === undefined) {
          throw new TypeError(
            `dialect ${packLabel(pack)} has no media placement for param "${item.param}"`,
          );
        }
        setPath(body, path, mediaValue(item));
      }
      return { ...draft, bodyKind: 'json', body };
    },
  };
}

// --- aspect ③: credential injection -------------------------------------------

function defaultCredentialName(scheme: AuthSpec['scheme']): string {
  if (scheme === 'x_api_key') return 'x-api-key';
  if (scheme === 'query') return 'key';
  return 'Authorization';
}

function apiKeyOf(secret: CredentialSecret): string | undefined {
  return secret.scheme === 'bearer' || secret.scheme === 'x_api_key' || secret.scheme === 'query'
    ? secret.api_key
    : undefined;
}

function buildCredentialInjection(pack: DialectPack, auth: AuthSpec): CredentialInjectionAspect {
  if (auth.scheme === 'ak_sk' || auth.scheme === 'oauth') {
    if (auth.signer === undefined) {
      throw new TypeError(
        `dialect ${packLabel(pack)} auth scheme "${auth.scheme}" needs a code signer — declare auth.signer (a registered SignerStrategy); the DSL cannot express signature/token algorithms`,
      );
    }
    return signerCredentialInjection(auth.signer);
  }

  const placement = auth.placement ?? {};
  const where: 'header' | 'query' = placement.in ?? (auth.scheme === 'query' ? 'query' : 'header');
  const name = placement.name ?? defaultCredentialName(auth.scheme);
  const prefix = placement.prefix ?? (auth.scheme === 'bearer' ? 'Bearer ' : '');

  return {
    injectCredential(draft, secret) {
      const apiKey = apiKeyOf(secret);
      if (apiKey === undefined) {
        throw new TypeError(
          `dialect ${packLabel(pack)} auth scheme "${auth.scheme}" expects an api-key credential (bearer/x_api_key/query); got secret scheme "${secret.scheme}"`,
        );
      }
      const value = `${prefix}${apiKey}`;
      if (where === 'query') {
        return { ...draft, query: { ...(draft.query ?? {}), [name]: value } };
      }
      return { ...draft, headers: { ...(draft.headers ?? {}), [name]: value } };
    },
  };
}

// --- aspect ⑤: response normalization -----------------------------------------

/**
 * Select the operation's response spec. Aspect ⑤ never receives the operation
 * directly (slice-1 interface), so: use `ctx.config.operation` when the caller
 * pins it; else the UNIQUE direct/stream operation (the common case — the mock);
 * else, ambiguously, throw so the caller must disambiguate.
 */
function resolveResponseSpec(pack: DialectPack, ctx: DialectContext | undefined): ResponseSpec {
  const pinned = operationFromCtx(ctx);
  if (pinned !== undefined) {
    const spec = opSpec(pack, pinned);
    if (spec !== undefined) return spec.response;
  }
  const buffered = operationEntries(pack).filter(
    ([, spec]) => spec.fetchModes.includes('direct') || spec.fetchModes.includes('stream'),
  );
  if (buffered.length === 1) {
    const only = buffered[0];
    if (only !== undefined) return only[1].response;
  }
  const first = operationEntries(pack)[0];
  if (buffered.length === 0 && first !== undefined) return first[1].response;
  throw new TypeError(
    `dialect ${packLabel(pack)} has ${String(buffered.length)} direct/stream operations; set ctx.config.operation to select the response spec`,
  );
}

function buildResponseNormalization(pack: DialectPack): ResponseNormalizationAspect {
  return {
    normalize(res, ctx): NormalizedResponse {
      const response = resolveResponseSpec(pack, ctx);
      const table = toErrorTable(response.errorTable ?? pack.errorTable);
      if (!is2xx(res.status)) {
        return { ok: false, error: resolveError(table, httpErrorProbe(response, res, ctx)) };
      }
      if (detectBusinessError(response.businessError, res.body)) {
        return {
          ok: false,
          error: resolveError(table, businessErrorProbe(response, res.body, ctx)),
        };
      }
      const output = response.output !== undefined ? getPath(res.body, response.output) : res.body;
      return { ok: true, output, usage: extractUsage(response.usage, res.body) };
    },
    normalizeStreamFrame(rawFrame): StreamFrameResult {
      const response = resolveResponseSpec(pack, undefined);
      const doneSentinel = response.stream?.doneSentinel ?? '[DONE]';
      if (rawFrame === doneSentinel) return [{ kind: 'done' }];
      const frames: StreamFrame[] = [];
      const usageMap = response.stream?.usage;
      if (usageMap !== undefined) {
        const parsed = tryParseJson(rawFrame);
        if (parsed !== undefined) {
          const usage = extractUsage(usageMap, parsed);
          if (hasMetrics(usage)) frames.push({ kind: 'usage', usage });
        }
      }
      frames.push({ kind: 'delta', payload: rawFrame });
      return frames;
    },
  };
}

// --- aspect ⑥: task lifecycle -------------------------------------------------

function taskCapableOps(pack: DialectPack): [Operation, OperationSpec][] {
  return operationEntries(pack).filter(([, spec]) => spec.task !== undefined);
}

/** Select the task-capable operation (same disambiguation rule as {@link resolveResponseSpec}). */
function resolveTaskOp(pack: DialectPack, ctx: DialectContext | undefined): OperationSpec {
  const pinned = operationFromCtx(ctx);
  if (pinned !== undefined) {
    const spec = opSpec(pack, pinned);
    if (spec?.task !== undefined) return spec;
  }
  const taskOps = taskCapableOps(pack);
  const only = taskOps[0];
  if (taskOps.length === 1 && only !== undefined) return only[1];
  throw new TypeError(
    `dialect ${packLabel(pack)} has ${String(taskOps.length)} task operations; set ctx.config.operation to select the task spec`,
  );
}

function buildTaskUpdate(cfg: TaskParseSpec, body: unknown): TaskUpdate {
  const rawId = getPath(body, cfg.taskIdPath);
  const rawStatusValue = getPath(body, cfg.statusPath);
  const rawStatus =
    rawStatusValue === undefined || rawStatusValue === null
      ? undefined
      : wireString(rawStatusValue);
  const mapped = rawStatus !== undefined ? cfg.statusMap[rawStatus] : undefined;
  const status: TaskStatus = mapped ?? cfg.unknownStatus ?? 'running';

  const update: Record<string, unknown> = {
    upstreamTaskId: rawId === undefined || rawId === null ? '' : wireString(rawId),
    status,
  };
  if (rawStatus !== undefined) update.rawStatus = rawStatus; // §6: preserve verbatim
  if (cfg.outputPath !== undefined) {
    const output = getPath(body, cfg.outputPath);
    if (output !== undefined) update.output = output;
  }
  const usage = extractUsage(cfg.usage, body);
  if (hasMetrics(usage)) update.usage = usage;
  if (cfg.progressPath !== undefined) {
    const progress = getPath(body, cfg.progressPath);
    if (typeof progress === 'number') update.progress = progress;
  }
  if (status === 'failed') {
    const message =
      cfg.errorMessagePath !== undefined ? getPath(body, cfg.errorMessagePath) : undefined;
    update.error = {
      code: 'task_failed',
      message: typeof message === 'string' ? message : 'upstream task failed',
      retryable: false,
      failover: false,
    };
  }
  return taskUpdateSchema.parse(update);
}

function verifyHmacCallback(
  verify: CallbackVerifySpec,
  raw: RawCallback,
  ctx: DialectContext,
): boolean {
  const signature = raw.headers[(verify.signatureHeader ?? 'x-signature').toLowerCase()];
  const timestamp = raw.headers[(verify.timestampHeader ?? 'x-timestamp').toLowerCase()];
  if (signature === undefined || timestamp === undefined) return false;

  const secretKey = verify.secretConfigKey ?? 'callbackSecret';
  const secret = ctx.config?.[secretKey];
  if (typeof secret !== 'string' || secret.length === 0) return false;

  const tsNumber = Number(timestamp);
  if (!Number.isFinite(tsNumber)) return false;
  const tsMs = tsNumber > 1e12 ? tsNumber : tsNumber * 1000; // tolerate seconds or ms
  const windowMs = verify.windowMs ?? 300_000;
  if (Math.abs(ctx.nowMs - tsMs) > windowMs) return false;

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${raw.rawBody}`, 'utf8')
    .digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const gotBuf = Buffer.from(signature, 'utf8');
  if (expectedBuf.length !== gotBuf.length) return false;
  return timingSafeEqual(expectedBuf, gotBuf);
}

function buildTaskLifecycle(pack: DialectPack): TaskLifecycleAspect | undefined {
  if (taskCapableOps(pack).length === 0) return undefined;

  return {
    buildSubmit(input): WireRequestDraft {
      const spec = opSpec(pack, input.operation);
      if (spec === undefined) {
        throw new TypeError(`dialect ${packLabel(pack)} has no operation "${input.operation}"`);
      }
      return buildRequestDraft(spec.request, input);
    },
    parseSubmitResponse(res): SubmitParse {
      const operation = resolveTaskOp(pack, undefined);
      const task = operation.task;
      if (task === undefined) {
        throw new TypeError(`dialect ${packLabel(pack)} resolved a non-task operation for submit`);
      }
      const body = res.body;
      if (detectBusinessError(operation.response.businessError, body)) {
        const table = toErrorTable(operation.response.errorTable ?? pack.errorTable);
        return {
          error: resolveError(table, businessErrorProbe(operation.response, body, undefined)),
        };
      }
      const inlinePath = task.submit.response.inlinePath;
      if (inlinePath !== undefined) {
        const inline = getPath(body, inlinePath);
        if (inline !== undefined && inline !== null) {
          return {
            inline: { output: inline, usage: extractUsage(task.submit.response.usage, body) },
          };
        }
      }
      const id = getPath(body, task.submit.response.taskIdPath);
      if (id === undefined || id === null) {
        throw new TypeError(`submit response has no task id at ${task.submit.response.taskIdPath}`);
      }
      return { upstreamTaskId: wireString(id) };
    },
    buildQuery(upstreamTaskId, ctx): WireRequestDraft {
      const task = resolveTaskOp(pack, ctx).task;
      if (task === undefined) {
        throw new TypeError(`dialect ${packLabel(pack)} resolved a non-task operation for query`);
      }
      const path = resolveTaskPathTemplate(task.query.request.path, upstreamTaskId);
      return buildSimpleDraft(task.query.request, path, 'GET');
    },
    parseQueryResponse(res): TaskUpdate {
      const task = resolveTaskOp(pack, undefined).task;
      if (task === undefined) {
        throw new TypeError(`dialect ${packLabel(pack)} resolved a non-task operation for query`);
      }
      return buildTaskUpdate(task.query, res.body);
    },
    verifyCallback(raw, _secret, ctx): boolean {
      const task = resolveTaskOp(pack, ctx).task;
      const callback = task?.callback;
      if (callback === undefined) return false; // no callback declared → cannot verify
      if (callback.verify.strategy === 'none') return true;
      return verifyHmacCallback(callback.verify, raw, ctx);
    },
    parseCallback(raw): TaskUpdate {
      const task = resolveTaskOp(pack, undefined).task;
      const callback = task?.callback;
      if (callback === undefined) {
        throw new TypeError(`dialect ${packLabel(pack)} declares no callback spec`);
      }
      return buildTaskUpdate(callback, JSON.parse(raw.rawBody));
    },
  };
}

// --- assembly & front doors ---------------------------------------------------

/**
 * Compile a validated {@link DialectPack} into a slice-1 {@link Dialect}. Throws
 * a {@link TypeError} on an authoring defect the DSL cannot express (ak_sk /
 * oauth without a signer, conflicting media placements) — the "升代码切面" gate.
 */
export function compileDialect(pack: DialectPack): Dialect {
  const operations: Partial<Record<Operation, OperationSupport>> = {};
  for (const [operation, spec] of operationEntries(pack)) {
    operations[operation] = { fetchModes: [...spec.fetchModes] };
  }

  const dialect: Dialect = {
    ref: pack.ref,
    version: pack.version,
    operations,
    requestMapping: {
      map: (input) => {
        const spec = opSpec(pack, input.operation);
        if (spec === undefined) {
          throw new TypeError(`dialect ${packLabel(pack)} has no operation "${input.operation}"`);
        }
        return buildRequestDraft(spec.request, input);
      },
    },
    credentialInjection: buildCredentialInjection(pack, pack.auth),
    responseNormalization: buildResponseNormalization(pack),
    errorTable: toErrorTable(pack.errorTable),
  };

  const mediaInjection = buildMediaInjection(pack);
  if (mediaInjection !== undefined) dialect.mediaInjection = mediaInjection;
  const taskLifecycle = buildTaskLifecycle(pack);
  if (taskLifecycle !== undefined) dialect.taskLifecycle = taskLifecycle;

  return dialect;
}

/** Deserialize + validate a YAML dialect pack; throws with the pack's `ref@version` on any schema error. */
export function loadDialectPack(yamlText: string): DialectPack {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    throw new Error(
      `failed to parse dialect pack YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const result = dialectPackSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`invalid dialect pack ${describePackRef(raw)}: ${result.error.message}`);
  }
  return result.data;
}

function describePackRef(raw: unknown): string {
  if (isPlainObject(raw)) {
    const ref = typeof raw.ref === 'string' ? raw.ref : '?';
    const version = typeof raw.version === 'string' ? raw.version : '?';
    return `${ref}@${version}`;
  }
  return '?@?';
}

/** Load → compile → register a YAML pack into a {@link DialectRegistry}; returns the compiled dialect. */
export function registerPack(registry: DialectRegistry, yamlText: string): Dialect {
  const dialect = compileDialect(loadDialectPack(yamlText));
  registry.register(dialect);
  return dialect;
}

/**
 * Build the discovery endpoint request draft (§10) — pure, no HTTP. Returns
 * `undefined` when the pack declares no discovery endpoint.
 */
export function buildDiscoveryRequest(pack: DialectPack): WireRequestDraft | undefined {
  if (pack.discovery === undefined) return undefined;
  return buildSimpleDraft(pack.discovery.request, pack.discovery.request.path, 'GET');
}

/**
 * Parse a discovery response body into {@link ProviderModel}s using the pack's
 * `modelsPath` / `idPath` / `displayNamePath` (§6 discovery 声明). Pure; a
 * missing array or an item without a string id is skipped. Empty when the pack
 * declares no discovery endpoint.
 */
export function parseDiscoveredModels(pack: DialectPack, body: unknown): ProviderModel[] {
  const discovery = pack.discovery;
  if (discovery === undefined) return [];
  const list = getPath(body, discovery.modelsPath);
  if (!Array.isArray(list)) return [];
  const out: ProviderModel[] = [];
  for (const item of list) {
    const id = getPath(item, discovery.idPath);
    if (typeof id !== 'string' || id.length === 0) continue;
    const model: ProviderModel = { id };
    if (discovery.displayNamePath !== undefined) {
      const displayName = getPath(item, discovery.displayNamePath);
      if (typeof displayName === 'string') model.displayName = displayName;
    }
    out.push(model);
  }
  return out;
}
