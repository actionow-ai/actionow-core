# actionow-core 现状调研 · 路由引擎 / 限流配额 / 计量计费 / 错误与透传

> Research subagent 事实发现（findings only）。对照 /tmp/omni-spec.txt §2.3/§3.7/§3.8/§4.5/§4.6/§4.7。所有引用为 file:line（读取当日 HEAD=0af6b941）。

## 路由与容错现状

### 候选生成与过滤（谁能被路由到）

- 候选来源是 **key 绑定的 route_group**：`candidatesFor(resourceId, routeGroupId, …)`，key 未绑组 → 落到 well-known `default` 组（`apps/api/src/common/channel-routing.service.ts:121-179`，默认组解析缓存 `:306-328`）。
- 组成员渠道经 `listCandidateChannelsWithFallback` 载入，**携带 per-(group,channel) 的 priority/weight**，并沿组的 `fallback_group_id` 链把兜底组渠道降到更低 tier（循环+深度防护）（`channel-routing.service.ts:132-139`）。组对该资源无成员 → **ungrouped 兼容回退**：`listChannels` 全部 active 渠道、单一 tier priority 0（`:141-147`）。
- **channel_model link（目录三层）**：`preferLinkedChannels` 把未链接到该模型的渠道 priority 减 `UNLINKED_PRIORITY_OFFSET = 1_000_000`（降级非剔除；模型无 link 或候选中无 link 渠道则整体 no-op）（`channel-routing.service.ts:54,217-232`）。
- 过滤条件实际存在的：① active + 非软删（db 查询层）；② **熔断**：`BreakerStore.filterAvailable` 剔除 Open、HalfOpen 走 trial gate，fail-open（`packages/engine/src/channel-routing.ts:63-71`）；③ **route tag 染色**：`X-Actionow-Route-Tag` 只窄化候选、零匹配抛 400 `invalid_input`，绝不放宽（`channel-routing.service.ts:341-349`）；④ **require_params 参数门**（默认关，组级开关）：剔除会 drop 请求参数的渠道，全灭 → 404（`:188-207`）。
- **不存在的过滤维度**：健康度评分、region/合规域（tenant 合规域概念不存在）、成本、延迟。

### 排序与随机性

- 排序 = **priority tier 降序**（高 tier 先试完再进下一 tier），tier 内 = **加权随机选一个打头 + 其余按 weight 降序**（`packages/adapters/src/routing.ts:73-107`）。加权选择是 rng()×总权重的累积带（`:29-56`）。**无成本/延迟/p95 排序**（spec 4.5 的 `sort(weight desc, cost asc, p95 asc)` 只实现了 weight 维）。

### 渠道「钉选」与 key 池

- 钉选机制两个：**X-Actionow-Route-Tag 请求头**（`apps/api/src/common/route-tag.ts:7`）与 **key↔route_group 绑定**；servedBy 回显在响应头 `x-actionow-channel`（值为 providerType，见下）。
- **异步 job 不被钉选**：worker 重载上下文用 `listChannels(db, job.resourceId)` 取**全部** active 渠道，route group / route tag 的窄化不进 job 快照（`apps/worker/src/loaders.ts:43`）；产品文档同口径（`docs/actionow-skill-guide.html:356`「异步 job 暂不钉选」）。API 内媒体方言的同步端点（images/speech）例外——它在进程内用窄化后的 RunRequest.channels 驱动 JobRunner（`apps/api/src/media-dialect/media-dialect.service.ts:158-196`）。
- **一个渠道一把 key，无 KeyPool**：`upstream_channel.credential_ref` 单列（`packages/db/src/schema/catalog.ts:78`）；spec 4.5 的 `KeyPool(endpoint).pick()` 轮转/429 冷却不存在——多 key 只能建多渠道行靠 weight 分流。插件渠道的 credentialRef 可解析为 JSON 多字段（{ak,sk}），但仍是一份凭证（`packages/engine/src/job-runner.ts:558-582`）。

### 容错：重试 / 超时 / 熔断 / failover / 降级链

