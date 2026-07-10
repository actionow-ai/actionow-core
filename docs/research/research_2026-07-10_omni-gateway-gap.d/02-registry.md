# 02 · 模型注册表（目录/供给三层）与模型接入流程 — 现状事实

> Research findings only。仓库 /Users/alienworm/actionow-core，分支 feat/ops-tab-layout-quickwins（HEAD 0af6b941）。对照 /tmp/omni-spec.txt §5.5（注册表条目）、§4.2（范式判定）、§6（数据模型）。所有行号以当前工作区为准。

## 三层数据模型现状

实际三层 = `resource`（UI 叫「平台」）→ `upstream_channel`（通道）→ `model`（对外模型名），外加 link 表 `channel_model` 与两张目录辅助表（`model_spec` 规格库、`official_model_price` 官方价目）。

### 第 1 层 `resource`（平台）— packages/db/src/schema/catalog.ts:19-45

| 字段                                 | 说明                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------- |
| `id` text PK                         | 人读 slug（刻意非 uuid，catalog.ts:22）                                 |
| `tenant_id` uuid FK→tenant, nullable | NULL=全局平台资源（任何租户可跑）；非 NULL=租户私有（catalog.ts:24-29） |
| `kind` text NOT NULL                 | `model` \| `workflow`                                                   |
| `modality` text NOT NULL             | text\|image\|video\|audio\|composite                                    |
| `provider_type` text NOT NULL        | 适配器协议名                                                            |
| `exec_modes` jsonb string[] NOT NULL | 范式声明挂在这一层（见 §4.2 对照）                                      |
| `status`                             | active\|disabled（CHECK catalog.ts:43）                                 |
| `current_version` int                | 指向 resource_version                                                   |
| created/updated/deleted_at           | 软删                                                                    |

`resource_version`（catalog.ts:48-65）：`(resource_id, version)` 唯一，冻结 `io_schema` jsonb，不可变（无 updated_at）。**resource 版本化的只有 io_schema**，路由/定价/通道不在版本内。

### 第 2 层 `upstream_channel`（通道）— catalog.ts:67-137

| 字段                                              | 说明                                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `id` uuid PK; `resource_id` FK NOT NULL           | 通道属于一个平台                                                                                       |
| `provider_type` text NOT NULL                     | 该通道的适配器                                                                                         |
| `credential_ref` uuid（松散 locator，非 FK）      | 指向 `secret_ref`（env/enc/oauth/vault 四种，catalog.ts:179-206）；**单凭证，无凭证池**                |
| `endpoint` text                                   | 上游 base URL；null→适配器默认                                                                         |
| `model` text                                      | **每通道上游模型 id 钉选（单值）**；null→透传（catalog.ts:81-82）                                      |
| `proxy_ref` text                                  | 出口代理 locator                                                                                       |
| `config` jsonb                                    | 通用中继协议配置（submitPath/pollPath/签名头等，vendor 细节作为数据）                                  |
| `input_cost_per_1m` / `output_cost_per_1m` bigint | 运营方在该通道的**真实成本**（µUSD/1M），只进 provider_cost/margin，绝不驱动客户价（catalog.ts:90-99） |
| `plugin_id`+`plugin_version`                      | 插件适配器绑定（钉版本快照）                                                                           |
| `fault_policy_id` FK                              | 调用容错策略绑定                                                                                       |
| `trust`                                           | trusted\|untrusted                                                                                     |
| `model_map` jsonb Record<our→upstream>            | 中转改名映射——**全仓无任何消费者（死列）**，grep apps/+packages/ 仅命中 schema 定义                    |
| `weight` int; `tags` text[]; `icon`; `status`     | tags=染色路由                                                                                          |

### 第 3 层 `model`（对外模型名）— packages/db/src/schema/model.ts:31-122

