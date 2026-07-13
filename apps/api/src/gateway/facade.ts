// apps/api/src/gateway/facade.ts
//
// model-supply-greenfield 批次4 slice3 — the dialect FACADE's §4.1 LAYER-1
// canonical 归一 for the task/media-paradigm wire shapes (§5 资源风格创建 +
// /v1/tasks 语法糖). This layer does EXACTLY one thing: normalize the wire
// body onto the model's canonical param contract —
//
//   - names/types/domains are validated against the CANONICAL contract only
//     (the model's operation params, §4);
//   - an omitted param with a canonical default rides along tagged
//     `isDefault: true` (§4.1: "缺省参数携带 canonical 默认值但打 is_default
//     标记") — defaults are NOT resolved further here;
//   - explicit params are tagged `isDefault: false`;
//   - file/media params are extracted into `mediaRefs` (§6 aspect ② input);
//   - envelope keys (model/type/stream/callback_url/artifact_mode/
//     require_persist) become `GatewayRequestOptions`, never params.
//
// It does NO offering-declaration work (no domain clamps, no map/fixed — §4.1
// layer 2 is the planner's) and NO upstream I/O (executeGateway's). Pure
// functions, Result-typed — the controller maps errors to HTTP.
import { createHash } from 'node:crypto';

import type {
  CanonicalParam,
  CanonicalParamValue,
  GatewayError,
  GatewayRequest,
  GatewayRequestOptions,
  MediaRef,
  MediaRefSource,
  ModelOperation,
  Operation,
} from '@actionow/contracts';
import { GATEWAY_RESERVED_WIRE_KEYS } from '@actionow/contracts';

// --- inputs & result -------------------------------------------------------------

/** The authenticated caller identity the facade stamps onto the IR (§2.6). */
export interface FacadeAuth {
  tenantId: string;
  /** REQUIRED by the frozen IR (attribution + (tenant, key) idempotency scope). */
  apiKeyId: string;
  subjectId?: string | undefined;
}

/** One facade parse: wire body + route-derived operation + contract + identity. */
export interface FacadeInput {
  operation: Operation;
  /** The model's EXTERNAL name (already resolved/visible — the controller's lookup). */
  modelName: string;
  /** The model's canonical contract FOR this operation (§4 挂模型). */
  contract: ModelOperation;
  /** The zod-passthrough wire body (envelope keys + canonical params). */
  body: Record<string, unknown>;
  auth: FacadeAuth;
  /** The `Idempotency-Key` header, when the caller sent one (§5). */
  idempotencyKey?: string | undefined;
  /** The X-Actionow-Route-Tag narrow-only pin (§8 — task 路径与同步对齐). */
  routeTag?: string | undefined;
}

export type FacadeResult =
  | { ok: true; request: GatewayRequest }
  | { ok: false; error: GatewayError };

// --- §5 body fingerprint -----------------------------------------------------------

/**
 * sha256 hex over the CANONICALIZED request body (§5 键值映射带请求体指纹).
 * Canonicalization = recursively key-sorted JSON, so two bodies with the same
 * content but different key order fingerprint identically (the
 * idempotency.interceptor `fingerprintBody` 范式, hardened with stable key
 * order — "规范化请求体").
 */