- **同渠道重试**（fault_policy 表绑 `upstream_channel.fault_policy_id`，`catalog.ts:112`）：`fastFail`、`retryCount`、`backoffType fixed|exponential`、`backoffMs`（单次退避 cap 60s，`packages/engine/src/fault-policy.ts:157`）；触发器 `retryCodes`（HTTP→unified 映射比对）/`retryMessages`（子串），未配置则用 adapter 的 retryable 判定（`fault-policy.ts:129-149,177-197`）。**无抖动 (jitter)**；无 policy = 单次尝试。
- **4 种超时**（名字与映射）：`connectTimeoutMs`→连接、`ttftTimeoutMs`→`firstChunkTimeoutMs`（流式首帧）、`totalTimeoutMs`→`timeoutMs`、`idleTimeoutMs`→流式帧间空闲（`fault-policy.ts:20-24,62-105`；TTFT 预算含 header 等待共用一个窗，`packages/infra/src/http.ts:252-257`）。**默认值 = 无（client 默认）**，全部 nullable、按渠道配置。
- **熔断**（弹性2.0，per `(channel, model)`）：默认 window 60s、minVolume 20、failureRate 50%、halfOpenTrial 3、halfOpenSuccesses 2、cooldown 5s 起按 trip_count 指数、cap 300s（`packages/engine/src/breaker.ts:34-43,74-76`）。窗口 = Redis 双桶 fixed-window 滑窗近似 + PG FSM 行（`packages/infra/src/breaker-redis.ts:11-27`）；**只有 retryable 失败计入窗口**（非 retryable = 调用方问题不计，`channel-routing.ts:80-85,110-115`——与 spec「4xx 不计」同向）；整体 fail-open，「只优化路由，绝不因熔断故障拒绝请求」（`breaker.ts:183-187`）。
- **跨渠道 failover**：`routeWithFailover` 逐个尝试，retryable 错误进下一渠道；**原始 transport throw（ECONNRESET/DNS/Abort）一律视为可 failover**（`channel-routing.ts:20-24`）。异步 job 路径同 verdict（`job-runner.ts:253-291`），但 job 路径的 WeightedChannel 映射**不带 priority**（tier 失效，`job-runner.ts:254-258`），且 **JobRunner 完全不消费 channel.faultPolicy**——loaders 挂上了（`loaders.ts:50-54,86`）而 runner 无任何 `runWithFaultPolicy`/`wrapHttpWithTimeouts` 引用（grep 无命中），同渠道重试/超时对 worker 异步 job 实际不生效。
- **流式已发帧重试禁令：存在**。Phase1 `openChatStreamCommit` 预提交拉首帧期间才允许跨渠道 failover；提交后（首帧已在手）mid-stream 错误只走带内 error frame + failJob 释放 hold，绝不整流重试（`packages/engine/src/stream.ts:169-330,451-460`）。
- **降级链（模型级）**：`model.fallback_models` jsonb（`packages/db/src/schema/model.ts:87`），**纯服务端配置，调用方不可传**（spec 3.8/4.5 的请求级 `gw.fallback_models` 不存在）。relay 在 `chatStream/chat` 外层 walk `[model, ...fallbacks]`；触发码 `DEGRADE_CODES = upstream_error | upstream_timeout | rate_limited | job_failed`（`apps/api/src/chat/chat-relay.service.ts:80-90,130-195`）；每跳独立 idempotency key `:fbN`；流式仅 pre-commit 失败才降级；响应回显 servedModel。
- **健康探测**：纯被动（真实流量喂熔断窗）。无任何定时主动探测；仅 admin 手动动作：模型接入预测试 `POST /admin/models/test` 与代理探测 `probeProxy`（`apps/api/src/admin/admin.controller.ts:1907-1911`）。

## 限流与计费现状

### 限流（对照 spec 4.6 四层）

