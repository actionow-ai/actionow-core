// packages/spi/src/dsl/schema.ts
//
// model-supply-greenfield 批次2 slice 2 — the DSL PACK CONTRACT (§6 作者方式:
// DSL 覆盖简单 REST 厂商). A `dialectPackSchema` is the zod shape a YAML pack
// deserializes into; `engine.ts` compiles it into the slice-1 six-aspect
// {@link Dialect}. The DSL describes ONLY aspect ①'s wire STRUCTURE porterage
// (§4.1 layer 3) — field placement, status/usage/error extraction paths, task
// declarations — and structurally has NO slot for value scaling / semantic
// mapping / conditional transforms (those are §4.1 layer 2, the planner's job)
// nor for the four "must be code" aspects (signature algorithms, private
// framing, multi-step, WS): signature/token schemes only DECLARE which shared
// signer to use, and there is no framing/step/WS field at all.
import {
  AUTH_SCHEMES,
  FETCH_MODES,
  GATEWAY_ERROR_CODES,
  operationSchema,
  taskStatusSchema,
} from '@actionow/contracts';
import { z } from 'zod';

import {
  ERROR_PROBE_KINDS,
  MEDIA_DELIVERY_FORMS,
  WIRE_BODY_KINDS,
  WIRE_METHODS,
} from '../aspects.js';
import { SIGNER_STRATEGIES } from '../signers.js';

// --- shared leaf schemas ------------------------------------------------------

/**
 * A metric-extraction map: normalized metric name (input_tokens / images /
 * video_seconds …) → the {@link getPath} json path of its value in the upstream
 * response (§9.2 usage 提取). Only finite-number values are metered; anything
 * else at the path is ignored.
 */
export const usageMapSchema = z.record(z.string().min(1), z.string().min(1));
export type UsageMap = z.infer<typeof usageMapSchema>;

// --- error table (§6-⑤ per-provider 错误码表 → 统一 taxonomy) --------------------

/** One error-table row's match conditions — maps 1:1 onto slice-1 `ErrorTableMatch`. */
export const errorMatchSpecSchema = z.object({
  /** Exact HTTP status, or an inclusive `[lo, hi]` range. */
  httpStatus: z.union([z.number().int(), z.tuple([z.number().int(), z.number().int()])]).optional(),
  /** The provider's verbatim error code (exact match). */
  upstreamCode: z.string().optional(),
  /** Case-insensitive substring of the upstream message. */
  messageIncludes: z.string().optional(),
  /** Pin to a probe kind (http / timeout / network). */
  kind: z.enum(ERROR_PROBE_KINDS).optional(),
});
export type ErrorMatchSpec = z.infer<typeof errorMatchSpecSchema>;

/** The classification a row (or the fallback) assigns — unified code + the two independent §9.3 flags. */
export const errorDispositionSpecSchema = z.object({
  code: z.enum(GATEWAY_ERROR_CODES),
  retryable: z.boolean(),
  failover: z.boolean(),
});
export type ErrorDispositionSpec = z.infer<typeof errorDispositionSpecSchema>;

export const errorRowSpecSchema = errorDispositionSpecSchema.extend({
  match: errorMatchSpecSchema.default({}),
});
export type ErrorRowSpec = z.infer<typeof errorRowSpecSchema>;

/**
 * A total per-provider error table (§6-⑤): first matching row wins, else the
 * mandatory `fallback`. Compiles straight into slice-1's `ErrorTable`.
 */
export const errorTableSpecSchema = z.object({
  rows: z.array(errorRowSpecSchema).default([]),
  fallback: errorDispositionSpecSchema,
});
export type ErrorTableSpec = z.infer<typeof errorTableSpecSchema>;

// --- auth template (§6-③) -----------------------------------------------------