| 字段                                                                                                | 说明                                                                                             |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `name` text                                                                                         | **对外唯一逻辑名**（partial unique `model_name_idx` where deleted_at IS NULL，model.ts:114-116） |
| `display`; `modality`（default `'chat'`）                                                           |                                                                                                  |
| `capabilities` jsonb Record<string,boolean>                                                         | tools/vision/audio/json/file/reasoning 布尔旗标                                                  |
| `visibility`                                                                                        | public\|tenant（tenant 需 `model_grant`）                                                        |
| `resource_id` FK NOT NULL                                                                           | 模型隶属一个平台                                                                                 |
| `input_price`/`output_price` bigint                                                                 | **µUSD/1M tokens 整数售价**；`cached_input_price` nullable（拆分计费）                           |
| `param_profile` jsonb ModelParamProfile                                                             | 冻结参数档案（features+parameterRules+dropPolicy，mig 0064）                                     |
| `needs_pricing` bool                                                                                | sync 未匹配官方价→disabled+true，永不 0 价计费（model.ts:72-74）                                 |
| `rate_limit` int                                                                                    | per-(tenant,model) RPM（model.ts:75-80）                                                         |
| `fallback_models` jsonb string[]                                                                    | 模型降级链（model.ts:82-87）                                                                     |
| `tags` text[]; `maker`; `context_length` int; `reasoning`(none\|optional\|always); `icon`; `status` | 目录 facet，不参与路由 gate                                                                      |

- `model_grant`（model.ts:129-142）：`(model_id, tenant_id)` 唯一。
- `channel_model`（model.ts:152-176）：PK `(channel_id, model_id)`，+ `param_override` jsonb（模型×通道级参数覆盖，mig 0062）。存在 = 「该通道能服务该模型」；路由对已 link 通道**优先**（未 link 的降 1,000,000 优先级档，common/channel-routing.service.ts:54,217-232），不是硬 gate。

### 逻辑名 vs 上游名

- 对外名 = `model.name`；上游名 = `channel.model`（单值钉选）`?? ir.model` 原样透传：engine buildContext execution-service.ts:1527 → adapters/openai.ts:132、anthropic.ts:121、gemini.ts:348 均 `ctx.model ?? ir.model`。
- **多模型通道（一通道 serve N 模型）没有 per-(model,channel) 改名机制**：`channel.model` 是通道级单值；专为此设计的 `model_map` 列无消费者。
- 目录辅助层的名字空间：`model_spec.(vendor, model_id)`、`official_model_price.(provider, model_slug)`（normalize：小写、去日期后缀、alias 映射，official-price.ts:23-27）。

### 目录辅助表

- `model_spec`（model-spec.ts:38-116）：vendor/model_id/display/family/type(text|image|video|audio|multimodal)/inputModalities/outputModalities/mediaOptions(自由 jsonb)/features/parameterRules(Dify 形)/contextWindow(TEXT)/maxOutput(TEXT)/confidence(firstparty|secondary|reconstructed)/billingEligible/sources/sourceUrl/asOf。
- `official_model_price`（official-price.ts:28-84）：per-1M 三列 + `scheme` jsonb PriceSpec（富媒体：credits/matrix/fixed 也可入目录计费）+ currency + billingEligible（双保险 gate）+ effective_at + updated_by。
- `route_group`/`route_group_channel`（route-group.ts）：分组 = 访问+价格倍率(`group_ratio_bps` bps)+兜底链(`fallback_group_id`)+`require_params`；成员行携 priority/weight。api_key 绑 `route_group_id`（identity.ts:51）。
- `pricebook_entry`（pricing.ts:18-40）：resource(+version) 级价目，method×timing(pre|post)+spec+markup，带自身 version。

## 与 spec 5.5 / 4.2 / 6 的逐项对照表

### spec §5.5 注册表条目（/tmp/omni-spec.txt:945-970）