- 实现原语：**Redis Lua 固定窗口计数器**（INCR + PEXPIRE，60s 窗；非令牌桶、非滑窗、无本地预取缓冲）（`packages/infra/src/rate-limit.ts:1-2,45-52,78-99`）；并发 = Redis INCR/DECR 信号量 + 120s safety TTL（`:125-164`）。
- **Legacy RPM 三桶**（`apps/api/src/auth/governance.guard.ts:97-122`）：① 租户 `rl:tenant:{tenantId}`，默认 **600/min**；② 资源/key `rl:resource:{tenant}:{resource}`，api_key.rate_limit 覆盖，默认 **120/min**（`packages/infra/src/config.ts:46-47`，动态配置可调 `settings.ts:56-64`）；③ 模型 `rl:model:{tenant}:{model}`（model.rate_limit 可选，30s 缓存）。**注意③是 per-tenant×model，不是 spec L2 的全局模型总闸**。
- **governance 套餐（limit_plan/limit_rule）5 维**：`spend | requests | tokens | rpm | concurrency`（`packages/db/src/schema/limit.ts:58-76`），key 计划(按 key 计) ∪ tenant 计划 ∪ subject 计划，`GovernanceGuard` 在 ApiKeyGuard 之后、模型可按 modelScope 过滤（`governance.guard.ts:66-93,203-241`，规则缓存 15s）。周期：calendar/total 走 `limit_usage` 物化计数，rolling_24h/30d 聚合 usage_log（`:144-176`）。
- 判定语义：rpm/concurrency 超限 → 429 `rate_limited`（retry_after_ms 在 body）；requests/tokens/spend 超限 → 402（`engineLimitExceeded`，guard 头注释 `:48-50`）。spend/tokens 是 **pre-check 期间累计值 + settle 后累计**——check-then-act，存在末笔超卖窗口（`:173-176` 注释自认）。
- **无 TPM**（每分钟 token）；tokens 维度是期间累计配额。**无 L3 上游 key 镜像限额**（渠道无 RPM/TPM/并发列）。**无 L4 任务并发闸门**：worker/JobRunner 无 model×channel 并发上限、无有界等待队列（`apps/worker/src/start.ts` 全文无 concurrency 配置；BullMQ 默认并发）。

### 计费采集（对照 spec 4.7 UsageEvent）

- 记账单位：**整数 µUSD bigint，1 credit = $1**；模型价 = µUSD/1M tokens；单一取整规则 roundHalfUp（`packages/domain/src/credits.ts:1-27,46-50`）。
- 「计费事件」实际是三层：**ledger settle（真相源）+ job 行（usage/costCredits/pricebookVersion/modifiersApplied 快照）+ usage_log 镜像（best-effort，失败吞掉）**（`packages/engine/src/execution-service.ts:1368-1416,1425-1460`）。
- usage_log 列：model、input/output_tokens + breakdown（reasoning/cached_input/cache_creation/audio_in/audio_out）、cost、**provider_cost**（渠道成本价×用量，毛利=cost−provider_cost）、latency_ms、status(succeeded|failed|canceled)、channel_id、provider_type、api_key_id、subject_id、route_tag（`packages/db/src/schema/usage.ts` 全文）。**无 images/秒/字符等模态单位列**——媒体用量存 job.usage jsonb（UsageVector 任意维度），媒体 usage_log 行只有 cost/provider_cost（`job-runner.ts:440-456`）。**latency_ms 列存在但 chat 镜像路径不填**（`mirrorUsageLog`/`mirrorChatUsageLog` 均未传）。
- **无 `estimated` 标志**：全仓 schema/contracts 无该列（grep 无命中）。**无价格快照字段**：usage_log 不记单价/版本；job 记 `pricebookVersion`，但 chat 的 model_token pricebook 是每请求内存构建（version 恒 1，含 groupRatioBps），价格来自 resolved model 行（`apps/api/src/chat/chat-relay.service.ts:372-396`）。
- **hold 预扣**：流式 = `estimateStreamUsage`：input = ceil(promptJSONBytes/4)×2、output = `maxOutputTokens ?? 32_768`（32k 预扣现状，`chat-relay.service.ts:60-72,411-416`）；blocking chat = `holdFloor 0`（零预扣、settle 收实额，`:354-358`）；媒体 post 计价 hold 有 `minimumHold` 地板。hold TTL 默认 15min，reaper 扫过期 hold → failJob('canceled') 释放（`execution-service.ts:347`；`packages/engine/src/reaper.ts:23-56`）。
- **settle usage 来源**：同步 = IR response.usage（adapter 从上游 body 取）；流式 = usage 帧末帧（camelCase→snake_case 边界映射，`stream.ts:436-444`）。**断流补账存在**：无 usage 帧结束（客户端提前断开/上游中断前无末帧）→ `measuredUsage()`：input=ceil(promptJSON/4)、output=ceil(实际转发字符/4)（`stream.ts:387-399,414`）；客户端断开由 `pipeSse` 的 `res.on('close') → iterator.return()` 触发 finally settle（`apps/api/src/chat/sse.ts:29-35`）。
- settle 封顶策略：`settledCost` = 有 usage 收计算值、无 usage 收全额 hold（防漏账）；**cap 至 hold（仅 hold>0 时）**、floor 0（`packages/engine/src/pricing.ts:78-91`）。
- **失败任务不计费**：failJob 释放 hold；relay 路径镜像一条 `status='failed', cost 0` 的 usage_log（`execution-service.ts:1462-1499`）。spec 的「上游明确已扣费部分按 Provider 声明打标计费」机制不存在。
- **对账机制：无**。全仓无与上游账单比对/偏差告警的任何代码（grep 对账/reconcil 仅命中 ops 视图文件名级噪音）；仅 provider_cost 逐行记录可供毛利分析。