/** Where an api-key credential is placed for bearer / x_api_key / query schemes. */
export const authPlacementSchema = z.object({
  /** `header` (default for bearer / x_api_key) or `query` (default for query scheme). */
  in: z.enum(['header', 'query']).optional(),
  /** Header name or query key (default: Authorization / x-api-key / key by scheme). */
  name: z.string().min(1).optional(),
  /** Value prefix (default `'Bearer '` for bearer, empty otherwise). */
  prefix: z.string().optional(),
});
export type AuthPlacement = z.infer<typeof authPlacementSchema>;

/**
 * The channel auth template (§2.3 / §6-③). `bearer` / `x_api_key` / `query`
 * place the api key directly (`placement`). `ak_sk` / `oauth` are SIGNATURE /
 * TOKEN schemes — the DSL only NAMES the shared signer to delegate to
 * (`signer`); the algorithm itself is a code aspect (signers.ts). A pack that
 * leaves `signer` unset for ak_sk/oauth is rejected at compile time.
 */
export const authSpecSchema = z.object({
  scheme: z.enum(AUTH_SCHEMES),
  placement: authPlacementSchema.optional(),
  signer: z.enum(SIGNER_STRATEGIES).optional(),
});
export type AuthSpec = z.infer<typeof authSpecSchema>;

// --- aspect ①: request mapping (§6-①, §4.1 layer 3 — STRUCTURE ONLY) ----------

/** One media placement: the resolved medium's `param` → the json path in the (json) body it is written to (§6-②). */
export const mediaPlacementSchema = z.object({
  param: z.string().min(1),
  path: z.string().min(1),
});
export type MediaPlacement = z.infer<typeof mediaPlacementSchema>;

export const requestMediaSchema = z.object({
  /** Upstream-accepted delivery forms, in preference order (consumed by the upper-layer resolver). */
  deliveryForms: z.array(z.enum(MEDIA_DELIVERY_FORMS)).min(1),
  placements: z.array(mediaPlacementSchema).min(1),
});
export type RequestMedia = z.infer<typeof requestMediaSchema>;

/**
 * Aspect ①'s wire-STRUCTURE template (§4.1 layer 3 red line). Every value comes
 * from `EffectiveParams.upstream` (or the reserved `upstream_model_name`) —
 * there is NO expression for scaling, conditioning, or renaming a value.
 *
 * - `path`: relative or absolute; `{upstream_model_name}` and `{param:NAME}`
 *   placeholders substitute the upstream value at that POSITION (no transform).
 * - `body`: field-placement map `upstreamParamName → bodyJsonPath` (e.g.
 *   `{ prompt: '$.input.prompt' }` writes `upstream.prompt` to `body.input.prompt`).
 *   The reserved key `upstream_model_name` places the offering's upstream model
 *   name. Absent upstream params are SKIPPED (no null holes).
 * - `query`: `upstreamParamName → queryKey` (values stringified for the wire).
 * - `headers`: STATIC headers only (no value interpolation).
 * - `media`: media placement declarations (aspect ②).
 */
export const requestSpecSchema = z
  .object({
    method: z.enum(WIRE_METHODS).optional(),
    path: z.string().min(1),
    bodyKind: z.enum(WIRE_BODY_KINDS).optional(),
    body: z.record(z.string().min(1), z.string().min(1)).optional(),
    query: z.record(z.string().min(1), z.string().min(1)).optional(),
    headers: z.record(z.string().min(1), z.string()).optional(),
    media: requestMediaSchema.optional(),
  })
  .superRefine((spec, ctx) => {
    const hasBody = spec.body !== undefined && Object.keys(spec.body).length > 0;
    if (hasBody && (spec.bodyKind ?? 'json') !== 'json') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a body field-placement template requires bodyKind "json"',
        path: ['bodyKind'],
      });
    }
  });
export type RequestSpec = z.infer<typeof requestSpecSchema>;

/**
 * A parameter-less request template (task poll + discovery): no upstream-param
 * placement — `path` may carry a `{task_id}` placeholder (poll only), `query` /
 * `headers` are static maps, `body` is a verbatim json payload.
 */
