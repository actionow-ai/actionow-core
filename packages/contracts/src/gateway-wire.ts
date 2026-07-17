// packages/contracts/src/gateway-wire.ts
//
// model-supply-greenfield 批次4 slice3 — the NEW gateway's EXTERNAL wire
// shapes (design §5 对外 API 面): the task-paradigm create bodies (resource
// style + the /v1/tasks syntactic sugar), the external Task object, the sync
// invoke response, the §9.3 error envelope and the discovery-face model view.
//
// NOT part of the frozen 批次0 IR (gateway-ir.ts) — this file is the WIRE
// rendering of those IR objects and may evolve additively alongside the API
// surface. Registered into the openapi document (openapi.ts) so slice6's SDK
// regeneration picks the new endpoints up.
import { z } from 'zod';

import {
  artifactModeSchema,
  gatewayErrorSchema,
  gatewayWarningSchema,
  operationSchema,
  paradigmSchema,
  taskStatusSchema,
} from './gateway-ir.js';
import { CANONICAL_PARAM_TYPES } from './supply-params.js';

// --- create bodies (§5 任务范式端点) -----------------------------------------

/**
 * Wire keys the gateway facade treats as ENVELOPE, not canonical params.
 * Everything else in a create body is a canonical parameter of the model's
 * operation contract (§4.1 layer 1 canonical 归一 happens at the facade).
 */
export const GATEWAY_RESERVED_WIRE_KEYS = [
  'model',
  'type',
  'stream',
  'callback_url',
  'artifact_mode',
  'require_persist',
] as const;

const createEnvelopeShape = {
  /** The model's EXTERNAL unique name (§2.1) — the routing address. */
  model: z.string().min(1),
  /** Ask for the stream paradigm (facade → GatewayRequestOptions.stream). */
  stream: z.boolean().optional(),
  /** Downstream webhook URL for task updates (§7.6; the SECRET is tenant config). */
  callback_url: z.string().url().optional(),
  /** §9.4 request-level artifact override (validated against tenant policy downstream). */
  artifact_mode: artifactModeSchema.optional(),
  /** §7.5: persistence failure ⇒ the task fails (no charge). */
  require_persist: z.boolean().optional(),
} as const;

/**
 * Resource-style create body (§5): `POST /v1/videos/generations`,
 * `POST /v1/audio/music` … — the operation comes from the ROUTE; every
 * non-envelope key is a canonical param (passthrough — the facade validates
 * them against the model's operation contract, NOT this schema).
 */
export const gatewayResourceCreateBodySchema = z.object(createEnvelopeShape).passthrough();
export type GatewayResourceCreateBody = z.infer<typeof gatewayResourceCreateBodySchema>;

/** `POST /v1/tasks` syntactic sugar (§5): the operation rides `type` in the body. */
export const gatewayTaskCreateBodySchema = z
  .object({ ...createEnvelopeShape, type: operationSchema })
  .passthrough();
export type GatewayTaskCreateBody = z.infer<typeof gatewayTaskCreateBodySchema>;

// --- the external Task object (§5 API 形状) -----------------------------------

/** `served_by` echo on the Task object — WHICH offering the planner selected (§8 可观测). */
export const gatewayTaskServedBySchema = z.object({
  offering_id: z.string(),
});

/**
 * Usage as rendered on the wire (snake_case twin of the IR `GatewayUsage`):
 * `billing_dims` = the billing_relevant params' effective canonical values
 * (§4.1 字段回流), `estimated` per §9.2.
 */
export const gatewayUsageViewSchema = z.object({
  metrics: z.record(z.string(), z.number()),
  billing_dims: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  estimated: z.boolean(),
});
export type GatewayUsageView = z.infer<typeof gatewayUsageViewSchema>;

/**
 * THE external Task object (§5): six-state `status` (§7.1), `progress`,
 * normalized `output` (artifact refs …), `usage`, unix-seconds timestamps and
 * the §9.4 artifact expiry. Returned by every task-paradigm endpoint (202 on
 * create/auto-upgrade, 200 on reads) and carried IN FULL inside the §7.6
 * webhook envelope (slice4).
 */