## 错误与透传现状

### 统一错误规范（对照 spec 3.7）

- 对外错误体：`{error: {code, message, upstream?{provider, rawCode}, retryable, retry_after_ms?}}`（`apps/api/src/common/unified-error.filter.ts:11-19`）。code 枚举 **11 个**：invalid_input / insufficient_credits / resource_not_found / rate_limited / upstream_error / upstream_timeout / content_filtered / job_failed / unauthorized / forbidden / internal_error（`packages/contracts/src/adapter.ts:11-24`）。
- 与 spec 3.7 差异（事实）：**无 `type` 分类字段、无 `failover` 标志**（failover 判定是内部由 retryable 派生：`isFailoverRetryable`，`channel-routing.ts:20-24`）、无 `param`、无 `request_id`；缺专码 conflict/payload_too_large/quota_exceeded（402/429 复用现有码）/model_unavailable/upstream_task_lost/invalid_media/unsupported_parameter。HTTP 映射表在 `unified-error.filter.ts:38-62`。**429 无 `Retry-After` HTTP 头**（retry_after_ms 仅在 body；grep 无 setHeader('Retry-After')）。
- 上游原始错误保留：信封内仅 `upstream.{provider, rawCode}`；**完整原始 body 在 relay_trace.response_body**（须 RELAY_TRACE=full）。HTTP status→unified 映射：400→invalid_input、401/403→unauthorized、404→resource_not_found、408→upstream_timeout(retryable)、429→rate_limited(retryable)、5xx→upstream_error(retryable)（`packages/adapters/src/errors.ts:19-69`）。
- **「HTTP 200 带业务错误」翻译**：无通用声明式框架；per-adapter 实现——async-media 按 body `status:'failed'` + `error_message` 翻成 job_failed（`packages/adapters/src/async-media.ts:311-317,368-371`），插件走 tagged-union result。
- **流式 error frame**（post-commit 带内）：OpenAI 方言 = `data: {"error":{message,type,param:null,code}}` 且**不发 [DONE]**（`packages/llm-protocol/src/openai/stream.ts:98-111`）；Anthropic 方言 = 原生 `event: error` + `{type:'error',error:{type,message}}`（`anthropic/stream.ts:154-158`）;Gemini 方言 = 仅一个 `finishReason:'OTHER'` 的 candidate chunk，**无错误详情**（`gemini/stream.ts:71-73`）。pre-commit 错误因先拉首帧而成为真 HTTP 错误（`stream.ts:195-208`）。

### 透传门面（对照 spec 3.8 / 2.3）