export const simpleRequestSpecSchema = z.object({
  method: z.enum(WIRE_METHODS).optional(),
  path: z.string().min(1),
  bodyKind: z.enum(WIRE_BODY_KINDS).optional(),
  query: z.record(z.string().min(1), z.string()).optional(),
  headers: z.record(z.string().min(1), z.string()).optional(),
  body: z.unknown().optional(),
});
export type SimpleRequestSpec = z.infer<typeof simpleRequestSpecSchema>;

// --- aspect ⑤: response normalization (§6-⑤) ----------------------------------

/**
 * 200-with-business-error detection + extraction (§6-⑤ 含 200 带业务错误翻译).
 * A 2xx is a business error when a declared DETECTOR fires:
 * - `errorWhenPresent`: the value at this path is non-null/non-undefined, or
 * - `successField`: the value at this path is FALSY.
 * On an error (business or HTTP), `codePath` supplies the upstream code (error
 * table matching + provenance) and `messagePath` the message.
 */
export const businessErrorSpecSchema = z.object({
  errorWhenPresent: z.string().optional(),
  successField: z.string().optional(),
  codePath: z.string().optional(),
  messagePath: z.string().optional(),
});
export type BusinessErrorSpec = z.infer<typeof businessErrorSpecSchema>;

/**
 * Streaming normalization (§6-⑤ 流转码, SIMPLE passthrough only — private
 * framing is a code aspect). `doneSentinel` (default `[DONE]`) closes the
 * stream; every other data frame becomes a `delta` whose payload is the raw
 * text; when `usage` is declared, a data frame that JSON-parses and yields
 * metrics also emits a `usage` frame.
 */
export const streamSpecSchema = z.object({
  doneSentinel: z.string().optional(),
  usage: usageMapSchema.optional(),
});
export type StreamSpec = z.infer<typeof streamSpecSchema>;

/**
 * Aspect ⑤ (§6-⑤): output extraction path, usage metric map, 200-business-error
 * rules, stream config, and an OPTIONAL per-operation error-table override
 * (absent → the pack-level `errorTable`).
 */
export const responseSpecSchema = z.object({
  /** Json path of the operation output in the upstream body; absent → the whole body. */
  output: z.string().optional(),
  usage: usageMapSchema.optional(),
  businessError: businessErrorSpecSchema.optional(),
  stream: streamSpecSchema.optional(),
  errorTable: errorTableSpecSchema.optional(),
});
export type ResponseSpec = z.infer<typeof responseSpecSchema>;

// --- aspect ⑥: task lifecycle (§6-⑥) ------------------------------------------

/**
 * Shared parse config for a poll response / callback body → {@link TaskUpdate}.
 * `statusMap` need NOT be exhaustive: an upstream status not listed maps to
 * `unknownStatus` (default `running`), and `rawStatus` preserves the verbatim
 * upstream value — the §6 conformance rule "未知状态告警不崩溃".
 */
export const taskParseSpecSchema = z.object({
  taskIdPath: z.string().min(1),
  statusPath: z.string().min(1),
  statusMap: z.record(z.string().min(1), taskStatusSchema).default({}),
  unknownStatus: taskStatusSchema.optional(),
  outputPath: z.string().optional(),
  usage: usageMapSchema.optional(),
  progressPath: z.string().optional(),
  /** On a `failed` mapping, the message for the synthesized `task_failed` error. */
  errorMessagePath: z.string().optional(),
});
export type TaskParseSpec = z.infer<typeof taskParseSpecSchema>;

/** Submit-response parsing: the upstream task handle path + an optional synchronous-completion path. */
export const submitParseSpecSchema = z.object({
  taskIdPath: z.string().min(1),
  /** When present at this path, the "task" completed inline — the value is the output. */
  inlinePath: z.string().optional(),
  usage: usageMapSchema.optional(),
});
export type SubmitParseSpec = z.infer<typeof submitParseSpecSchema>;