export const gatewayTaskViewSchema = z.object({
  id: z.string(),
  object: z.literal('task'),
  /** The operation surface (external `type` vocabulary = OPERATIONS). */
  type: operationSchema,
  /** The addressed model's external name (from the request snapshot); null when unrecorded. */
  model: z.string().nullable(),
  status: taskStatusSchema,
  progress: z.number().int().min(0).max(100).nullable(),
  /** Operation-specific normalized result payload (artifact refs …); null until success. */
  output: z.unknown().nullable(),
  usage: gatewayUsageViewSchema.nullable(),
  /** Present when `status: 'failed'` — the normalized §9.3 error. */
  error: gatewayErrorSchema.nullable(),
  served_by: gatewayTaskServedBySchema.nullable(),
  /** Unix seconds. */
  created: z.number().int(),
  started: z.number().int().nullable(),
  finished: z.number().int().nullable(),
  /** §9.4 artifact expiry (signed track), unix seconds; null = none/undecided. */
  expires_at: z.number().int().nullable(),
});
export type GatewayTaskView = z.infer<typeof gatewayTaskViewSchema>;

/** One task_events row as exposed on the SSE progress stream (§7.1 seq order). */
export const gatewayTaskEventViewSchema = z.object({
  seq: z.number().int(),
  from_status: taskStatusSchema.nullable(),
  to_status: taskStatusSchema,
  payload: z.unknown().nullable(),
  created_at: z.string(),
});
export type GatewayTaskEventView = z.infer<typeof gatewayTaskEventViewSchema>;

// --- sync invoke response (§5 同步端点 200 形状) --------------------------------

/** `served_by` echo on sync responses (completion criterion 2.2 响应回显实际供给项). */
export const gatewayServedByViewSchema = z.object({
  offering_id: z.string(),
  channel_id: z.string(),
  provider: z.string().optional(),
  upstream_model_name: z.string().optional(),
});

/**
 * The 200 body of a sync-paradigm gateway invoke (fast models on the
 * resource-style endpoints; §3 自动升格 answers 202 + Task instead when slow).
 */
export const gatewayInvokeResponseSchema = z.object({
  operation: operationSchema,
  model: z.string(),
  output: z.unknown(),
  usage: gatewayUsageViewSchema,
  served_by: gatewayServedByViewSchema,
  warnings: z.array(gatewayWarningSchema),
});
export type GatewayInvokeResponse = z.infer<typeof gatewayInvokeResponseSchema>;

// --- §9.3 error envelope --------------------------------------------------------

/**
 * The NEW gateway's error envelope (§9.3 统一信封: adds `failover` and
 * `request_id`; 429 additionally carries a Retry-After response header).
 * Codes come from the frozen GATEWAY_ERROR_CODES taxonomy.
 */
export const gatewayErrorViewSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    failover: z.boolean(),
    upstream: z.object({ provider: z.string(), rawCode: z.string().optional() }).optional(),
    retry_after_ms: z.number().int().nonnegative().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
    request_id: z.string().optional(),
  }),
});
export type GatewayErrorView = z.infer<typeof gatewayErrorViewSchema>;

// --- discovery face (§5 GET models) ----------------------------------------------

/** Canonical-param summary on the discovery face (§5 契约摘要 — form/SDK fodder). */
export const gatewayModelParamViewSchema = z.object({
  name: z.string(),
  type: z.enum(CANONICAL_PARAM_TYPES),
  required: z.boolean(),
  /** §4 两级: participates in sale-price tiers and mandatory filtering. */
  billing_relevant: z.boolean(),
  default: z.unknown().optional(),
  values: z.array(z.union([z.string(), z.number()])).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  multiple: z.boolean().optional(),
});
export type GatewayModelParamView = z.infer<typeof gatewayModelParamViewSchema>;

/** One operation surface on the discovery face: paradigms + slow 升格标记 + contract summary. */
export const gatewayModelOperationViewSchema = z.object({
  operation: operationSchema,
  paradigms: z.array(paradigmSchema),
  slow: z.boolean(),
  params: z.array(gatewayModelParamViewSchema),
});

/**
 * One model on the NEW discovery face (§5): the OpenAI `model` object shape
 * (`id`/`object`/`created`/`owned_by`) EXTENDED with the operation surface,
 * paradigms and contract summary the member 自助面 and key-allowlist config
 * depend on.
 */
export const gatewayModelViewSchema = z.object({
  id: z.string(),
  object: z.literal('model'),
  created: z.number().int(),
  owned_by: z.string(),
  display_name: z.string(),
  modality: z.string(),
  status: z.string(),
  operations: z.array(gatewayModelOperationViewSchema),
  capabilities: z.array(z.string()),
});
export type GatewayModelView = z.infer<typeof gatewayModelViewSchema>;

/** The OpenAI-compatible list envelope of the discovery face. */
export const gatewayModelListSchema = z.object({
  object: z.literal('list'),
  data: z.array(gatewayModelViewSchema),
});
export type GatewayModelList = z.infer<typeof gatewayModelListSchema>;