- **不存在透传，全部是翻译路径**：`/v1/messages`（Anthropic）与 `/v1beta/models/:model:generateContent`（Gemini）都是「parse 方言 → IR → 引擎路由 → render 回方言」（`apps/api/src/chat/anthropic.controller.ts:35-71`、`gemini.controller.ts:37-79`）。**入口方言=上游方言时无跳过翻译的快速通道**；好处是这两个门面天然获得跨厂商 failover（spec 3.8.3 所谓「入口翻译器」模式实际是唯一模式）。
- **usage 旁路解析：无**（不需要——usage 都在 IR 内取）。**AK/SK 验签-重签：无**入站验签；出站方向存在**签名插件**（hmac-sha256/sigv4 家族 `SignerStrategy`，凭证只在沙箱外平台层注入）（`packages/engine/src/signers.ts:1-38`）。网关侧鉴权只有 Bearer `ak_` key / console JWT。
- **控制头清单**：请求 `X-Actionow-Route-Tag`（染色，`apps/api/src/common/route-tag.ts:7`）、`Idempotency-Key`（幂等）；响应 `x-actionow-channel` = servedBy.providerType（openai/anthropic/gemini controllers，如 `anthropic.controller.ts:67`）。servedModel 回显在 body 的 `model` 字段而非头。spec 的 X-GW-Artifact-Mode/X-GW-Artifacts-Rewritten 类头不存在（媒体产物有 require_persist 布尔，语义不同，`execution-service.ts:152-159`）。
- 错误信封对所有方言统一为 §4.7 envelope（全局 `UnifiedErrorFilter`）——**Anthropic/Gemini SDK 收到的非流式错误体不是各家官方错误 shape**（流式错误帧则按方言渲染，见上）。

### 可观测

- **relay_trace**（`packages/db/src/schema/relay-trace.ts:32-76`）：每次上游调用一行——method、url（秘密 query 值 redacted）、request_headers（凭证头 redacted）、request/response body（cap 默认 1MB，`RELAY_TRACE_MAX_BYTES`）、response_status、is_stream（流式存拼装后的原始 SSE 字节）、latency_ms、error、truncated、tenant/job/channel/provider/route_tag/subject 关联（松散 uuid 无 FK）。开关 `RELAY_TRACE=full`（动态配置可切，`chat-relay.service.ts:199-201`）。
- **保留**：`RELAY_TRACE_RETENTION_DAYS`（env/动态配置）设定才清理，未设 = 永不清（`apps/worker/src/processors/relay-trace-reaper.processor.ts:15-26`）；worker 每小时 repeatable sweep（`apps/worker/src/start.ts:23`）。
- **TTFT**：只有超时（ttftTimeoutMs→firstChunkTimeoutMs），**无 TTFT 指标记录**（relay_trace.latency_ms 是整段耗时；usage_log.latency_ms chat 路径不填）。**无 W3C traceparent**；任务多段（submit/每次 poll/callback）各写 relay_trace 行、靠 job_id 串联（`job-runner.ts:515-528`）。

## 与 spec 4.5 / 4.6 / 4.7 / 3.7 / 3.8 的逐项对照表