export function fingerprintBody(body: unknown): string {
  return createHash('sha256')
    .update(stableStringify(body ?? null))
    .digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    // Primitives (and non-serializable exotics) — `JSON.stringify` is TYPED
    // `string` but really yields undefined for bare functions/symbols; assert
    // the honest type (the clipTaskEventPayload precedent) and map those to a
    // constant marker.
    const json = JSON.stringify(value) as string | undefined;
    return json ?? '"non-serializable"';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

// --- the layer-1 canonical 归一 -----------------------------------------------------

const RESERVED = new Set<string>(GATEWAY_RESERVED_WIRE_KEYS);

/**
 * Normalize one wire create-body into the frozen {@link GatewayRequest} IR
 * (§4.1 layer 1). See the module header for exactly what this layer owns.
 */
export function toGatewayRequest(input: FacadeInput): FacadeResult {
  const params: Record<string, CanonicalParamValue> = {};
  const mediaRefs: MediaRef[] = [];

  const known = new Set(input.contract.params.map((p) => p.name));
  const unknown = Object.keys(input.body).filter((k) => !RESERVED.has(k) && !known.has(k));
  if (unknown.length > 0) {
    return invalid(
      `unknown parameter${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `'${k}'`).join(', ')} for operation '${input.operation}'`,
      { unknownParams: unknown },
    );
  }

  for (const param of input.contract.params) {
    const raw = input.body[param.name];
    if (raw === undefined) {
      if (param.default !== undefined) {
        // §4.1 layer 1: the canonical default RIDES ALONG, marked isDefault —
        // §4 rule 2 (billing_relevant) filters on it; rule 3 exempts the rest.
        params[param.name] = { value: param.default, isDefault: true };
      } else if (param.required) {
        return invalid(`missing required parameter '${param.name}'`, { param: param.name });
      }
      continue;
    }
    const checked = checkCanonical(param, raw);
    if (!checked.ok) return checked;
    params[param.name] = { value: raw, isDefault: false };
    if (param.type === 'file' || param.type === 'media') {
      collectMediaRefs(mediaRefs, param, raw);
    }
  }

  const options = optionsOf(input.body, input.routeTag);

  const request: GatewayRequest = {
    tenantId: input.auth.tenantId,
    apiKeyId: input.auth.apiKeyId,
    ...(input.auth.subjectId !== undefined ? { subjectId: input.auth.subjectId } : {}),
    operation: input.operation,
    model: input.modelName,
    params,
    mediaRefs,
    options,
    ...(input.idempotencyKey !== undefined
      ? {
          idempotency: {
            key: input.idempotencyKey,
            bodyFingerprint: fingerprintBody(input.body),
          },
        }
      : {}),
  };
  return { ok: true, request };
}

/** Envelope keys → {@link GatewayRequestOptions} (validated shapes come from the wire zod schema). */
function optionsOf(
  body: Record<string, unknown>,
  routeTag: string | undefined,
): GatewayRequestOptions {
  const options: GatewayRequestOptions = {};
  if (body.stream === true) options.stream = true;
  if (typeof body.callback_url === 'string') options.callbackUrl = body.callback_url;
  if (body.artifact_mode === 'signed' || body.artifact_mode === 'public') {
    options.artifactMode = body.artifact_mode;
  }
  if (typeof body.require_persist === 'boolean') options.requirePersist = body.require_persist;
  if (routeTag !== undefined) options.routeTag = routeTag;
  return options;
}

// --- canonical type/domain validation ------------------------------------------------

export type CheckResult = { ok: true } | { ok: false; error: GatewayError };

/**
 * Validate one EXPLICIT wire value against the CANONICAL contract (name is the
 * caller's own — the resource-style wire vocabulary IS the canonical snake_case
 * vocabulary; alias mapping belongs to the chat/OpenAI dialect facade,
 * chat-facade.ts, which REUSES this validator). `multiple: true` accepts an
 * array of items, each item-validated.
 */
export function checkCanonical(param: CanonicalParam, raw: unknown): CheckResult {
  if (param.multiple === true) {
    if (!Array.isArray(raw)) {
      return invalid(`parameter '${param.name}' expects an array`, { param: param.name });
    }
    for (const item of raw) {
      const checked = checkScalar(param, item);
      if (!checked.ok) return checked;
    }
    return { ok: true };
  }
  return checkScalar(param, raw);
}

function checkScalar(param: CanonicalParam, value: unknown): CheckResult {
  switch (param.type) {
    case 'float':
    case 'int': {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        return badType(param, 'a number');
      }
      if (param.type === 'int' && !Number.isInteger(value)) {
        return badType(param, 'an integer');
      }
      if (param.min !== undefined && value < param.min) {
        return domainViolation(param, value, `>= ${String(param.min)}`);
      }
      if (param.max !== undefined && value > param.max) {
        return domainViolation(param, value, `<= ${String(param.max)}`);
      }
      if (param.values !== undefined && !param.values.some((v) => v === value)) {
        return domainViolation(param, value, `one of ${param.values.join(', ')}`);
      }
      return { ok: true };
    }
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true } : badType(param, 'a boolean');
    case 'string':
    case 'enum': {
      if (typeof value !== 'string') return badType(param, 'a string');
      if (param.values !== undefined && !param.values.some((v) => v === value)) {
        return domainViolation(param, value, `one of ${param.values.join(', ')}`);
      }
      return { ok: true };
    }
    case 'json':
      return { ok: true };
    case 'file':
    case 'media':
      return typeof value === 'string' && value.length > 0
        ? { ok: true }
        : badType(param, 'a non-empty string (URL / base64 / file id)');
  }
}

// --- media refs (§6 aspect ② input) ----------------------------------------------------

/**
 * How the CALLER referenced the medium: http(s) → `url`, `file_…` → `file_id`
 * (the /v1/files vocabulary), anything else (incl. data: URIs) → `base64`.
 * Upstream delivery form is aspect ②'s dialect-declared choice, not this.
 */
function mediaSourceOf(value: string): MediaRefSource {
  if (/^https?:\/\//i.test(value)) return 'url';
  if (value.startsWith('file_')) return 'file_id';
  return 'base64';
}

function collectMediaRefs(refs: MediaRef[], param: CanonicalParam, raw: unknown): void {
  const items = Array.isArray(raw) ? raw : [raw];
  for (const item of items) {
    if (typeof item !== 'string' || item.length === 0) continue; // checkCanonical already rejected
    const data = item.startsWith('data:') ? item.slice(item.indexOf(',') + 1) : item;
    const mime = item.startsWith('data:') ? item.slice(5, item.indexOf(';')) : undefined;
    refs.push({
      param: param.name,
      source: mediaSourceOf(item),
      data: data.length > 0 ? data : item,
      ...(mime !== undefined && mime.length > 0 ? { mime } : {}),
    });
  }
}

// --- error helpers ------------------------------------------------------------------

function invalid(
  message: string,
  details?: Record<string, unknown>,
): { ok: false; error: GatewayError } {
  return {
    ok: false,
    error: {
      code: 'invalid_input',
      message,
      retryable: false,
      failover: false,
      ...(details !== undefined ? { details } : {}),
    },
  };
}

function badType(param: CanonicalParam, expected: string): { ok: false; error: GatewayError } {
  return invalid(`parameter '${param.name}' expects ${expected}`, { param: param.name });
}

function domainViolation(
  param: CanonicalParam,
  value: unknown,
  expected: string,
): { ok: false; error: GatewayError } {
  return invalid(
    `parameter '${param.name}' value ${JSON.stringify(value)} is outside the model contract (expected ${expected})`,
    { param: param.name },
  );
}