| spec 字段                                     | 有/部分/无 | 证据                                                                                                                                                                                                                                                      |
| --------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model` 逻辑名（对外唯一）                    | 有         | model.name partial-unique（model.ts:114-116）                                                                                                                                                                                                             |
| `display_name`                                | 有         | model.display（model.ts:36）                                                                                                                                                                                                                              |
| `modality`                                    | 有         | model.modality + resource.modality 两处并存（model.ts:37 / catalog.ts:31）                                                                                                                                                                                |
| `operations`（video.generation 等操作维度）   | 无         | 无 operation 概念；端点→资源硬编码绑定（media-dialect.service.ts:41-42 `IMAGE_RESOURCE='image-relay'` 常量）                                                                                                                                              |
| `paradigms`（model×operation→范式集合）       | 部分       | 范式=`resource.exec_modes`，**平台级**非模型级（catalog.ts:33；枚举 contracts/adapter.ts:6 `blocking/stream/async-poll/async-callback`）                                                                                                                  |
| `capabilities`（t2v/i2v 等）                  | 部分       | 运行时 gate 只有布尔 {tools,vision,audio,json,file,reasoning}（llm-protocol/capabilities.ts:1-29）；生成能力枚举仅在目录层 model_spec.features/mediaOptions，不进运行时                                                                                   |
| `input_constraints`（mime/max_mb/min_edge）   | 无         | io_schema 仅 type/required/default/options/maxLength（contracts/io-schema.ts:3-23），无媒体约束                                                                                                                                                           |
| `limits`（max_duration_s/resolutions）        | 部分       | model_spec.mediaOptions 自由 jsonb（model-spec.ts:56），catalog-only；运行时不校验                                                                                                                                                                        |
| `slow`（自动升格标记）                        | 无         | 全仓 grep 无 slow 升格逻辑                                                                                                                                                                                                                                |
| `endpoints[].provider`                        | 有         | channel.provider_type / plugin_id（catalog.ts:74,105）                                                                                                                                                                                                    |
| `endpoints[].adapter{type,ref,version}`       | 部分       | 代码适配器按 providerType 注册；插件通道钉 plugin_version 快照（catalog.ts:100-106）；无声明式 DSL(yaml) 适配器                                                                                                                                           |
| `endpoints[].region` / `compliance_domain`    | 无         | schema 全 grep 无 region/compliance 列                                                                                                                                                                                                                    |
| `endpoints[].weight`                          | 有         | channel.weight + route_group_channel.priority/weight（catalog.ts:117 / route-group.ts:91-93）                                                                                                                                                             |
| `endpoints[].key_pool`                        | 无         | 单 credential_ref（catalog.ts:78）；无凭证池/轮换/cooldown                                                                                                                                                                                                |
| `endpoints[].rate{concurrent_tasks}`          | 无         | 无上游侧并发闸；并发只是治理维度 limit_rule dimension='concurrency' 绑 key/tenant（limit.ts:59,89）+ model.rate_limit RPM（消费侧）                                                                                                                       |
| `endpoints[].timeouts{submit,max_run}`        | 部分       | fault_policy 四级超时 connect/ttft/read/total per-attempt + 同通道 retry/backoff（fault-policy.ts:33-54），通道级绑定；media 探测/轮询预算写死代码（model-test.service.ts:31-32）                                                                         |
| `pricing[]{unit,price,currency,tier,version}` | 部分       | 7 种 PriceSpec（unit/matrix/fixed/formula/passthrough/model_token/credits，contracts/pricing.ts:3-11）；一律整数 µUSD 记账（currency 仅元数据，official-price.ts:51）；version 在 pricebook_entry（pricing.ts:26）；tier 可用 matrix key 表达但非一等字段 |
| `task_defaults{result_retention}`             | 部分       | 文件 TTL 是 account 级（POST /admin/accounts/:id/file-ttl，admin.controller.ts:667），非模型级                                                                                                                                                            |
| 「热更新、带版本与灰度」                      | 部分       | 无缓存=改行即下一请求生效（见下），但**无版本化/灰度**；model/channel 行直接 UPDATE                                                                                                                                                                       |

### spec §4.2 范式判定（/tmp/omni-spec.txt:676-687）

| spec 判定                            | 有/部分/无 | 证据                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| operation+注册表→范式集合            | 部分       | resource.exec_modes；/v1/run 校验 selectExecMode，不支持→400（run.service.ts:244-297）                                                                                                                                                                                                                                   |
| `stream=true`→STREAM                 | 有         | chat body stream / run exec_mode=stream 强制（run.service.ts:148-150 SSE forceMode）                                                                                                                                                                                                                                     |
| `gw.async=true`→TASK                 | 部分       | 仅 /v1/run 的 exec_mode=async-poll/async-callback→202+job_id（run.controller.ts:15-74）；chat/images 等方言端点无 async 开关                                                                                                                                                                                             |
| WS 升级→REALTIME                     | 无         | 无 realtime 端点                                                                                                                                                                                                                                                                                                         |
| slow=true 同步请求自动升格 202       | 无         | **反向机制存在**：图像/TTS 是同步门面把异步 relay 在进程内拉到终态再 200 内联返回（media-dialect.service.ts:66-71），HTTP 连接可挂到 poll 预算上限                                                                                                                                                                       |
| 能力校验 strict/lenient + warnings[] | 部分       | tools/json/vision/audio/file 恒 strict 400（llm-protocol normalize.ts:61-78）；reasoning 模型的 temperature/top_p 等恒 lenient 静默丢弃（normalize.ts:41-44）；**无 warnings[] 响应字段、无 per-request strict/lenient 开关**；参数档案 dropPolicy(passthrough/drop/error) 是 per-model 配置（apply-profile.ts:121-189） |

### spec §6 数据模型（/tmp/omni-spec.txt:991-1014）

| spec 表                                             | 有/部分/无 | 证据                                                                                                                                                                    |
| --------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tenants（compliance_domain/balance）                | 部分       | tenant + account 余额分表；无 compliance_domain                                                                                                                         |
| api_keys（scopes(models[])、dialect_binding）       | 部分       | hash 唯一 + `resource_allowlist`（资源级非模型级）+ route_group + limit_plan + subject + rate_limit（identity.ts:34-71）；**无 dialect_binding，方言纯由 URL 路径决定** |
| provider_keys（pool/region/rate_declared/cooldown） | 部分       | secret_ref+secret_material(AES-256-GCM)+oauth_session；无池/region/声明速率/cooldown                                                                                    |
| models / model_endpoints 版本化                     | 部分       | model 无版本；resource_version 只冻结 io_schema；变更走 @Audit 审计无灰度                                                                                               |
| tasks（owner_node/lease_until/provider_task_id）    | 部分       | `job` 表：queued/running/succeeded/failed/canceled + idempotency_key + hold_expires_at（execution.ts:23-79）；**无租约列（单 worker 假设）**                            |
| task_events（append-only 事件流）                   | 无         | 无独立事件表；audit_log 是全局 append-only 审计                                                                                                                         |
| files/artifacts                                     | 有         | storage.ts + files 端点 + TTL reaper                                                                                                                                    |
| usage_events                                        | 有         | usage_log（usage.ts:14），append-only                                                                                                                                   |
| webhook_deliveries                                  | 部分       | webhook_outbox（pending/sent/dead + next_attempt_at，execution.ts:195-213）                                                                                             |
| audit_logs                                          | 有         | audit.ts append-only + 触发器（mig 0052）                                                                                                                               |

## 接入一个新模型的现实步骤（按现状代码走一遍）

以「给某平台接一个新 chat 模型」为例（管理面 = /admin/\*，UI = /console）：

1. **建平台（如尚无）**：`POST /admin/resources`（admin.controller.ts:956）或 `POST /admin/resources/ensure`（:966，幂等）——给 id/kind/modality/provider_type/exec_modes/io_schema（chat 资源 io_schema 必须为空数组，否则方言 relay 全被 "prompt: Required" 挡死，seed-providers.ts:41-49）。`GET /admin/provider-types`（:976）列可用适配器。
2. **建通道**：`POST /admin/resources/:id/channels`（:1009）——credential_ref（先 `POST /admin/secrets` :831 建 env/enc/oauth 凭证）、endpoint、可选 model 钉选、proxy_ref、config、fault_policy_id、weight/tags。
3. **接入前预测试**：`POST /admin/models/test`（:1516 → model-test.service.ts）——按 resource.modality 分两腿探测：chat=一行 ping（temperature 0、≤32 tokens），media=最小生成 submit→poll（2.5s×48=120s 上限）；返回 connectivity（可达+鉴权）与 functional（真出活）两个独立判定；只读、不落任何行（model-test.service.ts:36-49）。
4. **建模型行**，二选一：
   - **自动**：`POST /admin/resources/:id/channels/:channelId/sync-models`（:1151 → admin.service.ts:1610-1686）：adapter.listModels 拉上游 slug → `upsertModelsFromSync`（db/repositories/model.ts:174 起）：匹配 `official_model_price`→official 价 active；未匹配+显式默认价→active；未匹配无默认→**disabled+needs_pricing（永不 0 价计费）**；已存在→保价只刷 display/capabilities。同时从 `model_spec` 派生 capabilities（openai/anthropic/gemini 只回 id 时，Option C）并 `freezeParamProfile` 冻结参数档案（model.ts repo:18-26）。末尾 `linkChannelModelsByNames` 自动建 channel_model links。
   - **手动**：`POST /admin/models`（:1500 → admin.service.ts:1921）——**纯透传 DTO，不自动匹配 spec/官方价**（价格/param_profile 全靠调用方给）；撞活名→400（isUniqueViolation 包装）。随后手动 link：`POST /admin/resources/:id/channels/:channelId/models`（:1066，校验 model.resourceId==channel.resourceId，admin.service.ts:1564-1580）。
5. **定价补充**：模型 µUSD/1M 直接在 model 行；平台级/媒体计价走 `POST /admin/pricebook`（:1173，unit/matrix/fixed/formula/passthrough+pre/post）；官方成本目录 `POST /admin/official-prices`（:1750）；规格库 `POST /admin/model-specs`（:1801）。
6. **路由/售卖面**：分组 `POST /admin/route-groups` + `PUT /admin/route-groups/:id/channels/:channelId`（priority/weight）；tenant 级授权 `POST /admin/models/:name/grants`（:1619，visibility=tenant 时）；模型×通道参数覆盖 `PATCH .../models/:modelId/param-override`（:1078）。
7. **生效**：无需任何发布动作——模型解析与通道候选每请求直查 DB（model-resolver.service.ts:50-54 无缓存；channel-routing.service.ts:121-179 每次 4-5 个查询），改行即下一请求生效。例外：default 分组的 id/ratio 进程级缓存（channel-routing.service.ts:88-100,323-328，改 default 组倍率要重启各副本才对未绑组的 key 生效）；platform_setting 走 SettingsResolver 10s TTL（engine/settings-resolver.ts:37）。
8. **seed 预置**（fresh DB）：`seed.ts` 建 1 tenant/admin/account/api-key + openai 文本资源；`seed-providers.ts` 幂等预置 9 个全局资源（image-relay/video-relay/stt-relay/deepseek-chat/xiaomi-mimo/relay-text/openai-direct/anthropic-direct/gemini-direct，seed-providers.ts:201-364）——幂等语义 = **resource id 存在即整条 skip**（:413），已存在资源不会被补新字段；`seed-catalog.ts` 读 docs/research/official-model-catalog-normalized.json（236 模型）全量 upsert model_spec + firstparty 行 mirror 进 official_model_price；`seed-official-prices.ts` 手工核验价兜底（find-then-create，不覆盖管理员改动）。

## 值得注意的事实

1. **「注册表」是三处分裂的**：运行时路由/计费读 `model`+`channel`（每请求 SQL）；目录/规格真相在 `model_spec`+`official_model_price`；两者只在 sync/seed 时单向冻结（freeze），之后 spec 改了运行时 model 不会跟（model.ts:62-70 注释明说 mirror input_price 的冻结模式）。
2. **范式挂错层级（相对 spec）**：exec_modes 在 resource（平台）级；同一平台下不同模型无法声明不同范式；chat 方言端点（/v1/chat/completions、/v1/messages、/v1beta/…）根本不看 exec_modes，images/speech 方言端点则把异步 job 进程内拉平成同步 200（media-dialect.service.ts:66-71）——与 spec 4.2「slow 自动升格 202、禁止连接挂 5 分钟」方向相反。
3. **/v1 数据面全景**（范式）：sync = chat(+SSE)/messages(+SSE)/v1beta generateContent(+SSE)/embeddings/moderations/rerank/audio/transcriptions（按 audio_seconds 后计费）；sync-门面包异步 = images/generations、audio/speech；真异步 = /v1/run/:resourceId（blocking 200 / stream SSE / async 202+job_id+callback_url webhook）+ /v1/jobs（list/get/SSE 进度/cancel）+ /v1/files（presign/confirm/url/usage/delete）+ /v1/resources（io_schema 发现）+ GET /v1/models。控制器行号：run.controller.ts:47、jobs.controller.ts:24-62、files.controller.ts:47-99。
4. **无按 key 绑定方言**（spec 6 api_keys.dialect_binding）：api_key 表无 dialect 列（identity.ts:34-71）；Anthropic/Gemini 门面是**方言翻译（parse→IR→render）非透传**（anthropic.controller.ts:18-24、gemini.controller.ts:20-26），验签重签/AK-SK 透传（spec 3.8）不存在。
5. **参数契约两级已落地且顺序明确**：①模型档案 defaults+clamp（chat-relay.service.ts:244-249）→③能力 gate（:250 normalizeRequest）→②通道 override per-attempt set/clamp/delete，set=硬覆盖压过用户请求值（apply-override.ts:14-19 明说与设计文档的 precedence 行相悖，以 O-2 矩阵为准）→④dropUnsupported 渲染 wire 时按 dropPolicy 剪未声明标准参数（apply-profile.ts:180-189）。无「重命名」op。`require_params` 路由（组级开关，默认 off）会跳过会丢参的通道（require-params.ts、channel-routing.service.ts:188-207）。
6. **价格单位现状**：token（model_token µUSD/1M 三段：input/cached_input/output）、任意 unit 维度（tokens/images/audio_seconds…）、credits（Vidu/Kling 积分×creditValueMicroUsd）、matrix（分辨率×时长组合表）、fixed、formula、passthrough——全整数 µUSD/bigint，客户价 = model 价 × route_group ratio(bps) → markup → modifiers（contracts/pricing.ts:70-78）。**无价格历史/快照表**——审计靠软删行 + updated_by。
7. **model_map 是死列**：untrusted 中转的「我方名→上游名」映射（catalog.ts:115-116）无任何读方；多模型通道目前只能靠上游本来就认识 `model.name`。
8. **channel_model 是软偏好非硬边界**：未 link 通道被降 1,000,000 优先级仍可兜底服务该模型（channel-routing.service.ts:47-54）；「通道能否服务该模型」没有硬 gate。
9. **UI 可达性**：/console/catalog（3-pane 模型接入 ModelAccessPage）、/console/models（目录 ModelsCatalogPage）、/console/platforms（ResourcesPage=平台与定价）在 routes.tsx:114-121 均有路由；但 platforms 在 nav 里 `hidden:true`（components/console/nav-config.ts:68），2026-07-07 审计定性为「幽灵页=90% CRUD 缺口根因」（memory access-models-audit-2026-07-07）；本分支 0af6b941 已补 ModelAccessPage.tsx:72 的 header 按钮入口 `navigate('/console/platforms')`，nav 项仍隐藏。
10. **io_schema 的实际角色**：仅服务 /v1/run 表单式资源——engine 侧 strict 校验（unknown key 拒绝、default 填充，domain/io-schema/index.ts:14-41，调用点 engine/execution-service.ts:1211）+ run.service file 输入解析（run.service.ts:249-261）+ web IoSchemaField 渲染 playground 表单；chat/embeddings/stt 资源一律空 io_schema，`resource_version.io_schema` 列刻意 untyped（chat 存合成 `__ir` 输出字段，catalog.ts:55-58）。
11. **模型级弹性字段已超出 spec 最小集**：fallback_models 降级链（chat/stream 均实现，chat-relay.service.ts:118-180，每次降级换幂等键）、per-(channel,model) 熔断器（channel-breaker.ts，替代旧 channel_health）、模型级 RPM。
