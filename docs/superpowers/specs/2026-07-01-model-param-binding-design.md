# 模型参数绑定重构设计规格（Model Parameter Binding Redesign）

- **日期**: 2026-07-01
- **状态**: Draft / 待评审
- **作者**: Actionow team (with Claude)
- **前置**: [[catalog-supply-hierarchy]] (平台→通道→模型, channel_model link mig 0033) · [[model-onboarding-3pane-icons]] (插件→通道→模型 三栏) · [[official-model-catalog-2026-06-30]] (规格库 model_spec + key_params) · [[capability-gap]] (#72 extra 透传 + reasoning 降级) · [[media-relay-plugins-design]] (Dify 式插件)

---

## 1. 背景与问题

### 1.1 现状

请求体构造与响应解析今天**绑定在协议/方言（插件）层**，不在模型层：

- **转换代码**：`packages/adapters/src/{openai,anthropic,gemini}.ts` 的 `buildChatBody(ir, ctx, stream)` / `extractUsage(raw)`，按**方言**分派（渠道的 `provider_type` / `plugin_id` 决定用哪个适配器）。
- **模型层今天只贡献**：`model.capabilities`（6 个粗布尔 tools/vision/audio/json/file/reasoning）经 `normalizeRequest` 做门控/降级；`model.input/output/cached_price`（计费）；`fallback_models`；`rate_limit`；`channel_model` 链（mig 0033，仅路由偏好）。

### 1.2 四个精确缺口

1. **无 per-model 参数 schema/transform** —— `ChatParams`（`packages/contracts/src/chat.ts`）是所有模型共用的一份固定 zod；`buildChatBody` 硬编码每个方言的参数映射。模型专属参数（如 `enable_thinking`、`prompt_caching_*`、`top_k`）只能塞进无类型的 `extra` 袋子。
2. **无 per-(模型×渠道) 覆盖** —— 参数只来自调用方 IR；模型只贡献能力+价格，渠道只贡献 transport（endpoint/model-id/credential/proxy/config）。**同一模型经不同渠道（直连 vs 中转）无法有不同参数**。`upstreamChannel.config` 存在但聊天适配器**不读它**（只被通用/媒体插件消费），且是渠道级不是 per-(模型×渠道)。
3. **capabilities 太粗** —— 只有 6 个布尔，无粒度（json_schema vs json_object、reasoning_effort 档位、上下文上限、tool 并行等）。唯一 enforcement 点 `normalize.ts` 只能 400 或 drop 采样参数。
4. **`extra` 无类型透传** —— `z.record(string, unknown)`，被每个 `buildChatBody` 原样 spread；唯一碰它的是 `normalize.ts` 里一份**硬编码全局** reasoning drop-list，不是 per-model。

### 1.3 目标

- 让**不同模型的不同参数**成为一等公民（声明式，非 `extra` 袋子）。
- 让**同模型跨渠道**可以有不同参数契约。
- 不降低接入速度、不破坏请求/响应正确性、不引入可感知的性能开销。
- **增量**落地，全程向后兼容（空配置 == 现状）。

---

## 2. 调研结论（收敛出的模式）

对 LiteLLM / one-api·new-api / OpenRouter / Portkey·Cloudflare / **Dify** 的调研收敛出同一形状：

| 项目              | 转换代码绑在                             | 参数契约（allowed/default/clamp/drop）绑在                                 | 同模型跨渠道                             | 不支持参数                                               |
| ----------------- | ---------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------- |
| LiteLLM           | per-provider config 类                   | `get_supported_openai_params(model)`（类内按 model 分支）+ model_info JSON | per-**deployment**                       | 三态 error/drop/allow-through；非标透传                  |
| one-api / new-api | 渠道类型 adaptor(代码)                   | new-api `ParamOverride` JSON 操作引擎(set/delete/move + 按 model 条件)     | 多个渠道行 + 各自 override               | 构造式丢弃(omitempty+显式拷贝)                           |
| OpenRouter        | 统一 schema 内部转发                     | **per-(模型×endpoint)** `supported_parameters`                             | 一 model → 多 endpoint 各自 supported    | 默认静默 drop + `require_parameters` 路由                |
| Portkey           | per-(provider,endpoint) 声明式 param-map | 同左 + `getConfig(model)` 分支 + per-target override                       | 每个 **target**                          | 声明式 map + 显式 `drop_params`；request>target>provider |
| **Dify**          | provider 插件(Python 代码)               | **per-model YAML `parameter_rules`** + `use_template` + `features`         | 靠 customizable model 各自加(仍是模型级) | 声明式 rules,未声明的不映射                              |

**Dify `parameter_rules` 是 per-model 声明式参数档案的黄金参考**（`name/type/default/min/max/required/help` + `use_template` 复用通用参数 + `features` 能力枚举 + 模型专属参数一等公民声明）。但 **Dify 不覆盖 per-(模型×渠道)** —— 那一层要借鉴 new-api override / Portkey target / LiteLLM deployment。

**核心原则（本设计的地基）**：

> **转换「代码」继续绑在插件/协议上（保留适配器）；参数「契约/数据」下沉到 `模型` + `(模型×渠道)` 两级声明式数据层。**
> 不按模型拆转换代码 —— 没有任何成熟项目这么做。

---

## 3. 架构：四层管线

```
调用方 IR (ChatRequest)
  │
  ├─①  ModelParamProfile（模型级，声明式数据）            [新增]
  │       features[] + parameter_rules[] + dropPolicy
  │       数据源 = 规格库 model_spec（升级 key_params）
  │       作用：填 default → clamp min/max → 门控/降级(gate) → 声明模型专属参数
  │
  ├─②  channel_model.param_override（模型×渠道级）          [新增]
  │       set / force / clamp / delete （借鉴 new-api JSON 操作）
  │       作用：同模型在不同渠道的差异（强制/覆盖/裁剪某参数）
  │
  ├─③  插件/方言适配器 buildChatBody（协议级代码）          [保留]
  │       = Dify provider 代码 / one-api adaptor / Portkey provider
  │
  └─④  drop 不支持参数 + 非标参数透传 + (可选) require_params 路由  [新增/强化]
```

- **优先级**：`request > ②(模型×渠道)override > ①model profile > 插件/方言默认`（照抄 Portkey）。
- **响应侧不动**：仍是插件级 `extractUsage`（#70 已归一 usage breakdown）；仅补 OpenRouter 式 `native_finish_reason`（原样保留上游值）。

---

## 4. 数据模型 / Schema

### 4.1 ParameterRule（单条参数规则，Dify parameter_rules 形状）

`packages/contracts/src/param-profile.ts`（新文件）

```ts
export const parameterRuleSchema = z.object({
  name: z.string().min(1), // IR/OpenAI 参数名，或模型专属名
  // 复用通用模板（temperature/top_p/max_tokens/response_format/stop/…）；给了 template 则以下字段作为覆盖
  useTemplate: z.string().optional(),
  type: z.enum(['float', 'int', 'boolean', 'string', 'enum', 'json']).optional(),
  default: z.unknown().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  required: z.boolean().optional(),
  options: z.array(z.string()).optional(), // enum 选项（如 reasoning_effort: low|medium|high）
  help: z.string().optional(),
  // 该参数落到上游 wire body 的位置（可选；缺省 = 适配器方言默认映射）
  // 例：Anthropic thinking.budget_tokens → wirePath: 'thinking.budget_tokens'
  wirePath: z.string().optional(),
});
export type ParameterRule = z.infer<typeof parameterRuleSchema>;
```

### 4.2 ModelParamProfile（模型级参数档案）

```ts
export const DROP_POLICIES = ['error', 'drop', 'passthrough'] as const; // 不支持参数策略
export const modelParamProfileSchema = z.object({
  // capabilities 升级：细粒度 features 枚举（Dify features）
  features: z.array(z.string()).default([]), // tool-call, vision, json-schema, reasoning, parallel-tool, …
  parameterRules: z.array(parameterRuleSchema).default([]),
  // 未在 parameterRules 声明的“已知标准参数”遇到时：默认 passthrough（永不过度删除）
  dropPolicy: z.enum(DROP_POLICIES).default('passthrough'),
});
export type ModelParamProfile = z.infer<typeof modelParamProfileSchema>;
```

**存储**：升级规格库 `model_spec`（`packages/db/src/schema/model-spec.ts`）—— 把 `key_params jsonb (string[])` 升级为 `parameter_rules jsonb (ParameterRule[])`，并加 `features jsonb (string[])`。规格库是**参数档案的权威数据源**（#76 已建 236 行）。运行期 `model` 表按需引用/内联该 profile（见 §6 迁移）。

### 4.3 参数模板库（use_template）

`packages/contracts/src/param-templates.ts`（新文件，代码内常量）—— Dify 的 `PARAMETER_RULE_TEMPLATE` 等价物：

```ts
export const PARAM_TEMPLATES = {
  temperature: { type: 'float', default: 1.0, min: 0, max: 2, help: '…' },
  top_p: { type: 'float', default: 1.0, min: 0, max: 1 },
  max_tokens: { type: 'int', min: 1, help: '…' },
  response_format: { type: 'enum', options: ['text', 'json_object', 'json_schema'] },
  reasoning_effort: { type: 'enum', options: ['low', 'medium', 'high'] },
  stop: { type: 'json' },
  top_k: { type: 'int', min: 1 },
  seed: { type: 'int' },
  // …
} as const;
```

`resolveRule(rule)` = `useTemplate` 时取模板再用 rule 字段覆盖；否则用 rule 自身。通用参数只写一行 `{ name:'temperature', useTemplate:'temperature' }`，模型专属参数内联全量声明。

### 4.4 ParamOverride（模型×渠道覆盖）

`packages/contracts/src/param-profile.ts`

```ts
// 借鉴 new-api 的 JSON 操作；对 IR.params + IR.extra 生效，在适配器渲染 body 之前
export const paramOpSchema = z.object({
  op: z.enum(['set', 'clamp', 'delete']), // set=强制值 · clamp=夹到 min/max · delete=删除该参数
  name: z.string(), // 目标参数名（支持点路径给 extra 里的嵌套字段）
  value: z.unknown().optional(), // set 用
  min: z.number().optional(),
  max: z.number().optional(), // clamp 用
  when: z.object({ modelMatches: z.string().optional() }).optional(), // 可选条件（同渠道多模型）
});
export const paramOverrideSchema = z.object({ ops: z.array(paramOpSchema).default([]) });
export type ParamOverride = z.infer<typeof paramOverrideSchema>;
```

**存储**：`channel_model`（mig 0033 那张 join 表，今天只有 `{channelId, modelId, createdAt}`）**加一列 `param_override jsonb`**。这是「同模型跨渠道不同参数」的家。

### 4.5 迁移（下一个是 0062）

- **mig 0062**: `model_spec` 增 `features jsonb`、`parameter_rules jsonb`（保留旧 `key_params` 一版做兼容，随后 drop）。
- **mig 0063**: `channel_model` 增 `param_override jsonb`（nullable，默认空 = 现状）。
- **mig 0064**（可选，运行期加速）: `model` 增 `param_profile jsonb`（从 model_spec 冻结的档案快照，避免运行期 join 规格库）；或不加列而在 model resolution 时 join model_spec（见 §8 性能）。

---

## 5. 引擎管线（apply 顺序）

改造点集中在 `packages/engine/src/execution-service.ts`（`buildContext` / `maybeTrace` 附近）与 `packages/llm-protocol/src/normalize.ts`（把硬编码 drop-list 换成 profile 驱动），以及 `apps/api/src/chat/chat-relay.service.ts`（把 profile + override 装进 RunRequest）。

**请求路径**（IR → wire）：

```
1. applyProfileDefaults(ir, profile)   // 缺省参数填 default（模板解析后）
2. clampToRules(ir, profile)           // 越界参数夹到 min/max（或按 dropPolicy 处理）
3. gate(ir, profile.features)          // 能力门控/降级（今天 normalizeRequest 的强化版；reasoning 模型的采样参数降级改由 profile 表达）
4. applyChannelOverride(ir, channelModel.param_override) // ②：set/clamp/delete，条件 when.modelMatches
5. adapter.buildChatBody(ir, ctx)      // ③：保留，方言渲染
6. dropUnsupported(body, profile.dropPolicy) // ④：未声明的“已知标准参数” drop（passthrough 默认不删非标）
```

**响应路径**：`adapter.extractUsage` 归一（现状）+ 保留 `native_finish_reason`。

**require_params 路由（可选，OpenRouter 式）**：`route_group` / `channel_model` 选路时，若请求带了某参数而候选渠道的 `(model,channel)` profile 不支持，可配置为**跳过该渠道**（走 fallback），而非静默 drop。默认关闭（保持 drop-and-forward）。

---

## 6. 从现状迁移（每步向后兼容）

| 今天                                      | 迁移到                                               | 兼容性                                                                           |
| ----------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| `model.capabilities`（6 布尔）            | `profile.features`（枚举数组）                       | 迁移脚本：布尔 → feature 名；空 features == 全放行                               |
| `model_spec.key_params`（string[]）       | `parameter_rules`（结构化）                          | 已有 236 行；key_params 名 → `{name, useTemplate?}`；缺省 dropPolicy=passthrough |
| `normalize.ts` 硬编码 reasoning drop-list | profile 的 reasoning feature + parameter_rules gate  | 无 profile 时回退到现有 drop-list 行为                                           |
| `extra` 无类型透传                        | 模型专属参数进 `parameter_rules`；其余仍 passthrough | `extra` 保留；非标参数默认透传（LiteLLM 语义）                                   |
| 无 per-(模型×渠道)                        | `channel_model.param_override`                       | 空 override == 现状                                                              |

**渐进式**：任何一步没配置 = 今天的行为。profile / override 是「填得越多越准」，不是「填不完不能用」。

---

## 7. 前端改造

现状问题（`apps/web/src/features/console`）：三栏 `插件→通道→模型` 逼你通过单条 plugin→channel 路径够到模型；参数只在 `ModelEditor` 编辑（全局模型字段 + 粗布尔 `CapabilitiesField`），**无 per-model 参数表单、无 per-(模型×渠道) 编辑**；`ChannelEditor` 的 `channel.config` 是裸 KV；唯一声明式 param schema（插件 manifest `paramFields`）只服务媒体插件。

改法：

1. **模型中心视图**（新）：以模型为主实体，列出服务它的所有渠道 + 每渠道的 override 状态。与现有三栏并存（三栏管接入，模型视图管参数）。
2. **参数档案编辑器**（新，`ModelEditor` 内）：渲染 `parameter_rules`（表单来自模板库 + 规格库 `model_spec`），能力从 `CapabilitiesField` 升级为 `features` 多选。
3. **参数覆盖面板**（新）：在渠道的模型列表里，每个已链接模型给一个「参数覆盖」编辑（写 `channel_model.param_override`：set/clamp/delete + 条件）。
4. **模板库**：泛化插件 manifest 的 `paramFields` 概念为共享 `use_template` 库。

受影响文件：`ModelAccessPage.tsx`、`ModelEditor.tsx`、`ModelsCatalogPage.tsx`、`ChannelEditor.tsx`、`PluginsPage.tsx`、`components/data/CapabilitiesField.tsx`（→ FeaturesField）+ 新增 param-profile / param-override 组件。

---

## 8. 三个保证（评审要点）

### 8.1 快速接入 —— ✅（已有协议）

数据驱动接入，无需写代码；规格库 + `sync-models` 自动填充已知模型的 profile。**新协议仍需插件（同今天、同 Dify）**。profile 可选渐进，空 profile == 现状，永不阻塞接入。

### 8.2 请求/响应正确 —— ✅ 严格 ≥ 今天

修掉当前两个错误源（不支持参数 400、跨渠道参数错发）；响应解析不动。**正确性 = 代码(适配器,已测) + 数据(profile,须维护)**，无法数学保证。安全网：默认 `dropPolicy=passthrough`（只 drop 已知不支持，非标透传）+ 接入即测（`POST /admin/models/test`，#12 已上线）+ 中转追踪（RELAY_TRACE，已开）看真实 wire。

### 8.3 性能 —— ✅ 可忽略

参数层是纯内存变换（µs 级），被上游 LLM 延迟（百 ms~秒）淹没，无新增网络跳数、不随 token 增长。**唯一要做对**：profile / override 随**模型解析一起加载或缓存**（如 SettingsResolver 的 10s TTL），别每请求单独查库（N+1）。→ §4.5 mig 0064 快照列 或 model resolution join 二选一。

---

## 9. 分期落地

- **Phase 0（最小切片，验证最痛点）**: `channel_model.param_override`（mig 0063）+ 引擎 ④ 应用层（set/clamp/delete）+ 渠道模型列表的「参数覆盖」面板。**直接解决「同模型跨渠道不同参数」**，其余全走现状。
- **Phase 1（模型档案）**: `ParameterRule`/`ModelParamProfile` 契约 + 模板库 + `model_spec` 升级（mig 0062）+ 引擎 ①②③（defaults/clamp/gate）+ `normalize.ts` 改 profile 驱动 + `ModelEditor` 参数档案编辑器。`capabilities → features`。
- **Phase 2（打磨）**: `require_params` 路由 + `native_finish_reason` + 模型中心视图 + `sync-models` 自动填充 profile（从 model_spec）+ 运行期缓存/快照。

每期独立可上线，向后兼容。

---

## 10. 非目标 / Open Questions

**非目标**：不重写方言适配器；不引入按模型的转换代码；不做请求体的图灵完备 DSL（override 限 set/clamp/delete，够用即止，避免 new-api 那种复杂度）。

**待定**：

1. profile 运行期存放：`model.param_profile` 快照列 vs model resolution join `model_spec`？（性能 vs 数据新鲜度）
2. `parameter_rules.wirePath` 是否引入 —— 让 profile 能声明「该参数落到上游 body 的哪个路径」，减少适配器里的硬编码映射；还是继续由适配器方言负责映射、profile 只管 allow/default/clamp？（决定 profile 与适配器的职责边界）
3. `require_params` 默认开还是关？（正确性 vs 可用性/路由收窄）
4. media（async-media）走同一 profile 体系还是独立？（媒体参数是 params object，非 OpenAI 采样参数）

---

## 11. 参考

- Dify parameter_rules: `langgenius/dify-official-plugins` models/_/models/llm/_.yaml；`use_template` / `features` / `model_properties`。
- LiteLLM: `get_supported_openai_params(model)`, `drop_params`/`additional_drop_params`/`allowed_openai_params`, `model_prices_and_context_window.json`。
- new-api: `relay/common/override.go` ApplyParamOverride（JSON operations + conditions），`model/channel.go` ParamOverride/HeaderOverride（渠道级/tag级）。
- OpenRouter: `/models` 的 `supported_parameters`、`/models/{id}/endpoints` per-endpoint supported_parameters、`require_parameters`、`native_finish_reason`。
- Portkey: `src/providers/*/` ProviderConfigs（ParameterConfig: param/default/min/max/transform）+ `getConfig(model)` + target default/override/drop。