/**
 * Callback authenticity verification (§6-⑥ verifyCallback, §3 submit_callback
 * 验签). `hmac_sha256_timestamp` reuses the slice-1 huimeng shape —
 * `HMAC(secret, `${timestamp}.${rawBody}`)`, a `windowMs` replay window, and a
 * timing-safe compare — reading the shared secret from `ctx.config[secretConfigKey]`
 * (default `callbackSecret`, the provider §2.2 template). `none` accepts all.
 */
export const callbackVerifySpecSchema = z.object({
  strategy: z.enum(['hmac_sha256_timestamp', 'none']),
  signatureHeader: z.string().optional(),
  timestampHeader: z.string().optional(),
  windowMs: z.number().int().positive().optional(),
  secretConfigKey: z.string().optional(),
});
export type CallbackVerifySpec = z.infer<typeof callbackVerifySpecSchema>;

export const taskQuerySpecSchema = taskParseSpecSchema.extend({
  /** The poll request (path carries `{task_id}`). */
  request: simpleRequestSpecSchema,
});
export type TaskQuerySpec = z.infer<typeof taskQuerySpecSchema>;

export const taskCallbackSpecSchema = taskParseSpecSchema.extend({
  verify: callbackVerifySpecSchema,
});
export type TaskCallbackSpec = z.infer<typeof taskCallbackSpecSchema>;

/** Aspect ⑥ declarations (§6-⑥) for the submit_poll / submit_callback fetch modes (§3). */
export const taskSpecSchema = z.object({
  submit: z.object({ response: submitParseSpecSchema }),
  query: taskQuerySpecSchema,
  callback: taskCallbackSpecSchema.optional(),
});
export type TaskSpec = z.infer<typeof taskSpecSchema>;

// --- operation & pack ---------------------------------------------------------

/**
 * One operation the dialect supports: its upstream fetch capability set (§3),
 * the aspect-① request template, the aspect-⑤ response spec, and — for
 * submit_poll / submit_callback — the aspect-⑥ task declarations.
 */
export const operationSpecSchema = z.object({
  fetchModes: z.array(z.enum(FETCH_MODES)).min(1),
  request: requestSpecSchema,
  response: responseSpecSchema,
  task: taskSpecSchema.optional(),
});
export type OperationSpec = z.infer<typeof operationSpecSchema>;

/**
 * The discovery endpoint declaration (§6 / §10 — 发现端点声明). This slice only
 * defines the shape + a pure parse to `ProviderModel[]`; the HTTP fetch is a
 * batch-5 concern.
 */
export const discoverySpecSchema = z.object({
  request: simpleRequestSpecSchema,
  /** Json path to the array of upstream models in the response. */
  modelsPath: z.string().min(1),
  /** Json path (relative to each array item) to the model id. */
  idPath: z.string().min(1),
  displayNamePath: z.string().optional(),
});
export type DiscoverySpec = z.infer<typeof discoverySpecSchema>;

/**
 * THE DSL pack (§6): registry coordinate (`ref` + `version`), auth template,
 * pack-level error table (→ `Dialect.errorTable`, and the default for every
 * operation's aspect ⑤), the operation map (≥1), and an optional discovery
 * declaration. `operations` is keyed by the frozen operation enum, so an
 * unknown operation key is rejected.
 */
export const dialectPackSchema = z
  .object({
    ref: z.string().min(1),
    version: z.string().min(1),
    auth: authSpecSchema,
    errorTable: errorTableSpecSchema,
    operations: z.record(operationSchema, operationSpecSchema),
    discovery: discoverySpecSchema.optional(),
  })
  .superRefine((pack, ctx) => {
    if (Object.keys(pack.operations).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a dialect pack must declare at least one operation',
        path: ['operations'],
      });
    }
  });
export type DialectPack = z.infer<typeof dialectPackSchema>;
