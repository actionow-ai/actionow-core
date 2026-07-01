# 模型参数绑定 — 完整实现规格（Implementation Spec）

- **日期**: 2026-07-01
- **状态**: Draft / 实现就绪（Ready-to-build）
- **设计规格（Why/What）**: [2026-07-01-model-param-binding-design.md](./2026-07-01-model-param-binding-design.md) — 本文件是其**实现级（How）**展开
- **前置基建可复用**: 规格库 `model_spec`(#71/#76, `key_params`) · #72 `extra` 透传+reasoning 降级(本设计的粗糙前身) · #12 model-test-on-add · RELAY_TRACE 中转追踪 · `channel_model` link(mig 0033) · #74 credits/#73 用拆分计费

> **一句话**：转换**代码**继续绑插件/方言（保留 `packages/adapters` 适配器，不按模型拆）；参数**契约/数据**下沉到 `模型`(ModelParamProfile) + `(模型×渠道)`(channel_model.param_override) 两级声明式。空配置 == 今天逐字节一致（回归不变式）。

## 锁定决策（本实现规格的前提，勿再翻案）

- **D1 profile 运行期存放 = 冻结到 `model.param_profile` 列**（mig 0064）。`sync-models` 时从规格库 `model_spec` 冻结（照抄 `model.input_price` 从 `official_model_price` 冻结的现有模式）→ 运行期**零额外查询**（model 行本就在 `resolveModelForTenant` 里）。`model_spec` 仍是权威目录，`model.param_profile` 是冻结快照。
- **D2 Phase 1 不引入 `wirePath`**：profile 只做 allow/default/clamp/gate/drop；**wire 映射仍归适配器方言**。模型专属声明参数经 **typed `extra` 透传**（#72 已能，现在被 profile 校验/带默认）。`wirePath` 留作 Phase 2 escape hatch。
- **D3 `require_params` 默认关**（drop-and-forward，OpenRouter 默认语义）；按 `route_group`/渠道可选开。
- **D4 media（async-media）不进 Phase 0/1**（其参数是 params object 非 OpenAI 采样）；Phase 2+ 单独 profile。

## 引擎管线（apply 顺序 + 优先级）

```
调用方 IR
  → ① applyProfileDefaults(profile)   填默认
  → ① clampToRules(profile)           夹 min/max（越界按 dropPolicy）
  → ① gate(profile.features)          能力门控/降级（reasoning 降级改 profile 驱动，替代 normalize.ts 硬编码表）
  → ② applyChannelOverride(channel_model.param_override)   set/clamp/delete + when.modelMatches
  → ③ adapter.buildChatBody(ir, ctx)  【保留】方言渲染
  → ④ dropUnsupported(dropPolicy)     未声明的“已知标准参数”按策略；非标默认 passthrough
```

**优先级**：`request > ②(模型×渠道) > ①(模型) > 插件/方言默认`。响应侧不动（`extractUsage` 归一 #70）+ 补 `native_finish_reason`。

## 迁移编号（main 最新 = 0061）

- **mig 0062**: `model_spec += features jsonb, parameter_rules jsonb`（`key_params` 保留一版做兼容）
- **mig 0063**: `channel_model += param_override jsonb`（nullable，默认空 = 现状）— **Phase 0 只需这一个**
- **mig 0064**: `model += param_profile jsonb`（冻结运行期快照，D1）

## 分期落地（每期独立可上线、向后兼容）

- **Phase 0（最小切片，直击最痛点）**: mig 0063 + 引擎 ②`applyChannelOverride` + 前端「参数覆盖」面板 + 测试。解决**同模型跨渠道不同参数**，其余走现状。
- **Phase 1（模型档案）**: migs 0062/0064 + contracts(param-profile/templates) + 引擎 ①(defaults/clamp/gate,`normalize.ts` 改 profile 驱动) + `ModelEditor` 参数档案编辑器 + `sync` 冻结 + 测试。`capabilities → features`。
- **Phase 2（打磨）**: `require_params` 路由 + `native_finish_reason` + 模型中心视图 + media profile + 运行期打磨。

---

# 详细实现（按层）

以下五节由并行读真实代码起草，含确切 zod / drizzle DDL / 引擎挂载点 / 前端组件 / 测试矩阵。顺序：契约 → DB/迁移 → 引擎 → 前端 → 测试与分期。

---

# 1. Contracts & Templates — model param profile, channel override, template library, and request/response additions

## Overview / where each schema lands

Two NEW contract files + additions to two EXISTING files, all under `packages/contracts/src`:

| File                  | Status  | Contents                                                                                                                                                                                                                                      |
| --------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `param-profile.ts`    | **NEW** | `parameterRuleSchema`, `PARAMETER_TYPES`, `MODEL_FEATURES`, `DROP_POLICIES`, `modelParamProfileSchema`, `PARAM_OPS`, `paramOpSchema`, `paramOverrideSchema`, `resolveRule`, `ApplyProfileInput`/`applyProfile` signature + all inferred types |
| `param-templates.ts`  | **NEW** | `PARAM_TEMPLATES` constant (code-only, no zod) + `ParamTemplateName` type                                                                                                                                                                     |
| `chat.ts`             | EDIT    | `nativeFinishReason` on `ChatResponse` IR + `{ type:'stop' }` stream event; note on model-specific declared params validating via profile not raw `extra`                                                                                     |
| `catalog-requests.ts` | EDIT    | `paramProfile` on `createModelSchema`/`updateModelSchema`; `paramOverride` on `channelModelLinkInputSchema`; `features`/`parameterRules` on `createModelSpecSchema`/`updateModelSpecSchema`                                                   |
| `catalog-views.ts`    | EDIT    | `param_profile` on `modelViewSchema`; `param_override` on channel-model link view; `features`/`parameter_rules` on `modelSpecViewSchema`                                                                                                      |
| `index.ts`            | EDIT    | add `export * from './param-profile.js';` and `export * from './param-templates.js';`                                                                                                                                                         |
| `openapi.ts`          | EDIT    | register `ModelParamProfile`, `ParameterRule`, `ParamOverride` as named components; extend the (already-registered) Model/ModelSpec/ChannelModel views + bodies                                                                               |

Convention adherence: zod lives in contracts; **request bodies camelCase, response Views snake_case**; `.default(...)` used for optional-with-default; no `node:crypto`/browser leakage (pure zod + plain constant).

---

## 1. `packages/contracts/src/param-templates.ts` (NEW — code-only constant)

Placed FIRST because `param-profile.ts` imports `PARAM_TEMPLATES` for `resolveRule`. This is Dify's `PARAMETER_RULE_TEMPLATE` equivalent — a shared library keyed by template name. Values mirror the `parameterRuleSchema` field shape (minus `name`/`useTemplate`), so `resolveRule` can spread a template then overlay rule overrides.

```ts
// packages/contracts/src/param-templates.ts
// NO zod here — a plain frozen constant, safe to import from browser (type-only) and engine alike.

/**
 * The reusable parameter-rule template library (Dify `PARAMETER_RULE_TEMPLATE`
 * equivalent). A `parameterRule` with `useTemplate: 'temperature'` inherits this
 * row; any field it also sets OVERRIDES the template (see `resolveRule`). The
 * shape is exactly the override-able subset of `parameterRuleSchema` (everything
 * except `name`/`useTemplate`). All numeric bounds are the OpenAI-canonical
 * ranges; adapters/`②` may clamp narrower per model×channel.
 */
export const PARAM_TEMPLATES = {
  temperature: {
    type: 'float',
    default: 1.0,
    min: 0,
    max: 2,
    help: 'Sampling temperature; higher = more random. 0 = greedy.',
  },
  top_p: {
    type: 'float',
    default: 1.0,
    min: 0,
    max: 1,
    help: 'Nucleus sampling: consider tokens with top_p cumulative probability.',
  },
  top_k: {
    type: 'int',
    min: 1,
    help: 'Sample only from the top-K most likely tokens (Anthropic/Gemini/Qwen).',
  },
  max_tokens: {
    type: 'int',
    default: 1024,
    min: 1,
    help: 'Maximum tokens to generate (maps to IR maxOutputTokens).',
  },
  response_format: {
    type: 'enum',
    options: ['text', 'json_object', 'json_schema'],
    default: 'text',
    help: 'Output structuring: free text, JSON object, or a strict JSON schema.',
  },
  reasoning_effort: {
    type: 'enum',
    options: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    default: 'medium',
    help: 'Reasoning/thinking effort; adapters map to the per-provider knob.',
  },
  stop: {
    type: 'json',
    help: 'Up to N stop sequences (string or string[]); generation halts on a match.',
  },
  seed: {
    type: 'int',
    help: 'Best-effort deterministic sampling seed.',
  },
  frequency_penalty: {
    type: 'float',
    default: 0,
    min: -2,
    max: 2,
    help: 'Penalize tokens by existing frequency; reduces verbatim repetition.',
  },
  presence_penalty: {
    type: 'float',
    default: 0,
    min: -2,
    max: 2,
    help: 'Penalize tokens already present; encourages new topics.',
  },
  logprobs: {
    type: 'boolean',
    default: false,
    help: 'Return per-token log probabilities.',
  },
} as const;

export type ParamTemplateName = keyof typeof PARAM_TEMPLATES;

/** Runtime guard: is a string a known template key (drives `useTemplate` validation + UI dropdown). */
export const PARAM_TEMPLATE_NAMES = Object.keys(PARAM_TEMPLATES) as ParamTemplateName[];
```

Note: template values are typed `as const` so `resolveRule` gets literal `type`/`options`. Numeric-bound-less templates (`stop`, `seed`, `top_k`, `logprobs`) omit `min`/`max` intentionally.

---

## 2. `packages/contracts/src/param-profile.ts` (NEW)

```ts
// packages/contracts/src/param-profile.ts
import { z } from 'zod';

import { PARAM_TEMPLATES, type ParamTemplateName } from './param-templates.js';

/** Parameter value domains a rule declares (Dify `type`). `json` = arbitrary JSON value (stop arrays, schemas). */
export const PARAMETER_TYPES = ['float', 'int', 'boolean', 'string', 'enum', 'json'] as const;
export type ParameterType = (typeof PARAMETER_TYPES)[number];

/**
 * One declarative parameter rule (Dify `parameter_rules` shape). `name` is the
 * IR/OpenAI param name (`temperature`, `top_p`, `response_format`, `reasoning_effort`)
 * OR a model-specific declared param that otherwise rides the typed `extra`
 * passthrough (`enable_thinking`, `prompt_cache_key`, …). `useTemplate` inherits a
 * `PARAM_TEMPLATES` row; the remaining fields OVERRIDE the template when set
 * (precedence resolved by `resolveRule`). Per D2 there is NO `wirePath` in Phase 1 —
 * the adapter dialect remains authoritative for wire mapping; the profile only
 * allows/defaults/clamps/gates/drops.
 */
export const parameterRuleSchema = z.object({
  name: z.string().min(1),
  /** Inherit a shared template; must be a known `PARAM_TEMPLATES` key. */
  useTemplate: z.string().min(1).optional(),
  type: z.enum(PARAMETER_TYPES).optional(),
  /** Applied when the caller omits the param (post-template resolution). */
  default: z.unknown().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  required: z.boolean().optional(),
  /** enum options (e.g. reasoning_effort: low|medium|high). */
  options: z.array(z.string()).optional(),
  help: z.string().optional(),
});
export type ParameterRule = z.infer<typeof parameterRuleSchema>;

/**
 * Fine-grained capability features (upgrades the 6 coarse `capabilities` booleans;
 * Dify `features`). Kept as a permissive `z.string()` array WITH a canonical
 * enum export for the UI/gate — an unknown feature string never blocks ingest
 * (back-compat with `passthrough` philosophy).
 */
export const MODEL_FEATURES = [
  'tool-call',
  'parallel-tool-call',
  'vision',
  'audio',
  'file',
  'json-object',
  'json-schema',
  'reasoning',
  'stream',
] as const;
export type ModelFeature = (typeof MODEL_FEATURES)[number];

/** Policy for a KNOWN-STANDARD param the profile did NOT declare in `parameterRules`. */
export const DROP_POLICIES = ['error', 'drop', 'passthrough'] as const;
export type DropPolicy = (typeof DROP_POLICIES)[number];

/**
 * The model-level parameter profile (frozen onto `model.param_profile` jsonb per D1,
 * synced FROM `model_spec`). Empty profile == today's behavior (the regression
 * invariant): no features declared → gate passes everything; no rules → no
 * defaults/clamps; `dropPolicy` defaults to `passthrough` so non-declared params
 * forward unchanged (LiteLLM drop-and-forward semantics, D3).
 */
export const modelParamProfileSchema = z.object({
  features: z.array(z.string()).default([]),
  parameterRules: z.array(parameterRuleSchema).default([]),
  dropPolicy: z.enum(DROP_POLICIES).default('passthrough'),
});
export type ModelParamProfile = z.infer<typeof modelParamProfileSchema>;

/**
 * Per-(model×channel) override op (new-api `ParamOverride` JSON operation). Applied
 * to the IR params/extra AFTER the model profile, BEFORE the adapter renders the
 * body (engine pipeline step ④). `set` forces a value; `clamp` bounds to min/max;
 * `delete` removes the param. `when.modelMatches` scopes the op (one channel, many
 * models). Deliberately NOT a Turing-complete DSL (spec §10 non-goal).
 */
export const PARAM_OPS = ['set', 'clamp', 'delete'] as const;
export type ParamOp = (typeof PARAM_OPS)[number];

export const paramOpSchema = z
  .object({
    op: z.enum(PARAM_OPS),
    /** Target param name; a dotted path addresses a nested `extra` field (e.g. `thinking.type`). */
    name: z.string().min(1),
    /** `set` value. */
    value: z.unknown().optional(),
    /** `clamp` bounds (at least one required for `clamp`). */
    min: z.number().optional(),
    max: z.number().optional(),
    /** Optional gate: apply only when the resolved upstream model id matches (substring/exact). */
    when: z.object({ modelMatches: z.string().min(1).optional() }).optional(),
  })
  .superRefine((op, ctx) => {
    if (op.op === 'set' && op.value === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'set requires value', path: ['value'] });
    }
    if (op.op === 'clamp' && op.min === undefined && op.max === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'clamp requires min or max',
        path: ['min'],
      });
    }
  });
export type ParamOp_ = z.infer<typeof paramOpSchema>;

export const paramOverrideSchema = z.object({
  ops: z.array(paramOpSchema).default([]),
});
export type ParamOverride = z.infer<typeof paramOverrideSchema>;

// --- helpers (pure; safe to import from engine) ---------------------------

/**
 * Merge a rule with its `useTemplate` base: start from the template row (if any &
 * known), then overlay every field the rule itself sets (rule wins). Returns a
 * fully-resolved rule carrying `name`. A `useTemplate` naming an unknown template
 * is ignored (rule used as-is) — never throws, matching the passthrough philosophy.
 */
export function resolveRule(rule: ParameterRule): ParameterRule {
  const tplName = rule.useTemplate as ParamTemplateName | undefined;
  const tpl = tplName && tplName in PARAM_TEMPLATES ? PARAM_TEMPLATES[tplName] : undefined;
  if (!tpl) return rule;
  const merged: ParameterRule = { name: rule.name, ...(tpl as Partial<ParameterRule>) };
  // Overlay only the fields the rule explicitly set (undefined = inherit template).
  for (const k of ['type', 'default', 'min', 'max', 'required', 'options', 'help'] as const) {
    if (rule[k] !== undefined) (merged as Record<string, unknown>)[k] = rule[k];
  }
  return merged;
}

/**
 * The pure request-side profile pass the engine runs BEFORE `adapter.buildChatBody`
 * (pipeline steps ①②③④, D2). Mutation-free: returns a NEW params/extra pair.
 *   applyProfileDefaults → clampToRules → gate(features) → applyChannelOverride → dropUnsupported
 * `params`/`extra` are the IR request fields (camelCase params, open `extra` bag).
 * `resolvedModel` is the upstream model id (for `when.modelMatches`). Returns the
 * transformed pair plus any dropped/errored param names (for RELAY_TRACE + 400s).
 * Signature only — implementation lives in `packages/engine` (not shipped to the
 * browser bundle).
 */
export interface ApplyProfileInput {
  params: Record<string, unknown>;
  extra: Record<string, unknown>;
  profile: ModelParamProfile;
  override?: ParamOverride;
  resolvedModel: string;
}
export interface ApplyProfileResult {
  params: Record<string, unknown>;
  extra: Record<string, unknown>;
  dropped: string[];
  /** Populated only when `dropPolicy: 'error'` rejected a param — engine turns this into a 400. */
  rejected: string[];
}
export declare function applyProfile(input: ApplyProfileInput): ApplyProfileResult;
```

---

## 3. `chat.ts` EDITS (request/response additions)

### 3a. `ChatResponse` + stop stream event — carry the native finish reason

Adapters today map raw `finish_reason`/`stop_reason` into the normalized `StopReason` enum and DISCARD the native string (see `openai.ts:506 mapFinishReason`, `anthropic.ts:421 mapStopReason`, `gemini.ts:372`). Add an optional passthrough field (OpenRouter `native_finish_reason` semantics). Absent → unchanged (regression invariant).

```ts
// EDIT the ChatResponse interface (currently chat.ts:214-218)
export interface ChatResponse {
  message: Message;
  stopReason: StopReason;
  usage: ChatUsage;
  /**
   * The upstream's RAW finish/stop reason verbatim (OpenAI `finish_reason`,
   * Anthropic `stop_reason`, Gemini `finishReason`), preserved alongside the
   * normalized {@link StopReason} so the client can see provider-specific reasons
   * the enum flattens (`content_filter`, `max_tokens`, `MALFORMED_FUNCTION_CALL`).
   * Set by each adapter's `chat()` from the same field it maps to `stopReason`;
   * absent when the provider reported none.
   */
  nativeFinishReason?: string;
}
```

```ts
// EDIT the ChatStreamEvent `stop` variant (currently chat.ts:235)
  | { type: 'stop'; stopReason: StopReason; nativeFinishReason?: string }
```

Wire rendering: the OpenAI-dialect response renderer surfaces `nativeFinishReason` as the snake_case `native_finish_reason` on each `choices[].` object (mirroring OpenRouter). No new zod view — `ChatResponse` is the internal IR interface, and the dialect renderer already hand-builds the wire body; it adds `native_finish_reason: resp.nativeFinishReason` when present.

### 3b. Model-specific declared params validate against the profile (not raw `extra`)

No schema change to `extra` (`chatRequestSchema.extra` stays `z.record(z.string(), z.unknown())` — the open bag, chat.ts:117). The CHANGE is where validation happens: today `extra` forwards blindly; under the profile, a param NAMED in `profile.parameterRules` is validated (type/min/max/options/required via `resolveRule`) by `applyProfile` at engine time, then either mapped by the adapter dialect or ridden through `extra` unchanged (D2). A param NOT named follows `dropPolicy` (`passthrough` default = today's forward). Document this on the `extra` field:

```ts
// APPEND to the existing `extra` JSDoc block (chat.ts:108-117), no shape change:
   * Params NAMED in the resolved model's `param_profile.parameterRules` are
   * validated/defaulted/clamped by the engine `applyProfile` pass BEFORE this bag
   * reaches the adapter (so declared model-specific params are first-class, not
   * raw); un-named known params follow `param_profile.dropPolicy` (default
   * `passthrough` = forwarded verbatim, byte-identical to today).
```

---

## 4. `catalog-requests.ts` EDITS (write side, camelCase)

Import the new schemas at top:

```ts
import {
  modelParamProfileSchema,
  paramOverrideSchema,
  parameterRuleSchema,
} from './param-profile.js';
```

### 4a. `createModelSchema` — add (after `reasoning`, catalog-requests.ts:286):

```ts
  /**
   * Frozen model-level parameter profile (D1). Populated by sync-models FROM
   * model_spec, editable in ModelEditor. Omitted → empty profile (= today's
   * behavior: gate passes all, no defaults/clamps, passthrough drop policy).
   */
  paramProfile: modelParamProfileSchema.optional(),
```

### 4b. `updateModelSchema` — add (after `reasoning`, catalog-requests.ts:318):

```ts
  /** Replace the frozen model-level parameter profile (D1); `null` clears it to empty. */
  paramProfile: modelParamProfileSchema.nullable().optional(),
```

### 4c. Channel-model link — per-(model×channel) override

The link body `channelModelLinkInputSchema` lives in `catalog-views.ts` (line 67). Add `paramOverride` there AND expose a dedicated PATCH body for editing an existing link's override. In `catalog-requests.ts` add:

```ts
/**
 * `PATCH /admin/resources/:id/channels/:channelId/models/:modelId` — set/clear the
 * per-(model×channel) param override (channel_model.param_override, mig 0063).
 * `null` clears it (= no override).
 */
export const updateChannelModelParamOverrideSchema = z.object({
  paramOverride: paramOverrideSchema.nullable(),
});
export type UpdateChannelModelParamOverrideBody = z.infer<
  typeof updateChannelModelParamOverrideSchema
>;
```

### 4d. `model_spec` catalog is the source-of-truth (规格库) — add structured rules

`createModelSpecSchema` currently has `keyParams: z.array(z.string())` (catalog-requests.ts:351). Keep it (mig 0062 retains `key_params` one version for compat) and ADD:

```ts
  /** Fine-grained capability features (upgrades keyParams; drives model.param_profile.features on sync). */
  features: z.array(z.string().min(1)).optional(),
  /** Structured parameter rules (Dify parameter_rules); frozen into model.param_profile on sync-models. */
  parameterRules: z.array(parameterRuleSchema).optional(),
```

`updateModelSpecSchema` gets the nullable twins:

```ts
  features: z.array(z.string().min(1)).nullable().optional(),
  parameterRules: z.array(parameterRuleSchema).nullable().optional(),
```

---

## 5. `catalog-views.ts` EDITS (read side, snake_case)

Import (type is fine but the schema is needed for `.parse()` composition):

```ts
import { modelParamProfileSchema, paramOverrideSchema } from './param-profile.js';
```

### 5a. `modelViewSchema` — add (after `reasoning`, catalog-views.ts:98):

```ts
  /** Frozen model-level parameter profile (D1); default-empty, never null (mapper coerces). */
  param_profile: modelParamProfileSchema,
```

(Use the schema directly — it has `.default([])`/`.default('passthrough')` inside, so the `toView` mapper can `.parse({})` an absent column into the empty profile.)

### 5b. Channel-model link view + `param_override`

`channelModelLinkInputSchema` (catalog-views.ts:67) is the request; add its `param_override` and a proper VIEW for the join row:

```ts
/** One channel_model link row (`GET .../channels/:channelId/models`). */
export const channelModelViewSchema = z.object({
  channel_id: z.string(),
  model_id: z.string(),
  /** Per-(model×channel) param override (mig 0063); null → no override. */
  param_override: paramOverrideSchema.nullable(),
  created_at: z.string(),
});
export type ChannelModelView = z.infer<typeof channelModelViewSchema>;
```

And extend the link INPUT so a link can be created WITH an override in one call:

```ts
export const channelModelLinkInputSchema = z.object({
  model_id: z.string(),
  /** Optional per-(model×channel) override to attach at link time. */
  param_override: paramOverrideSchema.optional(),
});
```

### 5c. `modelSpecViewSchema` — add (after `key_params`, catalog-views.ts:181):

```ts
  /** Fine-grained capability features (规格库 → model.param_profile.features). */
  features: z.array(z.string()).nullable(),
  /** Structured parameter rules (Dify parameter_rules); frozen into model.param_profile on sync. */
  parameter_rules: z.array(parameterRuleSchema).nullable(),
```

(import `parameterRuleSchema` too.)

---

## 6. `index.ts` EDIT

Add (alphabetical placement between `ops-views.js` and `payment.js`):

```ts
export * from './param-profile.js';
export * from './param-templates.js';
```

No conflicts: `PARAM_TEMPLATES`, `ParameterRule`, `ModelParamProfile`, `ParamOverride`, `DROP_POLICIES`, `MODEL_FEATURES` are all new names. (Note `RESPONSE_FORMATS`/`REASONING_EFFORTS` already exist in `chat.ts` — the templates reference those literal string sets by VALUE, not by importing, so no duplicate export.)

---

## 7. `openapi.ts` EDITS (register new components + extend existing)

Add imports:

```ts
import {
  modelParamProfileSchema,
  parameterRuleSchema,
  paramOverrideSchema,
} from './param-profile.js';
import { channelModelViewSchema } from './catalog-views.js';
import { updateChannelModelParamOverrideSchema } from './catalog-requests.js';
```

Register the three reusable components (near the other catalog registrations, ~line 223):

```ts
const ParameterRule = registry.register('ParameterRule', parameterRuleSchema);
const ModelParamProfile = registry.register('ModelParamProfile', modelParamProfileSchema);
const ParamOverride = registry.register('ParamOverride', paramOverrideSchema);
const ChannelModel = registry.register('ChannelModelView', channelModelViewSchema);
const UpdateChannelModelOverride = registry.register(
  'UpdateChannelModelParamOverrideBody',
  updateChannelModelParamOverrideSchema,
);
```

Because `modelViewSchema`/`modelSpecViewSchema`/`createModelSchema`/`updateModelSchema` now EMBED these schemas, the existing `Model`/`ModelSpec`/`CreateModel`/`UpdateModel` registrations auto-inline them — but `zod-to-openapi` will re-inline the embedded objects unless referenced. To get clean `$ref`s in the SDK, register the shared schemas FIRST (above) so the generator emits refs; the embedded `modelParamProfileSchema` inside `modelViewSchema` then renders as `{ $ref: '#/components/schemas/ModelParamProfile' }`.

Register the new PATCH path for channel-model override + the link/list already implied:

```ts
// per-(model×channel) param override edit
write({
  method: 'patch',
  path: '/admin/resources/{id}/channels/{channelId}/models/{modelId}',
  summary: 'Set/clear a per-(model×channel) parameter override',
  tag: 'catalog',
  body: UpdateChannelModelOverride,
  response: ChannelModel,
});
list(
  '/admin/resources/{id}/channels/{channelId}/models',
  'List a channel’s linked models (+ param overrides)',
  ChannelModel,
  'catalog',
);
```

---

## Precedence + engine wiring (context for the assembler — code lands in engine/adapters, not contracts)

`applyProfile` (signature §2) runs in `packages/engine` in the LOCKED order:
`applyProfileDefaults → clampToRules → gate(features) → applyChannelOverride(②) → adapter.buildChatBody(③) → dropUnsupported(④)`, effective precedence **request > ② override > ① profile > dialect default**. The contracts above are the pure data shapes this consumes; the profile is read from the already-loaded `model` row (D1 — `model.param_profile`, zero extra query in `resolveModelForTenant`) and the override from the `channel_model` join row.

---

# 2. DB Schema, Migrations & Repos — Model Param Binding (Phase 1)

## Overview

Three serialized additive migrations (all nullable/defaulted → non-breaking, empty == today):

- **0062** — `model_spec += features jsonb, parameter_rules jsonb` (keep `key_params` one release for compat).
- **0063** — `channel_model += param_override jsonb` (nullable).
- **0064** — `model += param_profile jsonb` (the frozen runtime snapshot, D1).

**Append-only trigger safety (mig 0052):** the `BEFORE UPDATE OR DELETE` append-only triggers only exist on `ledger_txn` and `audit_log`. `model`, `model_spec`, and `channel_model` have **no** such trigger, so `updateModelSpec`, `linkChannelModel` re-link, and the `param_profile` freeze `UPDATE` on `model` are all unrestricted. No trigger edits required. (All three touched tables are freely mutable — confirmed by grepping 0052.)

Money stays µUSD bigint (untouched here). All new columns are jsonb, nullable or defaulted, so drizzle-kit emits plain `ADD COLUMN` with no backfill and no partial-unique interaction.

---

## 1. Migration SQL

Drizzle migrations live in `packages/db/drizzle/` (NOT `packages/db/migrations`; the CLAUDE.md path is stale). Each is drizzle-kit-generated: a `NNNN_<random_word>.sql` + a `meta/NNNN_snapshot.json` + a `meta/_journal.json` append. Latest on main = 0061 (`prevId cb5d104a…`, snapshot id `a2ef7414…`). Generate these by editing the drizzle schema (§2) then running `pnpm --filter @actionow/db db:generate` three times — do NOT hand-number. The resulting SQL bodies must be:

**`packages/db/drizzle/0062_<word>.sql`**

```sql
ALTER TABLE "model_spec" ADD COLUMN "features" jsonb;--> statement-breakpoint
ALTER TABLE "model_spec" ADD COLUMN "parameter_rules" jsonb;
```

**`packages/db/drizzle/0063_<word>.sql`**

```sql
ALTER TABLE "channel_model" ADD COLUMN "param_override" jsonb;
```

**`packages/db/drizzle/0064_<word>.sql`**

```sql
ALTER TABLE "model" ADD COLUMN "param_profile" jsonb;
```

All three follow the exact shape of `0060_gorgeous_hercules.sql` (`ALTER TABLE "model" ADD COLUMN "cached_input_price" bigint;`) and `0061_calm_shatterstar.sql` (`ALTER TABLE "official_model_price" ADD COLUMN "scheme" jsonb;`) — no default, nullable, no CHECK. Each `meta/NNNN_snapshot.json` column entry is `{ "name": ..., "type": "jsonb", "primaryKey": false, "notNull": false }` and `_journal.json` gets a new `{ "idx": 62|63|64, "version": "7", "when": <ts>, "tag": "...", "breakpoints": true }` entry (drizzle-kit writes these — do not hand-edit).

---

## 2. Drizzle schema column additions

### 2a. `packages/db/src/schema/model-spec.ts` (mig 0062)

Add two columns to the `modelSpec` `pgTable`, right after the existing `keyParams` column (line 57). Keep `keyParams` (compat, drop next release).

```ts
    /** Notable request parameters (`reasoning_effort`, `temperature`, …). @deprecated superseded by `parameterRules` (mig 0062); kept one release for compat. */
    keyParams: jsonb('key_params').$type<string[]>(),
    /**
     * Fine-grained capability枚举 (Dify `features`): `tool-call`, `vision`,
     * `json-schema`, `reasoning`, `parallel-tool`, … The catalog source-of-truth
     * that `sync-models` freezes into `model.param_profile.features` (mig 0064).
     */
    features: jsonb('features').$type<string[]>(),
    /**
     * Declarative per-model parameter contract (Dify `parameter_rules` shape:
     * name/type/default/min/max/required/options/help/useTemplate). Typed as the
     * contracts `ParameterRule[]`; the 规格库 authoritative copy frozen into
     * `model.param_profile.parameterRules` at sync (mig 0064).
     */
    parameterRules: jsonb('parameter_rules').$type<ParameterRule[]>(),
```

Add the type import at the top of the file (the contracts package is already a dep of db repos via the ResolvedModel path — if not, import the local type declaration; keeping it as `unknown[]` is acceptable if a contracts→db import cycle is a concern):

```ts
import type { ParameterRule } from '@actionow/contracts';
```

If `@actionow/contracts` cannot be imported from `packages/db/src/schema` (build-cycle), fall back to a structural inline: `.$type<Array<Record<string, unknown>>>()`. Confirm direction before choosing — schema files currently import nothing from contracts.

### 2b. `packages/db/src/schema/model.ts` — `channelModel` table (mig 0063)

Add one column to the `channelModel` `pgTable` (lines 142–158), after `modelId`:

```ts
    modelId: uuid('model_id')
      .notNull()
      .references(() => model.id),
    /**
     * Per-(model,channel) parameter override (`ParamOverride` = { ops: ParamOp[] }):
     * ops of set/clamp/delete applied to the IR before the adapter renders the wire
     * body (engine pipeline step ④, precedence request > ② this > ① profile >
     * dialect). Null → no override == today's behavior. This is the home of "same
     * model, different params per channel (direct vs relay)".
     */
    paramOverride: jsonb('param_override').$type<ParamOverride>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
```

Add `jsonb` is already imported in model.ts. Add the type import:

```ts
import type { ParamOverride } from '@actionow/contracts';
```

(Same cycle caveat as 2a; fall back to `.$type<{ ops: unknown[] }>()` if needed.)

### 2c. `packages/db/src/schema/model.ts` — `model` table (mig 0064)

Add one column to the `model` `pgTable`, after `cachedInputPrice` (line 60):

```ts
    cachedInputPrice: bigint('cached_input_price', { mode: 'bigint' }),
    /**
     * Frozen runtime snapshot of the model's parameter profile
     * (`ModelParamProfile` = { features, parameterRules, dropPolicy }), populated
     * by `sync-models` / admin create+update FROM the matched `model_spec` (D1) —
     * mirrors how `input_price` is frozen from `official_model_price`. Null →
     * empty profile == today's passthrough behavior. Loaded on the SAME row already
     * fetched in `resolveModelForTenant`, so ZERO extra query on the hot path.
     */
    paramProfile: jsonb('param_profile').$type<ModelParamProfile>(),
```

Add the type import:

```ts
import type { ModelParamProfile } from '@actionow/contracts';
```

---

## 3. Repository changes

### 3a. `packages/db/src/repositories/model-spec.ts` — carry features + parameterRules

`ParameterRule` / `features` flow through the three write paths. Add to **`UpsertModelSpecInput`** (after `keyParams`, line 23):

```ts
  readonly keyParams?: string[] | null | undefined;
  readonly features?: string[] | null | undefined;
  readonly parameterRules?: ParameterRule[] | null | undefined;
```

In **`upsertModelSpec`**'s shared `fields` object (after the `keyParams` line, ~line 60):

```ts
    keyParams: input.keyParams ?? null,
    features: input.features ?? null,
    parameterRules: input.parameterRules ?? null,
```

In **`createModelSpec`**'s `.values({...})` (after `keyParams`, ~line 170):

```ts
      keyParams: input.keyParams ?? null,
      features: input.features ?? null,
      parameterRules: input.parameterRules ?? null,
```

Add to **`UpdateModelSpecInput`** (after `keyParams`, line 198):

```ts
  readonly keyParams?: string[] | null | undefined;
  readonly features?: string[] | null | undefined;
  readonly parameterRules?: ParameterRule[] | null | undefined;
```

In **`updateModelSpec`**'s `set` builder (after the `keyParams` guard, ~line 230):

```ts
if (patch.keyParams !== undefined) set.keyParams = patch.keyParams;
if (patch.features !== undefined) set.features = patch.features;
if (patch.parameterRules !== undefined) set.parameterRules = patch.parameterRules;
```

Add `import type { ParameterRule } from '@actionow/contracts';` at the top.
`ModelSpecRow` is `InferSelectModel<typeof modelSpec>` so it auto-picks up the two new columns — no manual change.

### 3b. `packages/db/src/repositories/model.ts` — freeze `param_profile` from model_spec

**New helper** (add near the top of the model repo, imports `modelSpec`, `getModelSpec` from model-spec repo). It maps a spec row → the frozen `ModelParamProfile`; null spec / empty → `null` (passthrough):

```ts
import { getModelSpec } from './model-spec.js';
import type { ModelParamProfile } from '@actionow/contracts';

/**
 * Build the frozen `param_profile` snapshot from a matched `model_spec` (D1):
 * mirrors how `input_price` is frozen from `official_model_price` at sync.
 * Returns null when the spec is absent or contributes no features/rules, so the
 * model bills/gates exactly as today (empty profile == passthrough).
 */
function freezeParamProfile(
  spec: { features: string[] | null; parameterRules: ParameterRule[] | null } | undefined,
): ModelParamProfile | null {
  if (spec === undefined) return null;
  const features = spec.features ?? [];
  const parameterRules = spec.parameterRules ?? [];
  if (features.length === 0 && parameterRules.length === 0) return null;
  return { features, parameterRules, dropPolicy: 'passthrough' };
}
```

**In `upsertModelsFromSync`** — the sync matches price via `matchOfficialPrice(provider, slug)` against `official_model_price`, but the profile source-of-truth is `model_spec` (规格库). So on the NEW-model insert branch, ALSO look up the spec by `(provider-as-vendor, slug)` and freeze. Add before the `db.insert(model).values({...})` (~line 223):

```ts
// Freeze the param profile from the matched 规格库 spec (D1), same as
// input_price freezes from official_model_price above. Vendor namespace ==
// the provider key used for pricing. Absent/empty spec → null (passthrough).
const spec = await getModelSpec(db, input.provider, m.name);
const paramProfile = freezeParamProfile(spec);
```

and add `paramProfile,` to the `.values({...})` object (alongside `cachedInputPrice`):

```ts
      cachedInputPrice,
      paramProfile,
```

On the EXISTING-model branch (the `if (existing !== undefined)` UPDATE, ~line 175): sync today only refreshes discovery fields and PRESERVES operator edits. Leave `paramProfile` **unset** there (do not overwrite an operator-tuned profile), consistent with how it preserves price/status. Optionally add a refresh only when the model's current `param_profile IS NULL` — but default = preserve (recommended; matches existing "sync never downgrades operator config" invariant).

**`SyncModelInput`** may optionally carry an explicit profile, but D1's flow is spec-driven, so no change needed to that interface.

### 3c. `packages/db/src/repositories/model.ts` — return `param_profile` on ResolvedModel

Add to **`ResolvedModel`** (after `capabilities`, line 249):

```ts
  readonly capabilities: Record<string, boolean>;
  /** Frozen model-level param profile (features/parameterRules/dropPolicy); null → passthrough (today's behavior). */
  readonly paramProfile: ModelParamProfile | null;
```

In **`resolveModelForTenant`**'s `.select({...})` (after `capabilities: model.capabilities`, line 271):

```ts
      capabilities: model.capabilities,
      paramProfile: model.paramProfile,
```

and in the returned object (after `capabilities: row.capabilities`, line 290):

```ts
      capabilities: row.capabilities,
      paramProfile: row.paramProfile ?? null,
```

This is **zero extra query** — `param_profile` is a column on the `model` row already loaded (D1 / §8.3 of the spec). No join to `model_spec` at runtime.

### 3d. `packages/db/src/repositories/model.ts` — model create/update carry param_profile (admin editable)

So `ModelEditor` can edit the frozen profile: add `paramProfile?: ModelParamProfile | null` to **`CreateModelInput`** and **`UpdateModelInput`**, wire the conditional spread into **`createModel`** (`...(input.paramProfile !== undefined ? { paramProfile: input.paramProfile } : {})`) and the guard into **`updateModel`** (`if (patch.paramProfile !== undefined) set.paramProfile = patch.paramProfile;`). `ModelRow`/`ModelView`/`listChannelModels` pick it up via `InferSelectModel` automatically; add `paramProfile: model.paramProfile` to the explicit `listChannelModels` projection (lines 414–435) if the console model list needs to show override status.

### 3e. `packages/db/src/repositories/model.ts` — channel_model param_override get/set

The join-table link fns are here (`linkChannelModel`/`unlinkChannelModel`/`listChannelModels`). Add two focused fns:

```ts
import type { ParamOverride } from '@actionow/contracts';

/** Set (or clear with null) the per-(channel,model) param override. Idempotent; upserts the link if missing so ops can override before a model is explicitly linked. */
export async function setChannelModelOverride(
  db: DbOrTx,
  channelId: string,
  modelId: string,
  override: ParamOverride | null,
): Promise<void> {
  await db
    .insert(channelModel)
    .values({ channelId, modelId, paramOverride: override })
    .onConflictDoUpdate({
      target: [channelModel.channelId, channelModel.modelId],
      set: { paramOverride: override },
    });
}

/** The param override for one (channel, model), or null when unset / unlinked. */
export async function getChannelModelOverride(
  db: DbOrTx,
  channelId: string,
  modelId: string,
): Promise<ParamOverride | null> {
  const rows = await db
    .select({ paramOverride: channelModel.paramOverride })
    .from(channelModel)
    .where(and(eq(channelModel.channelId, channelId), eq(channelModel.modelId, modelId)))
    .limit(1);
  return rows[0]?.paramOverride ?? null;
}
```

`channel_model` PK is `(channelId, modelId)` so the `onConflictDoUpdate` target is the composite PK (no partial-unique / targetWhere needed — this table has no `deleted_at`). `linkChannelModel`'s existing `onConflictDoNothing()` is unaffected (it never touches `paramOverride`, so re-linking preserves an existing override).

---

## 4. Contracts prerequisite (referenced by all `$type<>`)

The schema/repo `$type<ParameterRule>`, `$type<ParamOverride>`, `$type<ModelParamProfile>` require these zod-derived types to exist. Per the spec §4 they live in **`packages/contracts/src/param-profile.ts`** (new; not yet created — confirmed `ls packages/contracts/src` shows only `chat.ts`, `model-test.ts`). That file (schemas: `parameterRuleSchema`, `modelParamProfileSchema` with `dropPolicy` default `'passthrough'`, `paramOpSchema`, `paramOverrideSchema`) is owned by the contracts section, but the DB section depends on its exported TYPES. If the contracts file is not landed in the same PR, use the structural fallbacks noted in §2 (`Array<Record<string, unknown>>` / `{ ops: unknown[] }`) to keep `@actionow/db` self-contained and avoid a build-order cycle.

---

# 3. Engine Pipeline: profile-driven normalize + per-channel override wiring

## Scope & non-breaking invariant

This section wires the four param-binding stages into the engine request path. Response side is untouched except a deferred `native_finish_reason` preservation (Phase 2, out of this slice). **Invariant: an empty `param_profile` + empty `param_override` must produce byte-for-byte the same wire body and the same 400s as today.** Every new step is a guarded no-op when its data is empty, and the profile-driven reasoning-drop path FALLS BACK to the current hardcoded `REASONING_DROPPED_*` lists when the profile declares no reasoning behavior.

Latest data-plane facts confirmed by reading the code:

- `resolveModelForTenant` (`packages/db/src/repositories/model.ts:259`) already SELECTs the `model` row and is the single call `ChatRelayService.buildChatRunRequest` makes to get `ResolvedModel`. Per D1 the frozen `model.param_profile jsonb` column (mig 0062) is added to that SELECT — **zero extra query**.
- Candidate channels are built in `ChannelRoutingService.candidatesFor` (`apps/api/src/common/channel-routing.service.ts:106`), which already knows `modelId` (it calls `listModelChannels(modelId)` in `preferLinkedChannels`). This is where the per-`(model,channel)` `param_override` is loaded and attached to each `RunChannel`.
- `RunChannel` (`packages/engine/src/execution-service.ts:73`) already carries per-channel opaque `config`; the override rides alongside it.
- `AdapterContext` (`packages/contracts/src/adapter.ts:33`) is built per-attempt in `ExecutionService.buildContext` (L1454). Stage ④ dropUnsupported runs AFTER `adapter.buildChatBody`, which lives INSIDE the adapter (`packages/adapters/src/openai.ts:122`) — so ④ cannot be a post-processing step in `buildContext`; it must be applied to the body the adapter returns. The clean seam is: adapter reads `ctx.paramProfile`/`ctx.paramOverride` and applies ②+④ itself via a shared helper, OR the profile's declarative stages ①②③(gate) run BEFORE the adapter (mutating the IR) and only ④ (dropUnsupported on the built body) is applied by the adapter. **Chosen: run ①②③(gate)+applyChannelOverride on the IR in the engine before dispatch; run ④ inside the adapter via a shared `dropUnsupported(body, profile)` helper called at the end of `buildChatBody`.** Rationale below.

---

## 1. New engine module: `packages/engine/src/param-pipeline.ts` (new file)

Pure functions, no DB, no NestJS. Operates on the IR `ChatRequest` (camelCase params + snake_case `extra`). Imports the contracts from `@actionow/contracts` (`ModelParamProfile`, `ParamOverride`, `parameter-templates`).

```ts
import type { ChatRequest, ChatParams } from '@actionow/contracts';
import type { ModelParamProfile, ParameterRule, ParamOverride, ParamOp } from '@actionow/contracts';
import { resolveRule } from '@actionow/contracts'; // template-merge helper from param-templates.ts
import { ProtocolError } from '@actionow/llm-protocol'; // reuse existing 400 carrier

/** Empty-profile sentinel: features:[] + parameterRules:[] + dropPolicy:'passthrough'. */
export function isEmptyProfile(p: ModelParamProfile | undefined): boolean {
  return p === undefined || (p.features.length === 0 && p.parameterRules.length === 0);
}

/**
 * Stage ①: fill defaults for any declared rule whose param is absent from the
 * request. Request value always wins (precedence request > ② > ① > dialect).
 * Only touches params/extra keys the profile NAMES; never invents keys.
 */
export function applyProfileDefaults(req: ChatRequest, profile: ModelParamProfile): ChatRequest;

/**
 * Stage ①(clamp): for each declared rule with min/max, clamp the request value
 * into range. Out-of-range under dropPolicy='error' throws ProtocolError; under
 * 'drop' removes the key; default 'passthrough' clamps silently.
 */
export function clampToRules(req: ChatRequest, profile: ModelParamProfile): ChatRequest;

/**
 * Stage ③ (gate) — the profile-driven SUPERSET of today's normalizeRequest.
 * REPLACES the capability gate + reasoning-downgrade. See §3 for fallback.
 */
export function gate(
  req: ChatRequest,
  profile: ModelParamProfile,
  caps: ModelCapabilities,
): ChatRequest;

/**
 * Stage ②: apply the per-(model,channel) override ops (set/clamp/delete) with
 * optional `when.modelMatches`. Runs per-candidate-channel in buildContext,
 * AFTER ①③ and BEFORE the adapter. Precedence: ② overrides ① and request-clamp
 * but is itself the operator's authoritative value (② > request only for `set`
 * with force semantics; a plain request value that ② doesn't touch survives).
 */
export function applyChannelOverride(
  req: ChatRequest,
  override: ParamOverride | undefined,
  servedModel: string | undefined, // for when.modelMatches
): ChatRequest;

/**
 * Stage ④: DROP unsupported params from the FINAL wire body. Default passthrough
 * = only drop a param that is BOTH a known-standard OpenAI sampling key AND not
 * declared/allowed by the profile; NEVER drop a non-standard extra key. Applied
 * inside the adapter at the end of buildChatBody. Empty/passthrough profile → returns body unchanged.
 */
export function dropUnsupported(
  body: Record<string, unknown>,
  profile: ModelParamProfile | undefined,
): Record<string, unknown>;
```

Precedence enforced by ordering + by `applyChannelOverride` running last on the IR: `request` seeds params → `applyProfileDefaults` only fills absent → `clampToRules` bounds → `gate` strips capability-illegal → `applyChannelOverride` set/clamp/delete (operator wins) → adapter maps → `dropUnsupported` prunes. This is exactly `request > ② > ① > dialect default` for values, with gate/drop as the safety envelope.

Each function returns the SAME reference when it changes nothing (mirror the existing `withoutKeys`/`downgradeForReasoning` pattern in `normalize.ts:73-107`) so an empty profile allocates nothing.

---

## 2. Carry profile + override into the engine (RunRequest / RunChannel additions)

### `ResolvedModel` (both `packages/db/src/repositories/model.ts:242` and `apps/api/src/chat/model-resolver.service.ts:13`)

Add the frozen snapshot, read from the new `model.param_profile` column in the `resolveModelForTenant` SELECT:

```ts
export interface ResolvedModel {
  // ...existing...
  /** Frozen model-level param profile (mig 0062). Absent/empty → today's behavior. */
  readonly paramProfile?: ModelParamProfile | undefined;
}
```

In `resolveModelForTenant` add `paramProfile: model.paramProfile` to the `.select({...})` and map it through (parse jsonb via `modelParamProfileSchema.parse` at the API boundary, or trust the frozen shape and cast — prefer a lenient `safeParse` with fallback to `{features:[],parameterRules:[],dropPolicy:'passthrough'}` so a malformed frozen blob can never 500 a relay).

### `RunRequest` (`packages/engine/src/execution-service.ts:127`)

```ts
export interface RunRequest {
  // ...existing...
  /**
   * Model-level param profile (① defaults/clamp + ③ gate + ④ dropPolicy). Carried
   * from chat-relay (frozen on the resolved model, mig 0062). Absent/empty →
   * pipeline is a no-op and the run is byte-for-byte identical to today.
   */
  paramProfile?: ModelParamProfile | undefined;
}
```

### `RunChannel` (`packages/engine/src/execution-service.ts:73`)

```ts
export interface RunChannel {
  // ...existing (config, faultPolicy, etc.)...
  /**
   * Per-(model,channel) param override (② set/clamp/delete). Loaded from
   * channel_model.param_override for the RESOLVED model in candidatesFor. Absent →
   * no per-channel override (byte-for-byte identical). Applied in buildContext
   * BEFORE adapter.buildChatBody.
   */
  paramOverride?: ParamOverride | undefined;
}
```

### `AdapterContext` (`packages/contracts/src/adapter.ts:33`)

The adapter needs the profile for stage ④ (dropUnsupported runs at the end of `buildChatBody`, which is inside the adapter). Add:

```ts
export interface AdapterContext {
  // ...existing...
  /**
   * Frozen model param profile (mig 0062). The adapter applies stage ④
   * dropUnsupported(body, paramProfile) at the end of buildChatBody. Absent/empty
   * → no drop (identical to today). Consumed ONLY for dropPolicy; the declarative
   * stages ①②③ already ran on the IR before dispatch.
   */
  paramProfile?: ModelParamProfile;
}
```

Note: `paramOverride` is NOT put on `AdapterContext` — stage ② mutates the IR in the engine (`buildContext` → applied to a per-attempt IR copy, see §4), so the adapter receives an already-overridden `ir`. Only the profile crosses into the adapter (for ④).

---

## 3. Rework `normalize.ts` → profile-driven gate with fallback (stage ③)

`packages/llm-protocol/src/normalize.ts` keeps `normalizeRequest(req, caps)` as the PUBLIC signature (chat-relay still calls it) but its body becomes profile-aware. Add an overload/second arg:

```ts
export function normalizeRequest(
  req: ChatRequest,
  caps: ModelCapabilities,
  profile?: ModelParamProfile,
): ChatRequest {
  // 1) Capability misuse gate — UNCHANGED (keep the 4 existing 400s: tools/json/
  //    vision/audio/file). These stay regardless of profile.
  //    ... existing lines 42-62 verbatim ...

  // 2) Reasoning downgrade — PROFILE-DRIVEN with fallback:
  if (profile !== undefined && hasReasoningRules(profile)) {
    // Drop-list comes from the profile: a rule declaring `dropForReasoning: true`
    // (or absence of a param from an allowed set) determines what to strip.
    return downgradeByProfile(req, profile);
  }
  // FALLBACK: no profile OR profile declares nothing about reasoning → today's
  // behavior exactly (hardcoded REASONING_DROPPED_PARAMS/EXTRA when caps.reasoning).
  return caps.reasoning === true ? downgradeForReasoning(req) : req;
}
```

- Keep `REASONING_DROPPED_PARAMS` / `REASONING_DROPPED_EXTRA` / `downgradeForReasoning` / `withoutKeys` EXACTLY as-is (lines 11-107) — they are the fallback path.
- `hasReasoningRules(profile)`: true iff `profile.features.includes('reasoning')` AND at least one `parameterRule` expresses a drop (the simplest Phase-1 encoding: the profile's `parameterRules` enumerate the ALLOWED params for a reasoning model, and any standard sampling key NOT in that allow-set is dropped — mirrors LiteLLM `get_supported_openai_params`). This makes the drop-list per-model instead of a global constant.
- `downgradeByProfile(req, profile)`: builds the drop set from `profile` (standard sampling/penalty keys minus the profile-allowed set) and reuses `withoutKeys` for both `req.params` and `req.extra`, preserving the same-reference-when-clean optimization.

The clamp/default stages (① `applyProfileDefaults` + `clampToRules`) run in `param-pipeline.ts`, NOT inside `normalizeRequest`, so they can be sequenced independently. `normalizeRequest` remains ONLY the gate (③). This keeps the existing single call-site in chat-relay minimal; ①② are added around it (§5).

---

## 4. Where stage ② hooks in (per-candidate-channel, in the engine)

`applyChannelOverride` must run per-channel because the override is per-`(model,channel)` — different candidate channels of the same model can carry different overrides, and `when.modelMatches` needs the served channel's model id. The routing closure already resolves per-channel, so hook it there.

In `ExecutionService.executeChat` (`execution-service.ts:571`), inside the `routeBlocking` callback (currently at L591-608), apply the override to a PER-ATTEMPT copy of the IR before `adapter.chat(ir, ctx)`:

```ts
async (channel) => {
  const adapter = this.deps.adapters.get(channel.providerType ?? req.resource.providerType);
  if (adapter.chat === undefined) {
    /* existing throw */
  }
  const boundChat = adapter.chat.bind(adapter);
  const ctx = await this.buildContext(req, channel, jobId);
  // Stage ②: per-(model,channel) override on a per-attempt IR copy. No-op +
  // same-ref when channel.paramOverride is absent → identical to today.
  const attemptIr = applyChannelOverride(ir, channel.paramOverride, channel.model);
  const r = await runWithFaultPolicy(channel.faultPolicy, () => boundChat(attemptIr, ctx));
  served = channel;
  return r;
};
```

The same one-line insertion goes into `executeEmbed`/`executeRerank`/`executeModerate`/`executeTranscribe`/`runBlocking` ONLY IF those modalities are in Phase-1 scope. Per D4 (media out) and the SECTION focus on chat sampling params, the override applies to the CHAT path; the other blocking bodies pass `req.inputs` directly to adapters without an IR sampling layer, so they are left untouched (empty-override equivalence holds trivially — they never read `paramOverride`).

For the STREAMING chat path, stage ② must run inside `stream.ts` where the per-candidate channel is selected in `openChatStreamCommit`. Thread the same `applyChannelOverride(ir, channel.paramOverride, channel.model)` at the point the stream's `buildContext`-equivalent selects a channel and before it calls `adapter.streamChat(ir, ctx)`. (The stream module owns its own per-channel loop per the P2 streaming-fallback design; the hook is symmetric — one call, same-ref-when-empty.)

`buildContext` (`execution-service.ts:1454`) gets ONE addition — thread the profile onto the ctx for stage ④:

```ts
const ctx: AdapterContext = { providerType, http: /* existing */ };
// ...existing model/endpoint/apiKey/proxyUrl/config assignments...
if (req.paramProfile !== undefined && !isEmptyProfile(req.paramProfile)) {
  ctx.paramProfile = req.paramProfile;
}
return ctx;
```

---

## 5. Where stages ① + ③ hook in (chat-relay, before the engine)

`ChatRelayService.buildChatRunRequest` (`apps/api/src/chat/chat-relay.service.ts:217`) is the single place the IR is normalized. Replace the single `normalizeRequest` call (L230) with the ①③ sequence, then attach the profile to the RunRequest and the override to each channel.

Current L225-230:

```ts
const resolved = await this.resolver.resolve(modelName, ctx.tenantId);
const normalizedIr = normalizeRequest(ir, readCapabilities(resolved.capabilities));
```

becomes:

```ts
const resolved = await this.resolver.resolve(modelName, ctx.tenantId);
const profile = resolved.paramProfile; // frozen, mig 0062; may be undefined/empty
const caps = readCapabilities(resolved.capabilities);
// ① defaults + clamp (no-op when profile empty), then ③ gate (profile-driven,
// falls back to the hardcoded reasoning drop-list when profile declares nothing).
let normalizedIr = ir;
if (profile !== undefined && !isEmptyProfile(profile)) {
  normalizedIr = applyProfileDefaults(normalizedIr, profile);
  normalizedIr = clampToRules(normalizedIr, profile);
}
normalizedIr = normalizeRequest(normalizedIr, caps, profile);
```

(`applyProfileDefaults`/`clampToRules`/`isEmptyProfile` imported from `@actionow/engine` or a shared `@actionow/llm-protocol` — put them in `llm-protocol` next to `normalize.ts` so both the engine and the API can import without a cycle; the engine re-exports them for §4's `applyChannelOverride`. Simplest: ALL five pipeline fns live in `@actionow/llm-protocol` and the engine imports from there.)

Then in the RunRequest construction (L272-290) attach the profile:

```ts
const req: RunRequest = {
  /* ...existing... */
};
if (profile !== undefined && !isEmptyProfile(profile)) req.paramProfile = profile;
```

The per-channel `paramOverride` is attached NOT here but in `candidatesFor` (§6), because that is where channel rows are loaded and the resolved `modelId` is known. `channels` returned from `this.routing.candidatesFor(resourceId, ctx.routeGroupId, resolved.modelId, routeTag)` already carry it.

The downgraded/overridden IR must flow into BOTH `inputs.__ir` (already the case: `inputs: { [IR_KEY]: normalizedIr }`) AND the stream estimate (`estimateStreamUsage(normalizedIr)` at L314) — already reads `normalizedIr`, so no change beyond the variable now holding the ①③ result.

---

## 6. Load `param_override` in candidatesFor (stage ② data source)

`ChannelRoutingService.candidatesFor` (`apps/api/src/common/channel-routing.service.ts:106`) already receives `modelId` and calls `listModelChannels(modelId)`. Add a batch load of `channel_model.param_override` for `(modelId, candidateChannelIds)` and stamp it onto each `RunChannel`. New repo fn:

```ts
// packages/db/src/repositories/model.ts
/** Map channelId → frozen param_override jsonb for (modelId, channelIds). Empty when unset. */
export async function getChannelModelOverrides(
  db: DbOrTx,
  modelId: string,
  channelIds: string[],
): Promise<Map<string, ParamOverride>> {
  /* SELECT channel_id, param_override FROM channel_model WHERE model_id = ? AND channel_id = ANY(?) AND param_override IS NOT NULL */
}
```

Then after `preferLinkedChannels` (end of `candidatesFor`), before return:

```ts
if (modelId !== undefined && base.length > 0) {
  const overrides = await getChannelModelOverrides(
    this.db,
    modelId,
    base.map((c) => c.id),
  );
  for (const c of base) {
    const ov = overrides.get(c.id);
    if (ov !== undefined) c.paramOverride = ov;
  }
}
return this.preferLinkedChannels(base, modelId);
```

This is one extra query per relay (same cost tier as `listModelChannels`), no N+1. Empty result → no `paramOverride` set → identical to today.

---

## 7. Stage ④ inside the OpenAI adapter (dropUnsupported)

`packages/adapters/src/openai.ts:122` `buildChatBody` — add ONE line before `return body;` (L185):

```ts
return dropUnsupported(body, ctx.paramProfile);
```

`dropUnsupported` (imported from `@actionow/llm-protocol`) with a passthrough/empty profile RETURNS THE SAME BODY REFERENCE — so the existing byte-for-byte body is preserved. It only removes a key when the profile's `dropPolicy` is `drop`/`error` AND the key is a known-standard sampling key absent from the profile's allow-set. The current `body = { ...(ir.extra ?? {}) }` spread that carries non-standard extra (`top_k`, `logit_bias`, `prompt_cache_key`, …) is PRESERVED — ④ never touches non-standard keys (passthrough for extra is the LiteLLM semantic, locked in the profile's `dropPolicy` default). Anthropic/Gemini adapters get the same one-line call at the end of their `buildChatBody` in a follow-up; scope this SECTION to openai (the reference dialect).

---

## Precedence summary (enforced end-to-end)

| Source                  | Applied at                                    | Wins over                                                     |
| ----------------------- | --------------------------------------------- | ------------------------------------------------------------- |
| request IR params/extra | client body                                   | (seed)                                                        |
| ① profile default       | chat-relay `applyProfileDefaults`             | fills only ABSENT keys (request wins)                         |
| ① profile clamp         | chat-relay `clampToRules`                     | bounds request value into rule min/max                        |
| ③ gate                  | `normalizeRequest(...,profile)`               | strips capability-illegal + reasoning-rejected                |
| ② channel override      | engine `applyChannelOverride` (per-candidate) | operator set/clamp/delete — authoritative per (model,channel) |
| ③ dialect map           | `adapter.buildChatBody`                       | wire rendering (unchanged)                                    |
| ④ dropUnsupported       | `adapter` end of buildChatBody                | prunes known-standard-unsupported only                        |

Net: `request > ② > ① > dialect`, with ③ gate and ④ drop as the correctness envelope. Empty profile + empty override collapses every new step to a same-reference no-op → today's bytes and today's 400s.

## Non-breaking test anchors

- Existing `normalize.spec` reasoning-downgrade assertions must pass UNCHANGED with `profile=undefined` (fallback path).
- Add a golden test: given empty profile/override, `buildChatBody` output is deep-equal to the pre-change output for a representative request (temperature/top_p/max_tokens/stop/response_format/reasoning_effort + a `top_k` extra).
- Each e2e file owns its PG container (convention) — the override load in `candidatesFor` needs a `channel_model.param_override` fixture only in the override-specific test; all other relay e2e run with NULL override (no behavior change).

---

# 4. FRONTEND — Model Parameter Profile Editor, Per-(Model×Channel) Override Panel & Model-Centric View

Scope = the apps/web console surfaces for the two new data levels (① `model.param_profile`, ② `channel_model.param_override`) plus a model-centric view. All net-new; nothing existing is removed. Every `t(...)` key below must be added to BOTH `apps/web/src/i18n/locales/en/console.json` and `.../zh-CN/console.json`.

Backend contract dependency (from the API section — this section consumes it): `ModelView` gains `param_profile: ModelParamProfileView | null`; `getModel` returns it; `updateModel` accepts `paramProfile`. `ChannelModelView` (or the row returned by `listChannelModels` — today it's `ModelView[]`) gains `param_override: ParamOverrideView | null`; new endpoints `PATCH /admin/resources/{rid}/channels/{cid}/models/{modelId}/param-override` and `GET /admin/model-specs?modelId=` are assumed. Types `ModelParamProfileView`, `ParameterRuleView`, `ParamOverrideView`, `ParamOpView`, `ModelSpecView` are exported from `@actionow/sdk` contracts and re-exported in `apps/web/src/lib/api/types.ts`.

---

## (a) ParameterRulesEditor + FeaturesField inside ModelEditor

### A1. New enum: PARAM_FEATURES (upgrade of CAPABILITIES)

`apps/web/src/lib/api/enums.ts` — add below the existing `CAPABILITIES` block. Keep `CAPABILITIES` (used elsewhere) but add the finer feature set the profile edits:

```ts
/** Fine-grained model `param_profile.features` (Dify `features`). Open-ended;
 *  unknown feature strings carried on a synced profile are preserved + shown raw. */
export const PARAM_FEATURES: CapabilityDef[] = [
  { key: 'tool-call', labelKey: 'enums.feature.toolCall' },
  { key: 'parallel-tool', labelKey: 'enums.feature.parallelTool' },
  { key: 'vision', labelKey: 'enums.feature.vision' },
  { key: 'audio', labelKey: 'enums.feature.audio' },
  { key: 'json-object', labelKey: 'enums.feature.jsonObject' },
  { key: 'json-schema', labelKey: 'enums.feature.jsonSchema' },
  { key: 'reasoning', labelKey: 'enums.feature.reasoning' },
  { key: 'stream', labelKey: 'enums.feature.stream' },
  { key: 'stream-tool-call', labelKey: 'enums.feature.streamToolCall' },
];

/** Param rule value types (contract `parameterRuleSchema.type`). */
export const PARAM_RULE_TYPES = ['float', 'int', 'boolean', 'string', 'enum', 'json'] as const;

/** Known `use_template` names (mirrors packages/contracts/src/param-templates.ts PARAM_TEMPLATES keys). */
export const PARAM_TEMPLATES = [
  'temperature',
  'top_p',
  'top_k',
  'max_tokens',
  'response_format',
  'reasoning_effort',
  'stop',
  'seed',
  'frequency_penalty',
  'presence_penalty',
] as const;

/** dropPolicy enum (contract DROP_POLICIES). */
export const DROP_POLICIES = ['passthrough', 'drop', 'error'] as const;
```

### A2. FeaturesField — `apps/web/src/components/data/FeaturesField.tsx` (NEW)

A near-copy of `CapabilitiesField` but over `string[]` (not `Record<string,boolean>`), reading `PARAM_FEATURES`. Prop shape:

```ts
export function FeaturesField(props: {
  value: string[];
  onChange: (next: string[]) => void;
  label?: string;
  tooltip?: string;
  hint?: string;
}): JSX.Element;
```

Renders one `<Toggle>` per `PARAM_FEATURES` entry (`checked={value.includes(key)}`, toggling adds/removes the key from the array) plus a `<Toggle>` per unknown key already in `value` (labelled by raw key) so synced-in features are never dropped. Uses `FormField` + `useFieldId` exactly like `CapabilitiesField`. Do NOT delete `CapabilitiesField` — `param_profile.features` is a NEW field; the legacy coarse `capabilities` map stays wired until the backend migration collapses it (design §6). ModelEditor renders BOTH during the transition (features under the new "参数档案" section; capabilities stays where it is).

### A3. ParameterRulesEditor — `apps/web/src/components/data/ParameterRulesEditor.tsx` (NEW)

The core new editor: a repeatable list of structured rule rows (modeled on `KeyValueEditor`'s add/remove/set-row pattern, NOT raw JSON). Prop shape:

```ts
export interface ParameterRuleDraft {
  name: string;
  useTemplate?: string; // '' in the select == none
  type?: 'float' | 'int' | 'boolean' | 'string' | 'enum' | 'json';
  default?: unknown;
  min?: number;
  max?: number;
  required?: boolean;
  options?: string[]; // only when type === 'enum'
  help?: string;
}

export function ParameterRulesEditor(props: {
  value: ParameterRuleDraft[];
  onChange: (next: ParameterRuleDraft[]) => void;
  label?: string;
  tooltip?: string;
}): JSX.Element;
```

Each row is a bordered `.panel` card (radius `var(--r-sm)`, padding `var(--s-3)`, `display:flex; flex-direction:column; gap:var(--s-2)`) with:

- Row 1: `<TextField inline label=name>` (the param name, `.field`, `.mono`) + `<SelectField inline label=模板 options=[{value:'',label:t('models.param.templateNone')}, ...PARAM_TEMPLATES.map(v=>({value:v,label:v}))]>`. Picking a template collapses the row to a chip summary (the template supplies type/min/max/default) — the remaining fields hide behind a "覆盖" (override) `Button variant="ghost" size="sm"` disclosure, matching the design's `useTemplate`-then-override semantics.
- Row 2 (only when no template OR override open): `<SelectField inline label=类型 options=toOptions-style over PARAM_RULE_TYPES>` + a value input whose control switches on `type`: `float`/`int` → two `<NumberField>` (min, max) + one `<TextField>`/`<NumberField>` default; `boolean` → `<SelectField>` true/false/unset for default; `enum` → `<ChipsField label=选项>` for `options` + `<SelectField>` default constrained to the options; `string`/`json` → `<TextField>`/`<JsonField>` default.
- Row 3: `<Toggle label=必填>` for `required` + `<TextField label=说明>` for `help`.
- Row trailing: a `RowAction icon={TrashIcon}` delete.
- Footer: `Button variant="ghost"` `+ 添加参数` that appends `{ name: '' }`; a duplicate-name guard shows inline error `t('models.param.dupName')`.

`onChange` always returns the full array; empty-named rows are filtered at ModelEditor submit time (see A4), mirroring how `objectFromRows` drops blank keys.

### A4. ModelEditor wiring — `apps/web/src/features/console/ModelEditor.tsx`

Add profile state + a "参数档案" section between `CapabilitiesField` (line ~317) and the `visibility` `SelectField`:

```ts
// --- param profile state (model.param_profile) ---
const [features, setFeatures] = useState<string[]>([]);
const [parameterRules, setParameterRules] = useState<ParameterRuleDraft[]>([]);
const [dropPolicy, setDropPolicy] = useState<'passthrough' | 'drop' | 'error'>('passthrough');
```

Seed in the existing `useEffect(() => { if (!editing || m === undefined) return; ... }, [editing, m])` block:

```ts
setFeatures([...(m.param_profile?.features ?? [])]);
setParameterRules((m.param_profile?.parameter_rules ?? []).map(toRuleDraft)); // snake→camel adapter
setDropPolicy((m.param_profile?.drop_policy as any) ?? 'passthrough');
```

Both `update` and `create` mutations attach `paramProfile` to the body:

```ts
paramProfile: {
  features,
  parameterRules: parameterRules
    .filter((r) => r.name.trim() !== '')
    .map(fromRuleDraft),          // camel request shape
  dropPolicy,
},
```

(On create, spread conditionally like the other optionals: `...(features.length || parameterRules.length ? { paramProfile: {...} } : {})`.)

JSX section (new), rendered in edit mode and create mode:

```tsx
<div
  className="panel"
  style={{
    padding: 'var(--s-3)',
    borderRadius: 'var(--r-md)',
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--s-3)',
  }}
>
  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)' }}>
    <span style={{ fontWeight: 'var(--fw-semibold)' }}>{t('models.param.title')}</span>
    <span style={{ flex: 1 }} />
    <Button
      variant="ghost"
      size="sm"
      onClick={() => importSpec.mutate()}
      loading={importSpec.isPending}
      disabled={!editing && nameField.trim() === ''}
    >
      {t('models.param.importFromSpec')}
    </Button>
  </div>
  <FeaturesField
    label={t('models.param.features')}
    tooltip={t('models.tip.features')}
    value={features}
    onChange={setFeatures}
  />
  <ParameterRulesEditor
    label={t('models.param.rules')}
    tooltip={t('models.tip.rules')}
    value={parameterRules}
    onChange={setParameterRules}
  />
  <SelectField
    inline
    label={t('models.param.dropPolicy')}
    tooltip={t('models.tip.dropPolicy')}
    value={dropPolicy}
    onChange={(v) => setDropPolicy(v as any)}
    options={DROP_POLICIES.map((p) => ({ value: p, label: t('models.param.dropPolicy_' + p) }))}
  />
</div>
```

### A5. "从规格库导入" (importFromSpec) action

A mutation on ModelEditor that pulls the `model_spec` catalog row and seeds features + parameterRules (design D1: profile is FROZEN from `model_spec`; this button lets the operator re-pull on demand). Because `model_spec` today only carries `key_params: string[]`, the mapper is: each `key_params[i]` → `{ name, useTemplate: PARAM_TEMPLATES.includes(name) ? name : undefined }`. When the backend upgrades `model_spec` with structured `parameter_rules`/`features` (design mig 0062), the mapper reads those directly.

```ts
const importSpec = useMutation({
  mutationFn: () => api.getModelSpecByModel(nameField.trim()), // GET /admin/model-specs?modelId=<name> → first match
  onSuccess: (spec) => {
    if (spec === null) {
      toast(t('models.param.noSpec'));
      return;
    }
    setFeatures(specToFeatures(spec)); // spec.features ?? derive from spec.type/modalities
    setParameterRules(specToRules(spec)); // spec.parameter_rules ?? key_params → drafts
    toast(t('models.param.imported'));
  },
  onError: mutationError(t),
});
```

Non-destructive UX: since import overwrites the two fields, gate it behind a `ConfirmDialog` (reuse the existing component) when `parameterRules.length > 0` so a populated profile isn't clobbered silently.

---

## (b) Per-(model×channel) 参数覆盖 panel

### B1. Client + type

`channel_model.param_override` shape (contract `ParamOverrideView` = `{ ops: ParamOpView[] }`, `ParamOpView = { op:'set'|'clamp'|'delete'; name:string; value?:unknown; min?:number; max?:number; when?:{ modelMatches?:string } }`). New admin client method (raw client, like `linkChannelModel`) + queryKey.

### B2. ParamOverrideEditor — `apps/web/src/features/console/ParamOverrideEditor.tsx` (NEW, a `Drawer`)

Reachable from a channel-model row (see B3). Prop shape:

```ts
export function ParamOverrideEditor(props: {
  resourceId: string;
  channelId: string;
  modelId: string;
  modelName: string; // for the drawer title
  onClose: () => void;
}): JSX.Element;
```

Fetches current override (`useQuery(qk.channelModelOverride(channelId, modelId), () => api.getChannelModelOverride(...))`), seeds a `ParamOpDraft[]` list. A repeatable op-row editor (same card pattern as ParameterRulesEditor):

- `<SelectField inline label=操作 options=[set|clamp|delete]>` (`op`)
- `<TextField inline label=参数 .mono>` (`name`; supports dot-path per design, e.g. `extra.enable_thinking`)
- value control keyed on `op`: `set` → `<TextField>`/`<NumberField>`/`<JsonField>` for `value`; `clamp` → two `<NumberField>` (`min`,`max`); `delete` → no value.
- Optional condition disclosure: `<TextField label=当模型匹配 hint=正则/前缀>` writing `when.modelMatches` (design: "同渠道多模型" conditional).
- Trailing `RowAction TrashIcon` delete; footer `+ 添加操作`.
  Save mutation → `api.setChannelModelOverride(resourceId, channelId, modelId, { ops })`, invalidates `qk.channelModels(channelId)` + `qk.channelModelOverride(channelId, modelId)`, toast `t('override.saved')`. An empty `ops` array clears the override (== 现状, design §6).

### B3. Entry point — ModelAccessPage col-3 (`ModelAccessPage.tsx`) + ModelGrid

Col-3 lists the selected channel's models via `ModelGrid` (variant="list"). Add a per-row action "参数覆盖" that opens `ParamOverrideEditor` scoped to `(selectedChannel, model)`. Two touch points:

- `ModelGrid` (`apps/web/src/features/console/ModelGrid.tsx`): add an optional `onOverrideModel?: (m: ModelView) => void` prop; when present, render a `RowAction`/`Button size="sm"` per row (`t('override.edit')`) alongside the existing edit affordance. Show a small `.chip` badge `t('override.active')` when `m.param_override` is non-null/non-empty so operators see which links are customized.
- `ModelAccessPage`: new state `const [overrideEdit, setOverrideEdit] = useState<ModelView | null>(null);`, pass `onOverrideModel={setOverrideEdit}` to the col-3 `ModelGrid`, and render:

```tsx
{
  overrideEdit !== null && selectedChannel !== undefined && (
    <ParamOverrideEditor
      key={overrideEdit.id}
      resourceId={selectedChannel.resource_id}
      channelId={selectedChannel.id}
      modelId={overrideEdit.id}
      modelName={overrideEdit.name}
      onClose={() => setOverrideEdit(null)}
    />
  );
}
```

This is the "reachable from ModelAccessPage col-3 / a channel-model row" requirement. The override is per-(model,channel), so it MUST carry the channel from `selectedChannel` — never editable from the flat catalog (ModelsCatalogPage) where no channel is selected.

---

## (c) Model-centric view (model as primary entity → serving channels + override state)

### C1. Placement — extend ModelDetailDrawer, do NOT add a 4th pane

The existing 3-pane (插件→通道→模型) is接入-oriented and stays. The model-centric view is added as a "服务通道" (serving channels) tab/section inside the existing `ModelDetailDrawer.tsx` (already opened from `ModelsCatalogPage` rows and from ModelGrid). This composes cleanly: catalog row → drawer → the model as primary entity, listing every serving channel with its override state, without disturbing the 3-pane. (Design §7.1 says "与现有三栏并存"; a drawer tab is the lowest-friction realization and reuses `model.served_channel_ids`.)

### C2. ServingChannelsPanel — inside `ModelDetailDrawer.tsx` (new section) or `apps/web/src/features/console/ServingChannelsPanel.tsx` (NEW)

Prop shape:

```ts
export function ServingChannelsPanel(props: { model: ModelView }): JSX.Element;
```

Renders a `DataTable<ServingChannelRow>` (or compact card list) where each row = one channel from `model.served_channel_ids`, resolved via a query over channels. Columns:

- 通道 (`BrandIcon` + provider_type/endpoint), from ChannelView
- 状态 (`StatusBadge`)
- 参数覆盖: a `.chip` — `t('override.active')` (accent) when that `(model,channel)` has a non-empty `param_override`, else `t('override.none')` (muted). Requires the override state per link; obtain via `model.param_override_channel_ids?: string[]` added to `ModelView` (cheapest — one array on the model row) OR a batched `getModelOverrides(modelId)` query. Prefer the former (mirrors `served_channel_ids`) — flag to the API section.
- action: "编辑覆盖" `Button size="sm"` opening `ParamOverrideEditor` with `resourceId = channel.resource_id`, `channelId = channel.id`, `modelId = model.id`. This makes the override reachable from the model-centric side too.

The model-centric view is READ + drill-to-edit; the authoritative override editor is the single shared `ParamOverrideEditor` (b). No duplicate editor.

---

## (d) admin.ts client methods + queryKeys + i18n

### D1. `apps/web/src/lib/api/admin.ts` — new methods (raw client, alongside `linkChannelModel`)

```ts
// param-override on a channel_model link (design ②). Raw — not in the generated SDK path set.
getChannelModelOverride: (resourceId: string, channelId: string, modelId: string) =>
  rawClient.get<ParamOverrideView | null>(
    `/admin/resources/${resourceId}/channels/${channelId}/models/${encodeURIComponent(modelId)}/param-override`),
setChannelModelOverride: (resourceId: string, channelId: string, modelId: string, body: ParamOverrideBody) =>
  rawClient.put<ParamOverrideView>(
    `/admin/resources/${resourceId}/channels/${channelId}/models/${encodeURIComponent(modelId)}/param-override`, body),

// 规格库 read for “从规格库导入” (design D1). First match by model_id.
getModelSpecByModel: async (modelId: string): Promise<ModelSpecView | null> => {
  const rows = await rawClient.get<ModelSpecView[]>(
    `/admin/model-specs?modelId=${encodeURIComponent(modelId)}`);
  return rows[0] ?? null;
},
```

`updateModel`/`createModel` bodies already flow through `UpdateModelBody`/`CreateModelBody` — no signature change, just the new optional `paramProfile` field (added contract-side in the API section; `admin.ts` passes it through untouched).

### D2. `apps/web/src/lib/api/queryKeys.ts` — additions

```ts
channelModelOverride: (channelId: string, modelId: string) =>
  ['admin', 'channels', channelId, 'models', modelId, 'param-override'] as const,
modelSpecByModel: (modelId: string) => ['admin', 'model-specs', 'by-model', modelId] as const,
```

(`qk.channelModels(channelId)` is reused/invalidated on override save so the col-3 list re-fetches the `param_override` badge state.)

### D3. `apps/web/src/lib/api/types.ts` — re-export the new contract types

Add `ModelParamProfileView`, `ParameterRuleView`, `ParamOverrideView`, `ParamOpView`, `ParamOverrideBody`, `ModelSpecView` to the type re-export list (they already exist in `@actionow/sdk` contracts once the API section lands them).

### D4. i18n keys (en + zh-CN, namespace `console`)

```
enums.feature.toolCall            "Tool calling"            / "工具调用"
enums.feature.parallelTool        "Parallel tools"          / "并行工具"
enums.feature.vision              "Vision"                  / "视觉"
enums.feature.audio               "Audio"                   / "音频"
enums.feature.jsonObject          "JSON object"             / "JSON 对象"
enums.feature.jsonSchema          "JSON schema"             / "JSON 结构化"
enums.feature.reasoning           "Reasoning"               / "推理"
enums.feature.stream              "Streaming"               / "流式"
enums.feature.streamToolCall      "Streaming tool calls"    / "流式工具调用"

models.param.title                "Parameter profile"       / "参数档案"
models.param.features             "Features"                / "能力特性"
models.param.rules                "Parameter rules"         / "参数规则"
models.param.dropPolicy           "Unsupported params"      / "不支持参数处理"
models.param.dropPolicy_passthrough "Pass through"          / "透传"
models.param.dropPolicy_drop      "Drop"                    / "丢弃"
models.param.dropPolicy_error     "Reject (400)"            / "拒绝 (400)"
models.param.templateNone         "None"                    / "无模板"
models.param.importFromSpec       "Import from spec catalog"/ "从规格库导入"
models.param.imported             "Imported from spec"      / "已从规格库导入"
models.param.noSpec               "No matching spec row"    / "规格库无匹配条目"
models.param.dupName              "Duplicate parameter name"/ "参数名重复"
models.param.addRule              "Add parameter"           / "添加参数"
models.param.override             "Override"                / "覆盖"
models.param.ruleType             "Type"                    / "类型"
models.param.ruleDefault          "Default"                 / "默认值"
models.param.ruleMin              "Min"                     / "最小值"
models.param.ruleMax              "Max"                     / "最大值"
models.param.ruleRequired         "Required"                / "必填"
models.param.ruleOptions          "Options"                 / "选项"
models.param.ruleHelp             "Help"                    / "说明"
models.tip.features               "Fine-grained capabilities used to gate/downgrade requests." / "用于请求门控/降级的细粒度能力。"
models.tip.rules                  "Per-model parameter contract: default / clamp / gate / declare model-specific params." / "模型级参数契约：默认/裁剪/门控/声明模型专属参数。"
models.tip.dropPolicy             "How to handle known params this model does not support." / "如何处理该模型不支持的已知参数。"

override.title                    "Parameter override"      / "参数覆盖"
override.editTitle                "Override · {{model}}"    / "参数覆盖 · {{model}}"
override.edit                     "Override"                / "参数覆盖"
override.active                   "Overridden"              / "已覆盖"
override.none                     "Default"                 / "默认"
override.saved                    "Override saved"          / "参数覆盖已保存"
override.addOp                    "Add operation"           / "添加操作"
override.op                       "Operation"               / "操作"
override.op_set                   "Set"                     / "强制设置"
override.op_clamp                 "Clamp"                   / "裁剪"
override.op_delete                "Delete"                  / "删除"
override.opName                   "Parameter"               / "参数"
override.opValue                  "Value"                   / "值"
override.when                     "When model matches"      / "当模型匹配"
override.whenHint                 "Optional regex/prefix; applies only to matching models on this channel." / "可选正则/前缀；仅对本通道匹配的模型生效。"
override.servingChannels          "Serving channels"        / "服务通道"
```

---

## Design-system conformance

- Fields via `TextField`/`NumberField`/`SelectField`/`JsonField`/`ChipsField`/`Toggle`/`FormField` (`.field` class inherited) — never raw `<input>` except inside those primitives. Use `inline` label mode for compact rule/op rows.
- Buttons: `Button variant="ghost"|"cta" size="sm"`, `RowAction`/`IconButton` for row-level; accent surfaces use `var(--accent)` (NOT `--cta`).
- Editors are `Drawer`-hosted (`ParamOverrideEditor`) or inline `.panel` sections (`ParameterRulesEditor`), matching `PluginEditor`/`ChannelEditor`. Row cards: `.panel`, `var(--r-sm)`, `var(--s-3)` padding.
- Repeatable lists follow the `KeyValueEditor` add/remove/set-row idiom (append `{...}`, splice on delete, `onChange` returns full array), the codebase's established "structured, never raw JSON" convention.
- Model-centric list uses `DataTable` + `StatusBadge` + `BrandIcon` like `ModelsCatalogPage`.

## Coordination with open FE PR #65

PR #65 modifies `apps/web/src/components/data/PricebookSpecForm.tsx`, `apps/web/src/components/console/nav-config.ts`, and several console files but NOT `ModelEditor.tsx`, `ModelAccessPage.tsx`, `ModelGrid.tsx`, `ModelDetailDrawer.tsx`, `queryKeys.ts`, `enums.ts`, or `admin.ts` model/channel methods — so this work is largely non-overlapping. Two watch-outs: (1) both add i18n keys to `console.json` (en + zh-CN) — merge carefully, keep alphabetical/section grouping to minimize conflicts; (2) both touch `admin.ts` — append the new methods at the end of the relevant block rather than mid-file to reduce diff collision. Land this AFTER #65 merges, or rebase onto it. Follow the memory GOTCHA: `seed-providers.int.test` pre-fails on main (9 vs 10) and never `git add -A` in apps/web.

## Phasing note (matches design §9)

Phase 0 ships (b) ParamOverrideEditor + col-3 entry only (needs just `channel_model.param_override` / mig 0063). Phase 1 adds (a) ParameterRulesEditor/FeaturesField in ModelEditor + 从规格库导入 (needs `model.param_profile` / mig 0062+0064 + `paramProfile` in Update/CreateModelBody). Phase 2 adds (c) the model-centric ServingChannelsPanel. Build the shared row-card + value-control primitives (used by both ParameterRulesEditor and ParamOverrideEditor) in Phase 0 so Phase 1 reuses them.

---

# 5. Test Plan, Phasing & Rollout

## Overview

This section defines the concrete test matrix, ordered phase breakdown, and rollout/backward-compat notes for the model-parameter-binding redesign (spec: `docs/superpowers/specs/2026-07-01-model-param-binding-design.md`). It is anchored to the LOCKED DECISIONS: D1 (profile frozen onto `model.param_profile`), D2 (no `wirePath` in Phase 1 — adapter stays wire-authoritative), D3 (`require_params` default OFF), D4 (media OUT of Phase 0/1).

The overriding correctness contract for every phase is the **regression invariant**:

> **Empty profile + empty `param_override` == today's behavior, byte-for-byte on the wire and cent-for-cent on the settle.**

Every phase's test set MUST include a case asserting this invariant explicitly.

---

## 1. Test Matrix

### 1.1 Phase 0 — `channel_model.param_override` (mig 0063)

**Unit tests — engine `applyChannelOverride`** (new pure module `packages/engine/src/param/apply-override.ts`; test `packages/engine/test/apply-override.test.ts`, pure vitest, no container — mirror `packages/domain/test/pricing.test.ts`):

| #    | Case                                                   | Input IR                                    | Override ops                                                                    | Expected                                                        |
| ---- | ------------------------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| O-1  | **regression invariant**                               | `{params:{temperature:0.7}, extra:{foo:1}}` | `{ops:[]}` (and `undefined`)                                                    | IR returned unchanged (deep-equal), no clone mutation of source |
| O-2  | `set` forces a value                                   | `{params:{temperature:0.7}}`                | `[{op:'set',name:'temperature',value:0}]`                                       | `params.temperature === 0`                                      |
| O-3  | `set` on absent param adds it                          | `{params:{}}`                               | `[{op:'set',name:'top_p',value:0.5}]`                                           | `params.topP === 0.5` (camel mapping)                           |
| O-4  | `clamp` above max                                      | `{params:{temperature:1.9}}`                | `[{op:'clamp',name:'temperature',max:1}]`                                       | `params.temperature === 1`                                      |
| O-5  | `clamp` below min                                      | `{params:{temperature:-0.2}}`               | `[{op:'clamp',name:'temperature',min:0}]`                                       | `params.temperature === 0`                                      |
| O-6  | `clamp` in-range is a no-op                            | `{params:{temperature:0.5}}`                | `[{op:'clamp',name:'temperature',min:0,max:1}]`                                 | `0.5` unchanged                                                 |
| O-7  | `delete` removes param                                 | `{params:{temperature:0.7,topP:0.9}}`       | `[{op:'delete',name:'temperature'}]`                                            | `temperature` absent, `topP` kept                               |
| O-8  | dotted path hits `extra` nested field                  | `{extra:{thinking:{budget_tokens:100}}}`    | `[{op:'set',name:'thinking.budget_tokens',value:2048}]`                         | `extra.thinking.budget_tokens === 2048`                         |
| O-9  | `delete` on `extra` dotted path                        | `{extra:{a:{b:1,c:2}}}`                     | `[{op:'delete',name:'a.b'}]`                                                    | `extra.a === {c:2}`                                             |
| O-10 | `when.modelMatches` MATCHES (same channel, two models) | ctx model `gpt-4o`                          | `[{op:'set',name:'temperature',value:0, when:{modelMatches:'gpt-4o'}}]`         | applied                                                         |
| O-11 | `when.modelMatches` MISS                               | ctx model `gpt-4o-mini`                     | same op with `modelMatches:'gpt-4o'`                                            | NOT applied                                                     |
| O-12 | ordered ops (set then clamp)                           | `{params:{}}`                               | `[{op:'set',name:'temperature',value:5},{op:'clamp',name:'temperature',max:2}]` | `temperature === 2`                                             |
| O-13 | `set` value survives request wins later                | —                                           | precedence asserted in engine-integration test 1.5                              | (see below)                                                     |

Signature target: `applyChannelOverride(ir: ChatRequest, override: ParamOverride | undefined, ctx: { modelName: string }): ChatRequest` — pure, returns a NEW IR (structuredClone), never mutates input (asserted by O-1 identity check on source).

**Int tests — `channel_model.param_override` round-trip** (extend `packages/db/test/channel-model.int.test.ts` + new `packages/db/test/migration-0063.int.test.ts`):

| #    | Case                                               | Assert                                                                                                                                        |
| ---- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| I0-1 | mig 0063 adds `channel_model.param_override jsonb` | `information_schema` shows `param_override`, `is_nullable = YES`, `data_type = jsonb` (mirror `migration-0021.int.test.ts` `column()` helper) |
| I0-2 | existing links unaffected                          | pre-existing `linkChannelModel` rows read back with `param_override === null`                                                                 |
| I0-3 | round-trip write/read                              | new repo `setChannelModelOverride(db, channelId, modelId, override)` + `getChannelModelOverride` returns the exact `{ops:[...]}` jsonb        |
| I0-4 | zod validation at repo boundary                    | writing a malformed op (`op:'move'`) rejected by `paramOverrideSchema.parse` before insert                                                    |
| I0-5 | append-only trigger clearance                      | `param_override` UPDATE is allowed (channel_model is NOT append-only-frozen; confirm no mig-0052 trigger blocks it)                           |

**E2e — relay honors per-(model,channel) override** (new `apps/api/test/chat-relay-param-override.e2e.test.ts`, own-PG-per-file, `RELAY_TRACE:'on'` so `relay_trace.request_body` captures the wire body — this is the wire-level oracle):

| #    | Case                                                 | Setup                                                                                                                                                                                                                                               | Assert (via `relay_trace.request_body`)                                                           |
| ---- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| E0-1 | **regression invariant**                             | model linked to channel, `param_override = null`                                                                                                                                                                                                    | wire body identical to a no-override baseline run                                                 |
| E0-2 | **same model, two channels, different forced param** | model `M` linked to channel `A` (`set temperature=0`) and channel `B` (`set temperature=1`); force route to each via `X-Actionow-Route-Tag` or channel weight                                                                                       | trace for A shows `temperature:0`, trace for B shows `temperature:1` — proves per-(model,channel) |
| E0-3 | `delete` drops a param on one channel only           | channel A `delete top_p`                                                                                                                                                                                                                            | A's wire body has no `top_p`; B's retains it                                                      |
| E0-4 | request value still wins over override `set`?        | NO — override is between request and profile; spec precedence is `request > ② > ① > dialect`. **Correction:** assert request `temperature` OVERRIDES an override `set` (request wins). Document: `set` is a forced floor only when request omits it | request `temperature:0.3` beats override `set temperature:0` → wire shows `0.3`                   |

> Note on E0-4: the spec precedence `request > ②override > ①profile` means an override `set` acts as a **default provider**, not a hard force, unless implemented as post-request force. This is an ambiguity to reconcile with the assembler (see Concerns) — new-api's `set` is a hard force. Pick one and pin it with E0-4 either way.

### 1.2 Phase 1 — model `ModelParamProfile` (migs 0062 + 0064)

**Unit tests — `resolveRule` + template library** (`packages/contracts/test/param-templates.test.ts` — contracts has vitest; or `packages/engine/test/resolve-rule.test.ts`):

| #   | Case                                          | Assert                                                                                         |
| --- | --------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| R-1 | `useTemplate:'temperature'` with no overrides | resolves to `{type:'float',default:1.0,min:0,max:2}` from `PARAM_TEMPLATES`                    |
| R-2 | `useTemplate` + field override                | `{name:'temperature',useTemplate:'temperature',max:1}` → merged `max:1`, template `min:0` kept |
| R-3 | inline rule, no template                      | `{name:'enable_thinking',type:'boolean',default:false}` returned as-is                         |
| R-4 | unknown template name                         | throws / returns rule unchanged (pin the chosen behavior)                                      |
| R-5 | enum rule                                     | `reasoning_effort` resolves `options:['low','medium','high']`                                  |

**Unit tests — profile pipeline stages** (`packages/engine/test/apply-profile.test.ts`, pure). Stages under test: `applyProfileDefaults`, `clampToRules`, `gate`, `dropUnsupported`:

| #    | Stage                                     | Case                                                                                  | Assert                                                                                                                                     |
| ---- | ----------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| P-1  | **regression invariant**                  | empty profile `{features:[],parameterRules:[],dropPolicy:'passthrough'}` over full IR | IR unchanged deep-equal (== today)                                                                                                         |
| P-2  | `applyProfileDefaults`                    | rule `temperature default 0.8`, request omits it                                      | `params.temperature === 0.8`                                                                                                               |
| P-3  | `applyProfileDefaults`                    | request SETS temperature                                                              | request value kept (default does NOT overwrite)                                                                                            |
| P-4  | `clampToRules`                            | `temperature max 1`, request `1.9`                                                    | clamped to `1`                                                                                                                             |
| P-5  | `clampToRules` + `dropPolicy:'error'`     | out-of-range under error policy                                                       | throws `ProtocolError('invalid_input')` (reuse existing error, matches `normalize.test.ts`)                                                |
| P-6  | `gate(features)`                          | features lacks `tool-call`, request has `tools`                                       | throws `ProtocolError` (parity with current `normalizeRequest` tools-400 at `normalize.test.ts:24`)                                        |
| P-7  | `gate(features)` reasoning downgrade      | features `reasoning`, request has `temperature/topP/stop` + `extra.presence_penalty`  | those dropped, `maxOutputTokens` + `prompt_cache_key` survive — **exact parity with `normalize.test.ts:95` DOWNGRADE case**                |
| P-8  | `dropUnsupported` `passthrough` (default) | unknown non-standard param in `extra`                                                 | passthrough (kept)                                                                                                                         |
| P-9  | `dropUnsupported` `drop`                  | known-standard param NOT in `parameterRules`                                          | dropped from body                                                                                                                          |
| P-10 | `dropUnsupported` `error`                 | known-standard undeclared param                                                       | throws                                                                                                                                     |
| P-11 | full pipeline order                       | defaults→clamp→gate→override→drop composed                                            | worked example: request `{temperature:1.9,tools:[...]}`, profile clamps temp to 1, gate allows tools → final `{temperature:1,tools:[...]}` |

**`gate` parity harness (critical):** port every assertion from `packages/llm-protocol/test/normalize.test.ts` into `apply-profile.test.ts` driving the new profile-backed `gate`, proving the profile path reproduces the hardcoded reasoning drop-list. Keep `normalize.test.ts` green during Phase 1 (fallback-to-old-behavior when profile absent) and only retire its drop-list assertions once the profile path is the sole path.

**Int tests — migrations + freeze-from-model_spec** (new `packages/db/test/migration-0062-0064.int.test.ts` + extend `packages/db/test/model-spec.int.test.ts`, `packages/db/test/model.int.test.ts`):

| #    | Case                                                                           | Assert                                                                                                                                                                                                                                                                |
| ---- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1-1 | mig 0062 adds `model_spec.features jsonb` + `model_spec.parameter_rules jsonb` | `information_schema` columns present, nullable jsonb; old `key_params` still present (compat window)                                                                                                                                                                  |
| I1-2 | mig 0064 adds `model.param_profile jsonb`                                      | column present, nullable jsonb, `data_type = jsonb`                                                                                                                                                                                                                   |
| I1-3 | `upsertModelSpec` round-trips `parameterRules` + `features`                    | write `[{name:'temperature',useTemplate:'temperature'}]` + `features:['tool-call']`, read back exact                                                                                                                                                                  |
| I1-4 | **freeze-from-model_spec** repo                                                | new `freezeParamProfile(db, modelId, spec)` (or path in `syncModels`) copies `model_spec.{features,parameterRules,dropPolicy}` → `model.param_profile`; assert model row now carries the snapshot (mirrors existing `input_price` freeze from `official_model_price`) |
| I1-5 | freeze is idempotent                                                           | re-run overwrites, no duplicate/error                                                                                                                                                                                                                                 |
| I1-6 | `key_params` → `parameter_rules` backfill migration                            | 236 existing rows: each `key_params:['temperature']` becomes `[{name:'temperature',useTemplate?}]`, `dropPolicy` defaults `passthrough`                                                                                                                               |
| I1-7 | append-only safety                                                             | `model` UPDATE of `param_profile` allowed (mig-0052 triggers permit business columns? confirm — model is not append-only; if it were, this breaks freeze)                                                                                                             |

**E2e — relay honors a model profile** (new `apps/api/test/chat-relay-param-profile.e2e.test.ts`, `RELAY_TRACE:'on'`):

| #    | Case                            | Assert (wire body via `relay_trace`)                                                                                       |
| ---- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| E1-1 | **regression invariant**        | model with `param_profile = null` → wire body == baseline                                                                  |
| E1-2 | profile default filled          | model profile `temperature default 0.8`, request omits temperature                                                         | wire body has `temperature:0.8` |
| E1-3 | **unsupported param dropped**   | profile `dropPolicy:'drop'`, declares only `temperature`; request sends `top_p`                                            | wire body has NO `top_p`        |
| E1-4 | gate 400 parity                 | no-tools feature set, request sends `tools` → HTTP 400 `invalid_input` (parity with existing `chat-relay.e2e.test.ts:501`) |
| E1-5 | reasoning downgrade via profile | reasoning-feature model, request `temperature` → dropped on wire, response still 200                                       |
| E1-6 | profile + override compose      | model default `temperature 0.8`, channel override `set temperature 0` → wire shows `0` (override beats profile default)    |

### 1.3 Phase 2 — `require_params` + `native_finish_reason`

| #    | Kind         | Case                                                              | Assert                                                                                                                  |
| ---- | ------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| P2-1 | e2e          | `require_params` OFF (default D3) + unsupported param             | drop-and-forward, request served (no route skip)                                                                        |
| P2-2 | e2e          | `require_params` ON + candidate channel's profile lacks the param | that channel SKIPPED, fallback channel serves (assert via `x-actionow-channel` header / `relay_trace.channel_id`)       |
| P2-3 | e2e          | `require_params` ON + zero eligible channels                      | 400/404 (pin the code)                                                                                                  |
| P2-4 | adapter unit | upstream returns non-standard finish reason                       | `native_finish_reason` preserved raw in response View (extend `packages/adapters/test/usage-breakdown.test.ts` sibling) |
| P2-5 | e2e          | response surfaces `native_finish_reason` snake_case in View       | present alongside normalized `finish_reason`                                                                            |
| P2-6 | media        | (D4) media profile separate — deferred, tracked only              |

---

## 2. Phase Breakdown (ordered task list)

### Phase 0 — `channel_model.param_override` slice (smallest, hits the worst pain first)

| Task                  | Files                                                                                                                                                                                                                                          | Migration | Acceptance                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------- |
| 0.1 contracts         | `packages/contracts/src/param-profile.ts` (new: `paramOpSchema`, `paramOverrideSchema`) + export in barrel                                                                                                                                     | —         | zod parses valid/invalid ops; `move` rejected                                                         |
| 0.2 migration         | `packages/db/drizzle/0063_*.sql` + `packages/db/src/schema/model.ts` (`channelModel.paramOverride jsonb`)                                                                                                                                      | **0063**  | mig int test I0-1 green; existing links read `null`                                                   |
| 0.3 repo              | `packages/db/src/repositories/channel-model.ts` (`setChannelModelOverride`/`getChannelModelOverride`) + barrel                                                                                                                                 | —         | round-trip int tests I0-3..I0-5                                                                       |
| 0.4 engine stage      | `packages/engine/src/param/apply-override.ts` (new pure `applyChannelOverride`)                                                                                                                                                                | —         | unit tests O-1..O-13                                                                                  |
| 0.5 wire into relay   | `apps/api/src/chat/chat-relay.service.ts` (load override in `buildContext`/resolve, apply BEFORE `adapter.buildChatBody`, AFTER `normalizeRequest`); `apps/api/src/chat/model-resolver.service.ts` (surface override alongside resolved model) | —         | E0-1..E0-4 green; **no extra query** — override joined in the model-resolution query, not per-request |
| 0.6 FE override panel | `apps/web/src/features/console/ChannelEditor.tsx` (per-linked-model 参数覆盖 editor writing `param_override`)                                                                                                                                  | —         | operator can set/clamp/delete; renders existing override                                              |
| 0.7 tests             | all of §1.1                                                                                                                                                                                                                                    | —         | unit + int + e2e green; regression invariant E0-1 green                                               |

**Phase 0 exit:** same model over two channels can carry different forced params, proven on the wire via `relay_trace`. Everything else unchanged.

### Phase 1 — model `ModelParamProfile`

| Task                      | Files                                                                                                                                                                                                                                                          | Migration | Acceptance                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------- |
| 1.1 contracts             | `packages/contracts/src/param-profile.ts` (`parameterRuleSchema`, `modelParamProfileSchema`, `DROP_POLICIES`); `packages/contracts/src/param-templates.ts` (`PARAM_TEMPLATES` + `resolveRule`)                                                                 | —         | R-1..R-5 unit                                                        |
| 1.2 mig model_spec        | `packages/db/drizzle/0062_*.sql` + `packages/db/src/schema/model-spec.ts` (`features`, `parameterRules`; keep `keyParams` for compat)                                                                                                                          | **0062**  | I1-1, I1-3                                                           |
| 1.3 mig model snapshot    | `packages/db/drizzle/0064_*.sql` + `packages/db/src/schema/model.ts` (`param_profile jsonb`)                                                                                                                                                                   | **0064**  | I1-2                                                                 |
| 1.4 freeze                | `apps/api/src/admin/admin.service.ts` sync path + `packages/db/src/repositories/model.ts` `freezeParamProfile` (copy from `model_spec`, mirrors `inputPrice` freeze)                                                                                           | —         | I1-4..I1-6                                                           |
| 1.5 engine profile stages | `packages/engine/src/param/apply-profile.ts` (`applyProfileDefaults`, `clampToRules`, `gate`, `dropUnsupported`); refactor `packages/llm-protocol/src/normalize.ts` to be profile-driven with fallback-to-hardcoded when profile absent                        | —         | P-1..P-11 + full `normalize.test.ts` parity port                     |
| 1.6 wire into relay       | `apps/api/src/chat/chat-relay.service.ts` pipeline order: `applyProfileDefaults → clampToRules → gate → applyChannelOverride → adapter.buildChatBody → dropUnsupported`; profile read from `resolved.param_profile` (already loaded — zero extra query per D1) | —         | E1-1..E1-6                                                           |
| 1.7 ModelEditor           | `apps/web/src/features/console/ModelEditor.tsx` (parameter_rules form from templates + spec); `components/data/CapabilitiesField.tsx` → `FeaturesField` (multi-select)                                                                                         | —         | operator edits profile; `capabilities`→`features` migration surfaced |
| 1.8 tests                 | all §1.2                                                                                                                                                                                                                                                       | —         | green; E1-1 regression invariant green                               |

**Phase 1 exit:** per-model declarative profile fills defaults / clamps / gates / drops; hardcoded reasoning drop-list retired (profile-driven), old behavior reproduced when profile empty.

### Phase 2 — polish

| Task                                           | Files                                                                                                        | Migration                           | Acceptance            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------- | --------------------- |
| 2.1 `native_finish_reason`                     | `packages/adapters/src/{openai,anthropic,gemini}.ts` `extractUsage`/response map; response View in contracts | —                                   | P2-4, P2-5            |
| 2.2 `require_params` routing (default OFF, D3) | `apps/api/src/chat/channel-routing.service.ts` / `route-group` config                                        | possibly a config-only or small col | P2-1..P2-3            |
| 2.3 model-centric view                         | `apps/web/src/features/console/ModelAccessPage.tsx` (model as primary, per-channel override status)          | —                                   | UI review             |
| 2.4 sync auto-fill profile                     | `admin.service.ts` `syncModels` populates profile from `model_spec` on sync                                  | —                                   | freeze auto-runs      |
| 2.5 media profile (D4)                         | separate async-media params object track                                                                     | —                                   | deferred; scoped only |

> **Phase 2 implementation status (2026-07-01):** 2.1–2.4 SHIPPED (branch `feat/param-binding-p2`).
> **2.1** `native_finish_reason` — each adapter (`openai`/`anthropic`/`gemini`) now populates the Phase-1 `ChatResponse.nativeFinishReason` IR field + the `stop` stream event from the raw provider reason; the OpenAI-dialect wire renderers (`packages/llm-protocol/src/openai/render.ts` + `stream.ts`) surface it snake_case as `native_finish_reason` on `choices[]` ONLY when present (standard reason ⇒ native == normalized; absent ⇒ omitted, byte-for-byte unchanged). No zod View change — the chat-completions endpoint returns the passthrough OpenAI shape, not a registered View.
> **2.2** `require_params` — a boolean `route_group.require_params` (**mig 0065**, default FALSE ⇒ today byte-for-byte) toggles the router (`ChannelRoutingService.candidatesFor` → `applyRequireParams`) to SKIP a candidate whose effective `(model,channel)` override `delete` op or profile `dropPolicy:drop/error` would strip a request-carried param (pure predicate `channelSupportsParams` in `packages/engine/src/param/require-params.ts`), falling to a supporting channel or the existing no-candidate 404. Admin toggle on `RouteGroupsPage`.
> **2.3** override-status badges — `ModelAccessPage` right-pane model table shows a compact `覆盖`/`档案` chip when a row has a non-empty `param_override` (on the selected channel) and/or `param_profile`.
> **2.4** sync auto-fill — VERIFIED already covered by `upsertModelsFromSync` (`freezeParamProfile`) + int test `migration-0063-0064.int.test.ts` (I1-4); no new code.
>
> **2.5 media profile — SCOPED / DEFERRED (D4).** async-media params are a provider-specific params object (not the OpenAI sampling surface the Phase-0/1 pipeline models), so a media `ModelParamProfile` track is intentionally NOT implemented in this phase. It requires its own profile shape (media params ≠ temperature/top_p/reasoning), its own engine apply pass on the async-media request builder, and its own catalog/UI — a self-contained follow-up. No media param code ships here; the chat pipeline (Phase 0–2) is unaffected.

---

## 3. Backward-Compat / Rollout Notes

**Backward-compat contract (per-step):** every migration is additive nullable jsonb (`param_override`, `features`, `parameter_rules`, `param_profile`) — no NOT NULL, no default that changes behavior. Empty/null == today. This is enforced by the **regression-invariant test in every layer** (O-1, P-1, E0-1, E1-1). No column is dropped in these phases: `model_spec.key_params` stays through Phase 1 as a compat shadow and is dropped only in a later cleanup migration after the backfill (I1-6) is verified in prod.

**Migration ordering:** latest on main is `0061`. Serialize as: Phase 0 → **0063**, Phase 1 → **0062** (model_spec) + **0064** (model snapshot). Because 0062 < 0063 numerically but Phase 0 ships first, **rename to keep the applied order monotonic** — if Phase 0 lands first, its migration must be `0062` and Phase 1's become `0063`/`0064`. Do NOT let a lower-numbered file land after a higher-numbered one (drizzle applies by lexical filename order and records hashes; out-of-order files cause the drift documented in the `dev-db-migration-drift` memo). **Decision for assembler:** number strictly by merge order, not by spec section.

**Append-only guardrails (mig 0052):** `param_profile` lives on the `model` row and `param_override` on `channel_model` — both must accept UPDATE. Confirm neither table carries a mig-0052 business-UPDATE-blocking trigger (int tests I0-5, I1-7 assert this). `model_spec` writes go through `upsertModelSpec` (partial-unique `targetWhere: deleted_at IS NULL`) — the new columns ride the existing upsert.

**Correctness safety net:** default `dropPolicy = 'passthrough'` (never over-drops), `require_params` default OFF (D3, drop-and-forward preserved), and `POST /admin/models/test` (#12) + `RELAY_TRACE` give a live wire oracle before a profile bills. The relay change is a pure in-memory transform (spec §8.3) — no new network hop, no N+1: profile rides the already-loaded model row (D1), override joins into the existing model-resolution query.

**Test-suite hygiene / known traps** (from memory notes):

- Full api e2e run ≈ 21–23 min; each e2e file = own PG container. Keep new e2e files (`chat-relay-param-override.e2e.test.ts`, `chat-relay-param-profile.e2e.test.ts`) lean — reuse the mock-chat harness from `chat-relay.e2e.test.ts`, set `RELAY_TRACE:'on'` (default in that file is `'off'`).
- `@Audit` interceptor is fire-and-forget → if any override/profile CRUD is audited, tests must POLL `latestAuditFor` (per `e2e-flakiness` memo), never read-after-write synchronously.
- `seed-providers.int.test` pre-fails on main (9 vs 10) — do not treat as a new regression; never `git add -A` in `apps/web`.
- Idempotency interceptor now `concatMap`-awaits (fixed in #66) — no action, just don't reintroduce fire-and-forget on the override write path.

**Deploy caveat (fat-image slow pull):** the Zeabur deploy pulls a ~2GB fat image over a ~0.5MB/s registry link ≈ 1hr per pull (`zeabur-deploy-2026-06-30` memo). These three phases each add a migration that must run on deploy. **Recommendation:** slim the image (multi-stage prune of dev deps / per-service Dockerfile already exists) BEFORE this lands, or at minimum **batch all three migrations into a single deploy** (ship Phase 0+1 migrations 0062/0063/0064 together even if code lands incrementally behind feature flags) to avoid three separate hour-long pulls. If shipping incrementally, gate the engine stages behind an env/`platform_setting` flag so migrations can land ahead of the code activation without a behavior change.

## 4. Concerns for the assembler

1. **Migration numbering vs spec section numbering** — the spec labels Phase 1 as 0062 and Phase 0 as 0063, but Phase 0 ships first. Number by merge order (Phase 0 = 0062). Pin this before anyone writes the SQL filename.
2. **`set` semantics vs precedence** — spec precedence `request > ②override > ①profile` implies override `set` is a default, but new-api (the cited reference) treats `set` as a hard force. E0-4 must pin ONE interpretation. Recommend: `set` = hard force (matches operator intent "force this param on this channel"), and document that request-value-wins applies only to profile defaults, not to override `set`. This diverges slightly from the literal precedence line in the spec — flag for sign-off.
3. **`normalize.ts` dual-path window** — during Phase 1, both the hardcoded drop-list and the profile-driven `gate` coexist (fallback when profile null). Keep `normalize.test.ts` green throughout; only delete its drop-list assertions once the profile path is proven sole-authority (I1-4 freeze verified in prod).
4. **`param_profile` UPDATE vs append-only** — must confirm mig-0052 triggers don't block `model.param_profile` UPDATE (freeze rewrites it on every sync). If `model` turns out to be append-only-guarded, freeze needs a trigger exception (per mig-0052's "ALLOW FK SET NULL" carve-out pattern).

---

# 附录 A：全量文件改动清单

**Contracts & Templates**

- packages/contracts/src/param-templates.ts (NEW): PARAM_TEMPLATES constant + ParamTemplateName/PARAM_TEMPLATE_NAMES — the code-only use_template library (temperature/top_p/top_k/max_tokens/response_format/reasoning_effort/stop/seed/frequency_penalty/presence_penalty/logprobs)
- packages/contracts/src/param-profile.ts (NEW): parameterRuleSchema, PARAMETER_TYPES, MODEL_FEATURES, DROP_POLICIES, modelParamProfileSchema, PARAM_OPS, paramOpSchema (superRefined), paramOverrideSchema, resolveRule(), applyProfile signature + ApplyProfileInput/Result + inferred types
- packages/contracts/src/chat.ts (EDIT): add optional nativeFinishReason to ChatResponse and the `stop` ChatStreamEvent variant; append profile-validation note to the `extra` JSDoc (no shape change)
- packages/contracts/src/catalog-requests.ts (EDIT): add paramProfile to create/updateModelSchema; add features+parameterRules to create/updateModelSpecSchema; add updateChannelModelParamOverrideSchema
- packages/contracts/src/catalog-views.ts (EDIT): add param_profile to modelViewSchema; add channelModelViewSchema (+param_override) and param_override to channelModelLinkInputSchema; add features+parameter_rules to modelSpecViewSchema
- packages/contracts/src/index.ts (EDIT): export \* from './param-profile.js' and './param-templates.js'
- packages/contracts/src/openapi.ts (EDIT): register ParameterRule/ModelParamProfile/ParamOverride/ChannelModelView/UpdateChannelModelParamOverrideBody components; register the channel-model list + override-PATCH paths
  **DB Schema, Migrations & Repos**
- packages/db/drizzle/0062\_<word>.sql — NEW: ALTER model_spec ADD features jsonb, parameter_rules jsonb (drizzle-kit generated)
- packages/db/drizzle/0063\_<word>.sql — NEW: ALTER channel_model ADD param_override jsonb (nullable)
- packages/db/drizzle/0064\_<word>.sql — NEW: ALTER model ADD param_profile jsonb (nullable, frozen snapshot)
- packages/db/drizzle/meta/\_journal.json — append idx 62/63/64 entries (drizzle-kit generated)
- packages/db/drizzle/meta/0062_snapshot.json, 0063_snapshot.json, 0064_snapshot.json — NEW snapshots (drizzle-kit generated)
- packages/db/src/schema/model-spec.ts — add features + parameterRules jsonb columns to modelSpec; keep keyParams (compat)
- packages/db/src/schema/model.ts — add param_override jsonb to channelModel; add param_profile jsonb to model
- packages/db/src/repositories/model-spec.ts — UpsertModelSpecInput/UpdateModelSpecInput + upsert/create/update carry features + parameterRules
- packages/db/src/repositories/model.ts — freezeParamProfile helper; upsertModelsFromSync freezes param_profile from matched model_spec on insert (preserve on existing); ResolvedModel + resolveModelForTenant return paramProfile; Create/UpdateModelInput carry paramProfile; setChannelModelOverride/getChannelModelOverride fns
- packages/contracts/src/param-profile.ts — (contracts-section dependency) ParameterRule/ModelParamProfile/ParamOverride types the $type<> references need
  **Engine Pipeline: profile-driven normalize + per-channel override wiring**
- packages/engine/src/param-pipeline.ts (NEW) — OR co-locate in packages/llm-protocol/src/param-pipeline.ts: applyProfileDefaults, clampToRules, gate helper, applyChannelOverride, dropUnsupported, isEmptyProfile; same-ref-when-empty semantics mirroring normalize.ts
- packages/llm-protocol/src/normalize.ts — normalizeRequest gains optional 3rd arg `profile`; add hasReasoningRules + downgradeByProfile; KEEP REASONING*DROPPED*\* + downgradeForReasoning as the fallback when profile absent/empty
- packages/llm-protocol/src/index.ts — export the new pipeline fns (applyProfileDefaults/clampToRules/applyChannelOverride/dropUnsupported/isEmptyProfile) so engine + api + adapters import without a cycle
- packages/engine/src/execution-service.ts — RunRequest gains `paramProfile?`; RunChannel gains `paramOverride?`; buildContext (~L1454) threads ctx.paramProfile when non-empty; executeChat routing closure (~L591) applies applyChannelOverride(ir, channel.paramOverride, channel.model) to a per-attempt IR copy before adapter.chat
- packages/engine/src/stream.ts — openChatStreamCommit applies applyChannelOverride per selected candidate channel before adapter.streamChat (symmetric with blocking chat)
- packages/contracts/src/adapter.ts — AdapterContext gains `paramProfile?: ModelParamProfile` (consumed by adapter stage ④ only)
- packages/adapters/src/openai.ts — buildChatBody returns dropUnsupported(body, ctx.paramProfile) instead of body (same-ref when empty)
- apps/api/src/chat/model-resolver.service.ts — ResolvedModel interface gains `paramProfile?`
- apps/api/src/chat/chat-relay.service.ts — buildChatRunRequest: replace single normalizeRequest call with applyProfileDefaults→clampToRules→normalizeRequest(...,profile); set req.paramProfile when non-empty; normalizedIr flows into inputs.\_\_ir + estimateStreamUsage (already)
- packages/db/src/repositories/model.ts — ResolvedModel gains paramProfile; resolveModelForTenant SELECT adds model.paramProfile (lenient safeParse fallback to empty profile); NEW getChannelModelOverrides(db, modelId, channelIds) → Map<channelId, ParamOverride>
- apps/api/src/common/channel-routing.service.ts — candidatesFor: after building `base`, batch-load getChannelModelOverrides and stamp c.paramOverride onto each RunChannel before preferLinkedChannels/return
  **FRONTEND**
- apps/web/src/lib/api/enums.ts — add PARAM_FEATURES, PARAM_RULE_TYPES, PARAM_TEMPLATES, DROP_POLICIES consts (keep CAPABILITIES)
- apps/web/src/components/data/FeaturesField.tsx — NEW: string[] toggle-group over PARAM_FEATURES (upgrade of CapabilitiesField), preserves unknown feature keys
- apps/web/src/components/data/ParameterRulesEditor.tsx — NEW: repeatable structured param-rule editor (name/useTemplate/type/min/max/default/required/options/help), value-control switches on type
- apps/web/src/features/console/ModelEditor.tsx — add features/parameterRules/dropPolicy state + seed from m.param_profile + 参数档案 section (FeaturesField + ParameterRulesEditor + dropPolicy select + 从规格库导入 button) + attach paramProfile to create/update bodies + importSpec mutation w/ confirm-when-populated
- apps/web/src/features/console/ParamOverrideEditor.tsx — NEW: Drawer editing channel_model.param_override (set/clamp/delete ops + when.modelMatches), scoped to (resourceId,channelId,modelId)
- apps/web/src/features/console/ModelGrid.tsx — add optional onOverrideModel prop + per-row 参数覆盖 action + override.active chip when m.param_override non-empty
- apps/web/src/features/console/ModelAccessPage.tsx — overrideEdit state, pass onOverrideModel to col-3 ModelGrid, render ParamOverrideEditor scoped to selectedChannel
- apps/web/src/features/console/ModelDetailDrawer.tsx — add 服务通道 section rendering ServingChannelsPanel (model-centric serving-channels + override state)
- apps/web/src/features/console/ServingChannelsPanel.tsx — NEW: DataTable of serving channels per model with override-state chip + drill into ParamOverrideEditor
- apps/web/src/lib/api/admin.ts — add getChannelModelOverride/setChannelModelOverride (raw) + getModelSpecByModel; paramProfile flows through existing updateModel/createModel bodies
- apps/web/src/lib/api/queryKeys.ts — add channelModelOverride(channelId,modelId) + modelSpecByModel(modelId)
- apps/web/src/lib/api/types.ts — re-export ModelParamProfileView, ParameterRuleView, ParamOverrideView, ParamOpView, ParamOverrideBody, ModelSpecView from @actionow/sdk contracts
- apps/web/src/i18n/locales/en/console.json — add enums.feature._, models.param._, models.tip.features/rules/dropPolicy, override.\* keys
- apps/web/src/i18n/locales/zh-CN/console.json — add the zh-CN translations for the same key set
  **Test Plan, Phasing & Rollout**
- packages/contracts/src/param-profile.ts (NEW — paramOpSchema/paramOverrideSchema in Phase 0; parameterRuleSchema/modelParamProfileSchema/DROP_POLICIES in Phase 1)
- packages/contracts/src/param-templates.ts (NEW — PARAM_TEMPLATES constant + resolveRule, Phase 1)
- packages/contracts/src/index.ts (export new schemas)
- packages/contracts/test/param-templates.test.ts (NEW — resolveRule unit tests R-1..R-5)
- packages/db/drizzle/0062\_\*.sql (Phase 0 channel_model.param_override OR Phase 1 model_spec cols — number by merge order)
- packages/db/drizzle/0063\_\*.sql (second migration by merge order)
- packages/db/drizzle/0064\_\*.sql (model.param_profile snapshot col)
- packages/db/src/schema/model.ts (add channelModel.paramOverride jsonb + model.paramProfile jsonb)
- packages/db/src/schema/model-spec.ts (add features jsonb + parameterRules jsonb, keep keyParams for compat)
- packages/db/src/repositories/channel-model.ts (setChannelModelOverride/getChannelModelOverride)
- packages/db/src/repositories/model.ts (freezeParamProfile — copy model_spec profile onto model row)
- packages/db/test/channel-model.int.test.ts (extend — override round-trip I0-2..I0-5)
- packages/db/test/migration-0063.int.test.ts (NEW — mig column presence I0-1)
- packages/db/test/migration-0062-0064.int.test.ts (NEW — model_spec + model.param_profile cols I1-1..I1-2)
- packages/db/test/model-spec.int.test.ts (extend — parameter_rules/features round-trip I1-3, freeze I1-4..I1-6)
- packages/engine/src/param/apply-override.ts (NEW — pure applyChannelOverride)
- packages/engine/src/param/apply-profile.ts (NEW — applyProfileDefaults/clampToRules/gate/dropUnsupported)
- packages/engine/test/apply-override.test.ts (NEW — unit O-1..O-13)
- packages/engine/test/apply-profile.test.ts (NEW — unit P-1..P-11 + normalize.test.ts parity port)
- packages/llm-protocol/src/normalize.ts (refactor to profile-driven gate with fallback-to-hardcoded when profile absent)
- packages/llm-protocol/test/normalize.test.ts (keep green through Phase 1; retire drop-list assertions only after profile is sole path)
- apps/api/src/chat/chat-relay.service.ts (insert pipeline: applyProfileDefaults→clampToRules→gate→applyChannelOverride→buildChatBody→dropUnsupported)
- apps/api/src/chat/model-resolver.service.ts (surface param_override + param_profile alongside resolved model — no extra query)
- apps/api/src/admin/admin.service.ts (syncModels freezes profile from model_spec — Phase 1/2)
- apps/api/test/chat-relay-param-override.e2e.test.ts (NEW — E0-1..E0-4, RELAY_TRACE:'on', two-channel wire assertions)
- apps/api/test/chat-relay-param-profile.e2e.test.ts (NEW — E1-1..E1-6, RELAY_TRACE:'on')
- apps/web/src/features/console/ChannelEditor.tsx (Phase 0 — per-linked-model 参数覆盖 panel)
- apps/web/src/features/console/ModelEditor.tsx (Phase 1 — parameter_rules editor)
- apps/web/src/features/console/components/data/CapabilitiesField.tsx (Phase 1 — → FeaturesField multi-select)
- apps/web/src/features/console/ModelAccessPage.tsx (Phase 2 — model-centric view)
- packages/adapters/src/{openai,anthropic,gemini}.ts (Phase 2 — preserve native_finish_reason)

---

# 附录 B：起草者标注的遗留/风险（须评审拍板）

**Contracts & Templates**: 1) Migration serialization: spec allocates mig 0062 (model_spec.features/parameter_rules), 0063 (channel_model.param_override), 0064 (model.param_profile snapshot). Latest on main = 0061, so these are correct, but the DB-schema/engine section owns them — the view `param_profile` field assumes 0064's snapshot column exists (D1). Contracts here are migration-agnostic (they parse jsonb) but the `modelViewSchema.param_profile` mapper must `.parse({})` when the column is absent pre-0064. 2) `resolveRule` uses a permissive cast on the template (`tpl as Partial<ParameterRule>`) because PARAM_TEMPLATES values are `as const` literals (readonly options tuples) that don't structurally assign to the mutable `ParameterRule`; acceptable but worth a lint check. 3) `native_finish_reason` wire-surfacing requires each dialect RESPONSE renderer to emit it (openai/anthropic/gemini) — that's adapter work outside contracts; I only added the IR field + stream event. 4) Spec §4.4 keeps `paramOpSchema.value` as `z.unknown().optional()`; I added a superRefine requiring value for `set` / a bound for `clamp` — a stricter-than-spec guard. If the assembler wants to preserve permissive spec-exact shape, drop the superRefine. 5) `channelModelLinkInputSchema` currently lives in catalog-views.ts (a request schema in a views file — pre-existing); I extended it in place rather than relocating to avoid churn, but a purist may move it to catalog-requests.ts.

**DB Schema, Migrations & Repos**: 1) CLAUDE.md says migrations live in `packages/db/migrations` but they actually live in `packages/db/drizzle/` (drizzle-kit dir with meta/\_journal.json + snapshots). Migrations must be drizzle-kit GENERATED (edit schema → db:generate), not hand-written, so snapshots/journal stay consistent — hand-numbering risks a drift the pre-push gate (.husky) may catch. 2) D1 freeze SOURCE mismatch: pricing is frozen from `official_model_price` via matchOfficialPrice(provider,slug), but the PROFILE must freeze from `model_spec` (规格库) via getModelSpec(vendor=provider, modelId=slug). These are two different catalog tables keyed the same way; I assumed vendor==provider key namespace (the spec/model-spec doc-comment confirms `model_spec.vendor` shares the `official_model_price.provider` namespace). Verify the provider→vendor mapping the sync caller passes actually equals the spec's vendor for the auto-freeze to hit. 3) `@actionow/contracts` type imports from `packages/db/src/schema` may create a build cycle (schema files currently import nothing from contracts). If so, use the inline structural `$type<>` fallbacks I noted rather than importing — the param-profile contracts file is owned by a different section and may not land in the same PR. 4) sync EXISTING-model branch: I chose to PRESERVE an operator-tuned param_profile (not overwrite), matching the existing 'sync never downgrades operator config' invariant. If the intent is 'always refresh from spec', that branch needs a paramProfile set added — flag for the assembler to reconcile with the engine/FE section. 5) No append-only trigger conflict (0052 covers only ledger_txn + audit_log); all three touched tables are freely UPDATE-able — verified.

**Engine Pipeline: profile-driven normalize + per-channel override wiring**: 1) Stage-④ seam ambiguity resolved by placing dropUnsupported INSIDE the adapter's buildChatBody (the only place the built wire body exists), which requires adding `paramProfile` to AdapterContext — a contracts change. Alternative (adapter returns body, engine post-drops) would need the engine to re-derive which keys are 'known-standard', duplicating dialect knowledge — rejected. Confirm reviewers accept the AdapterContext field. 2) Module placement of the 5 pipeline fns: I recommend @actionow/llm-protocol (already holds normalize.ts + is imported by both engine and api with no cycle) rather than @actionow/engine, to avoid api→engine coupling just for applyProfileDefaults. The design doc §5 says the changes are 'in execution-service' — this reconciles by keeping the applyChannelOverride CALL SITE in the engine while the pure fn lives in llm-protocol. 3) require_params (OpenRouter-style skip-channel) is D3=OFF and Phase-2 — not wired here; channels never skip on unsupported param, matching drop-and-forward. 4) native_finish_reason preservation is response-side and out of this request path slice. 5) The blocking non-chat modalities (embed/rerank/moderate/transcribe/runBlocking) do NOT get stage ②; they pass req.inputs to adapters without an IR sampling layer, so empty-override equivalence is trivial — but if ops ever want per-channel overrides there, a follow-up is needed. 6) resolveModelForTenant must parse the frozen param_profile jsonb defensively (safeParse→empty) so a malformed frozen blob can never 500 a live relay — this is the one place a bad migration/sync could otherwise break traffic.

**FRONTEND**: Backend dependencies this FE section CONSUMES and must be delivered by the API/contracts section (flag for the assembler): (1) ModelView.param_profile + getModel returning it + paramProfile in Update/CreateModelBody; (2) channel_model.param_override endpoints GET/PUT /admin/resources/{rid}/channels/{cid}/models/{modelId}/param-override + param_override surfaced on the listChannelModels rows so the col-3 chip renders; (3) GET /admin/model-specs?modelId= filter for 从规格库导入 (route + FE type re-export — no FE model-spec surface exists today); (4) for the model-centric override chip (c), the cheapest shape is a new ModelView.param_override_channel_ids: string[] mirroring served_channel_ids — if not added, ServingChannelsPanel must N+1 getChannelModelOverride per serving channel (acceptable but slower). Ambiguity: model_spec today only has key_params:string[] (no structured parameter_rules/features), so 从规格库导入 degrades to name→{name,useTemplate?} until design mig 0062 upgrades model_spec — the specToRules/specToFeatures mapper must handle both shapes. Deviation from a literal reading: the model-centric view is delivered as a ModelDetailDrawer section rather than a new top-level pane, to satisfy '与现有三栏并存' without a disruptive 4-pane rewrite — confirm this matches product intent. wirePath is intentionally OMITTED from the rule editor per LOCKED D2 (Phase-2 deferred). Coordinate merge order with open FE PR #65 (shared console.json + admin.ts).

**Test Plan, Phasing & Rollout**: Four items need assembler sign-off before SQL/code is written: (1) MIGRATION NUMBERING — spec labels Phase 1 as 0062 and Phase 0 as 0063, but Phase 0 ships first; drizzle applies by lexical filename order and a lower-numbered file landing after a higher one causes real drift (per dev-db-migration-drift memo). Number strictly by MERGE order (Phase 0 = 0062). (2) OVERRIDE `set` SEMANTICS conflict with stated precedence: spec says request > ②override > ①profile (implying `set` is a default), but the cited reference new-api treats `set` as a HARD FORCE. E0-4 must pin one; recommend hard-force with request-wins applying only to profile defaults — this slightly diverges from the literal precedence line, flag it. (3) normalize.ts DUAL-PATH window in Phase 1 (hardcoded drop-list + profile gate coexist via fallback-when-null); normalize.test.ts must stay green throughout, retire its assertions only after freeze verified in prod. (4) APPEND-ONLY (mig 0052): must confirm no business-UPDATE-blocking trigger on model (param_profile is rewritten on every sync-freeze) or channel_model (param_override edited by ops) — int tests I0-5/I1-7 assert this; if model is guarded, freeze needs a mig-0052-style carve-out. DEPLOY: fat ~2GB image + ~0.5MB/s registry = ~1hr/pull; batch all three migrations into ONE deploy or slim the image before landing, else three separate hour-long pulls.