| spec 条目                                                   | 有/部分/无                                                                                                                                | 证据                                                         |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 4.5 candidates = Registry.endpoints(model)                  | 部分（resource 渠道 + route_group 成员 + channel_model link 降级，无独立端点注册表）                                                      | channel-routing.service.ts:121-179,217-232                   |
| 4.5 filter: 熔断闭合                                        | 有                                                                                                                                        | engine/channel-routing.ts:63-71; breaker.ts:295-340          |
| 4.5 filter: 健康度 / 合规域(tenant) / region                | 无                                                                                                                                        | 全仓无 region/compliance 过滤代码                            |
| 4.5 filter: 能力满足(params)                                | 部分（require_params 组级开关，默认关）                                                                                                   | channel-routing.service.ts:188-207                           |
| 4.5 sort: weight desc                                       | 有（tier 内加权随机+weight 降序）                                                                                                         | adapters/routing.ts:73-107                                   |
| 4.5 sort: cost asc, p95_latency asc                         | 无                                                                                                                                        | routing.ts 仅 priority/weight                                |
| 4.5 KeyPool 轮转 + 429/401 key 冷却                         | 无（单渠道单 key；熔断冷却的是渠道×模型）                                                                                                 | db/schema/catalog.ts:78                                      |
| 4.5 同端点重试 ≤2 次指数退避+抖动                           | 部分（retryCount 可配无上限约束、退避 cap 60s、无抖动；默认 0 次）                                                                        | fault-policy.ts:157,177-197                                  |
| 4.5 流式已发帧禁止整流重试                                  | 有                                                                                                                                        | stream.ts:169-208,451-460                                    |
| 4.5 failover=true 触发换端点；同厂商优先再跨厂商            | 部分（retryable 即 failover；tier 排序表达优先级，无「同厂商优先」显式规则；跨厂商在统一门面天然可用）                                    | channel-routing.ts:87-119; execution-service.ts:608-653      |
| 4.5 降级链 gw.fallback_models（请求级）                     | 部分（模型目录级 fallback_models，服务端配置；回显实际模型有）                                                                            | db/schema/model.ts:87; chat-relay.service.ts:130-195         |
| 4.5 熔断 30s 窗/错误率>50%/样本≥20/open 30s/half-open       | 部分（60s 窗/50%/20/cooldown 5s→300s 指数/half-open trial 3+2；参数可按 fault_policy 覆盖）                                               | breaker.ts:34-43                                             |
| 4.5 4xx 不计入熔断窗                                        | 有（非 retryable 不记）                                                                                                                   | channel-routing.ts:110-115                                   |
| 4.5 被动健康为主 + 可选主动探测                             | 部分（纯被动；主动仅 admin 手动 test/probe）                                                                                              | admin.controller.ts:1907,2162                                |
| 4.6 L1 租户/key 令牌桶 RPM+TPM                              | 部分（固定窗 RPM 有：租户 600、key 120 默认；TPM 无；月度配额走 limit_plan spend/tokens/requests → 402）                                  | governance.guard.ts:97-122; config.ts:46-47; limit.ts:58-76  |
| 4.6 L2 模型全局总闸                                         | 部分（per-tenant×model RPM，非全局）                                                                                                      | governance.guard.ts:115-121                                  |
| 4.6 L3 上游 key 限额镜像 + 触顶换 key                       | 无                                                                                                                                        | 渠道无限额列（catalog.ts:67-137）                            |
| 4.6 L4 任务并发闸门（模型×Key 并发+有界队列）               | 无（governance concurrency 是 key/tenant/subject 级；worker 无 model×channel 闸）                                                         | rate-limit.ts:107-164; worker/start.ts                       |
| 4.6 集中式令牌桶 Redis 原子脚本                             | 部分（Redis Lua 原子，但固定窗计数非令牌桶；无本地预取）                                                                                  | rate-limit.ts:45-68                                          |
| 4.7 UsageEvent 单位含 images/video_seconds/tts_characters/… | 部分（token 族 + breakdown 列全；媒体单位在 job.usage jsonb，不在 usage_log 列）                                                          | db/schema/usage.ts; job-runner.ts:440-456                    |
| 4.7 estimated 标志                                          | 无                                                                                                                                        | 全仓无 estimated 列                                          |
| 4.7 price_snapshot（单价/币种/版本）                        | 部分（job.pricebookVersion + modifiersApplied；usage_log 无单价快照）                                                                     | execution-service.ts:1386-1401                               |
| 4.7 同步缺 usage → tokenizer 估算                           | 部分（同步直接取 usage；估算仅流式 measuredUsage，无 tokenizer，字节/4 启发式）                                                           | stream.ts:387-399                                            |
| 4.7 断流按已转发内容估算补账                                | 有                                                                                                                                        | stream.ts:387-399,414; sse.ts:29-35                          |
| 4.7 失败任务默认不计费；上游已扣费打标                      | 部分（不计费有；已扣费打标无）                                                                                                            | execution-service.ts:1462-1499                               |
| 4.7 Realtime 心跳计量                                       | 无（无 realtime 范式）                                                                                                                    | —                                                            |
| 4.7 透传旁路解析产出同一事件模型                            | 无（无透传门面）                                                                                                                          | —                                                            |
| 4.7 与上游账单日对账、偏差>2% 告警                          | 无                                                                                                                                        | grep 无命中                                                  |
| 4.7 计费事件先落盘 append-only 可重放                       | 有（ledger settle 事务 + append-only usage_log/audit 触发器护栏）                                                                         | execution-service.ts:1386-1407; schema-hardening（mig 0052） |
| 3.7 统一错误体 + provider 字段                              | 部分（envelope 有；provider→upstream.{provider,rawCode}，无完整原始 message/status 字段在信封内）                                         | unified-error.filter.ts:11-19                                |
| 3.7 code 枚举 17 个                                         | 部分（11 个；缺 conflict/payload_too_large/quota_exceeded/model_unavailable/upstream_task_lost/invalid_media/unsupported_parameter 专码） | contracts/adapter.ts:11-24                                   |
| 3.7 retryable + failover 双标志                             | 部分（retryable 有且驱动内部 failover；对外 failover 字段无）                                                                             | contracts/adapter.ts:26-32                                   |
| 3.7 429 带 Retry-After 头                                   | 部分（body retry_after_ms 有；HTTP 头无）                                                                                                 | unified-error.filter.ts:64-73                                |
| 3.8 官方原生透传（body 原样+治理注入）                      | 无（Anthropic/Gemini 门面 = 翻译到 IR 的「入口翻译器」模式，享全部路由/降级）                                                             | anthropic.controller.ts:35-71; gemini.controller.ts:37-79    |
| 3.8 透传快速通道（入口=上游方言跳过翻译）                   | 无                                                                                                                                        | 同上                                                         |
| 3.8.2 AK/SK 验签-重签                                       | 无入站验签；出站签名插件有（hmac/sigv4 族）                                                                                               | engine/signers.ts:1-38                                       |
| 3.8 X-GW-\* 行为控制头                                      | 部分等价（X-Actionow-Route-Tag / Idempotency-Key / 响应 x-actionow-channel；无产物模式头）                                                | route-tag.ts:7; anthropic.controller.ts:67                   |
| 3.8 错误：上游错误体原样返回（透传）                        | 无（一律统一信封；流式错误帧按方言渲染）                                                                                                  | unified-error.filter.ts:85-101                               |
| 2.3 范式=骨/方言=皮（IR 四范式）                            | 部分（IR + blocking/stream/async-poll/async-callback 四 exec mode；无 realtime）                                                          | contracts/adapter.ts:6-7                                     |

## 值得注意的事实

1. **worker 异步 job 的容错策略是「挂而不用」**：`loadJobContext` 给渠道挂 faultPolicy 并注释声称与同步路径一致（`apps/worker/src/loaders.ts:50-54`），但 `JobRunner` 全文无 `runWithFaultPolicy`/`wrapHttpWithTimeouts` 引用——异步 submit/poll 实际无同渠道重试与 per-attempt 超时；且其 failover 映射不带 priority（tier 失效）、渠道集不受 route group/tag 约束。
2. **blocking chat 是零 hold**（`holdFloor: 0`，`chat-relay.service.ts:354-358`）——余额不足也能发起阻塞 chat、settle 时才扣（settledCost 对 hold=0 不 cap，`pricing.ts:85-90`）；流式则用 32k 输出上限的 generous hold，settle 全额退差。
3. **计费防御方向是「宁可少收不超扣」**：settle cap at hold（hold>0）+ 无 usage 收全额 hold + 断流按转发字节估算——三条规则组合，见 `pricing.ts:61-91`、`stream.ts:387-399`。
4. **熔断/route-tag/组降级只覆盖同步+流式热路径**；异步 job 有 breaker 读写（`job-runner.ts:241-291`）但无组窄化。
5. 模型健康页数据源是 usage_log 成败计数（`admin.controller.ts:2162-2166` modelHealth），failBlocking 特意镜像 failed 行以供其统计（`execution-service.ts:1481-1498`）。
6. **Gemini 流式错误帧信息量为零**（仅 finishReason:'OTHER'，无 message/code），与 OpenAI/Anthropic 方言的显式 error 帧不对称（`gemini/stream.ts:71-73`）。
7. relay_trace 未设 `RELAY_TRACE_RETENTION_DAYS` 时**默认永久保留**（reaper 返回 0，`relay-trace-reaper.processor.ts:22`）；表注明「unbounded append-only」。
8. spec 4.5 的「同厂商优先再跨厂商」在代码里没有显式规则——failover 顺序完全由 priority tier + weight 决定，providerType 不参与排序（`routing.ts:73-107`）。
