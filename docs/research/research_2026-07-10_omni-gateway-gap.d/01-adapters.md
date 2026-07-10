# Research 01 · actionow-core 适配器与协议层现状（对照 omni-spec 第 4.1 / 5 章）

> 只报事实。所有结论带 file:line。仓库 = /Users/alienworm/actionow-core（下文省略前缀）。
> spec = /tmp/omni-spec.txt（4.1 IR：636-674 行；第 5 章 SPI：825-989 行）。

## 现状地图

### 1. 适配器接口：单体接口，非五切面

- `ProviderAdapter` 是一个**单体接口**（packages/adapters/src/types.ts:39-87）：`providerType` + 可选 `capabilities` + 一组按业务能力划分的可选方法：`submit`（统一 inputs 同步/异步提交）、`poll?`、`stream?`（文本流）、`chat?`/`streamChat?`（IR 级聊天）、`embed?`/`rerank?`/`moderate?`/`transcribe?`、`parseCallback?`、`listModels?`（模型发现）+ 必选 `extractUsage`/`mapError`。
- spec 5.1 的五切面（Transport/CredentialInjector/RequestMapper/ResponseNormalizer/TaskLifecycle）在这里的对应物是**接口内的方法分组 + 注入的 HttpClient**，而不是可独立实现/复用的接口：
  - Transport ≈ 注入的 `ctx.http`（contracts/src/adapter.ts:66，infra 实现见 §8）。
  - CredentialInjector ≈ 各 adapter 在构造请求时**手写 headers/query**（无独立切面，见 §3）。
  - RequestMapper ≈ 各 adapter 内的 `buildChatBody`/`buildParams` 私有函数。
  - ResponseNormalizer ≈ 各 adapter 内的 parse + `extractUsage` + `mapError`。
  - TaskLifecycle ≈ `submit`/`poll`/`parseCallback` 三个方法（调度不在 adapter，见 §9 之外的 job-runner）。
- 注册/查找：`AdapterRegistry` 就是 `Map<string, ProviderAdapter>`，**key = providerType 字符串**（packages/adapters/src/registry.ts:3-19）。内置注册 9 个：`openai`、`anthropic`、`gemini`、`codex-oauth`、`async-media`、`async-media-mock`、`dify-workflow`、`mock-stream`、`mock-chat`（default-registry.ts:29-41）；apps 层再补注册 `plugin`（engine/src/plugin-adapter.ts:124-127；apps/api/src/db/db.module.ts:42、apps/worker/src/runtime.ts:106）。
- 运行时查找按**渠道级 providerType 覆盖资源级**：`adapters.get(channel.providerType ?? req.resource.providerType)`（engine/src/execution-service.ts:629，embed/rerank/moderate/transcribe/submit 各路径同型：762/873/984/1100/1323）。即一个逻辑模型的多渠道可各自绑不同 adapter（跨 provider failover 的基础）。

### 2. 新接一个 Provider 的真实步骤

代码路径（内置 adapter）需要动 3 个文件：

1. 新建 `packages/adapters/src/<provider>.ts`，导出一个 `ProviderAdapter` 常量——自带默认 endpoint 常量、鉴权 header 拼装、IR→wire 映射、SSE 解析、usage 提取、错误映射（openai.ts 849 行 / anthropic.ts 591 行 / gemini.ts 512 行 / codex-oauth.ts 690 行为证）；
2. `default-registry.ts` 里 `registry.register(...)`（default-registry.ts:31-39）；
3. `index.ts` 加导出（index.ts:1-14）。

配置驱动的接入路径（部分存在，两条，都不是 spec 5.3 的 YAML DSL）：

- **provider_plugin（QuickJS 插件）**：manifest（`protocol: sync|async-poll` + `authStrategy`(8 种签名策略枚举) + credential/params 表单字段，contracts/src/provider-plugin.ts:23-53）+ 一段 JS handler（`mapRequest`/`mapResponse`/`mapSubmit`/`mapPoll`），在 QuickJS-WASM 沙箱执行（engine/src/sandbox.ts:1-94、plugin-runner.ts:148-231），由通用 adapter（providerType='plugin'）解释（engine/src/plugin-adapter.ts:22,62-116）。**不发版可接入**，但 handler 是 JS 代码而非纯声明；且只覆盖媒体 sync/async-poll，**没有 chat/streamChat handler**（webhook-only/ws-stream 在 PLUGIN_PROTOCOLS 注释里标"保留"，provider-plugin.ts:22-25）。
- **async-media adapter 本身即半配置化**：submitPath/pollPath/签名头名从 `channel.config` 读（async-media.ts:237,282-283,38-42），一个 adapter 服务任意符合该任务信封（task_id/status/result）的中继上游。
- OpenAI 兼容上游共享 `openai` adapter，仅改 channel 的 endpoint/model（openai.ts:817-841 注释明说 "openai-COMPATIBLE relay"）。

### 3. 鉴权注入

- 注入位置 = **各 adapter 请求构造处硬编码**：
  - OpenAI：`Authorization: Bearer`（openai.ts:397,438,486 等全部 8 处）。
  - Anthropic：`x-api-key` + `anthropic-version: 2023-06-01`（anthropic.ts:273-276,27）。
  - Gemini：**query 参数** `?key=`（gemini.ts:273-277,304-308,480-483）。
  - codex-oauth：`Bearer <OAuth access token>` + 5 个 CLI 伪装头（User-Agent=codex_cli_rs/0.125.0、Originator、OpenAI-Beta、version、Chatgpt-Account-Id 来自 ctx.config）（codex-oauth.ts:486-537）。
  - async-media / dify-workflow：Bearer（async-media.ts:262；dify-workflow.ts:35）。
- **AK/SK 签名只存在于 plugin 路径**：签名策略注册表 `SIGNER_STRATEGIES = bearer/query-key/custom-header/token/volcSignV4/tencentTC3/klingJwt/none`（contracts/src/provider-plugin.ts:9-19；实现 engine/src/signers.ts:41-200+，含火山 SignerV4 规范化、腾讯 TC3、可灵 HS256 JWT）。签名在 mapRequest（沙箱）之后、http 发送之前，于平台层执行，**秘密不进沙箱**（plugin-runner.ts:56-57,89-97；signers.ts 顶注 "OUTSIDE the handler sandbox, after mapRequest ... body-dependent signing works"）。内置六个 adapter 用不到该注册表。
- 凭证解析链：channel.credentialRef →（engine）`resolveSecret` → `ctx.apiKey`（execution-service.ts:1502-1529）；plugin 通道解析成 `ctx.credentials` map，仅供 signer（contracts/adapter.ts:53-57）。
- OAuth 刷新：engine/src/oauth/codex.ts（PKCE 生成、authorize URL、code 交换、`refreshCodexToken` 区分 terminal/transient 失败，提前量 `CODEX_REFRESH_LEAD_MS`=5min，codex.ts:16,106-178）；worker 定时处理器扫描到期会话主动刷（apps/worker/src/processors/token-refresh.processor.ts:9,31,54）。**adapter 只消费 ctx.apiKey，不感知刷新**。
- 「注入后禁止改写」（spec 5.2 硬约束）：**内置 adapter 无此流水线概念**——headers 拼好后交给 `ctx.http`，中间只有 wrapHttpWithTimeouts + TracingHttpClient 包装（execution-service.ts:1516-1525），不改写请求但也无冻结机制/成文顺序约束。plugin 路径**有**结构化顺序：mapRequest→signer→http（plugin-runner.ts:148-150 注释），且 volcSignV4 对最终 body 哈希计算（signers.ts:97-99 "signature is body-dependent and a poll call MUST be re-signed"）。

### 4. 请求映射与 IR

- **IR 枢纽 = `ChatRequest`**（contracts/src/chat.ts:101-125，zod）：`model` + `messages[]`（ContentPart 四种 kind：text/image/audio/file，source=url|base64|file_id，chat.ts:12-38）+ `tools/toolChoice` + `params`（ChatParams：temperature/topP/maxOutputTokens/stop/seed/responseFormat/jsonSchema/reasoningEffort/reasoningBudgetTokens，chat.ts:75-98）+ `metadata` + **`extra` 开放透传袋**（未识别的上游 body 键，adapter 先 spread 再覆盖第一类字段，chat.ts:108-124）。响应侧 IR = `ChatResponse`（含 nativeFinishReason 原样保留，chat.ts:220-234）+ `ChatStreamEvent` 七种事件（chat.ts:240-253）。usage 双形态：snake_case `UsageVector`（adapter 产出）⇄ camelCase `ChatUsage`（IR，5 项 breakdown 单源映射 USAGE_BREAKDOWN_KEYS，chat.ts:167-218）。
- 对照 spec 4.1 `GatewayRequest`：**无** facade/paradigm/operation/media[]/options(fallback_models 等)/raw 字段。范式的等价物是 `EXEC_MODES = blocking|stream|async-poll|async-callback`（contracts/adapter.ts:6-7），由资源/端点决定而非统一判定器；降级链在 relay 层 `chain = [model, ...fallback_models]`（apps/api/src/chat/chat-relay.service.ts:137,176）；媒体输入不走 MediaRef——chat 图片内嵌 ContentPart，媒体任务的 file 输入在 run 路径先解析为预签名 URL（async-media.ts:78-87 注释）。
- 非 chat 面各有独立小 IR：EmbeddingsRequest/RerankRequest/ModerationRequest/TranscriptionInput（chat.ts:263-503）。
- `normalize.ts`（llm-protocol/src/normalize.ts:56-88）：**能力 gate**（tools/json/vision/audio/file 不支持 → 400 `ProtocolError('invalid_input')`）+ **reasoning 降级**（丢 temperature/topP/stop 及 extra 里的惩罚/logprobs 键；profile 声明 reasoning 时按 profile allow-list 推导 drop-set，normalize.ts:169-194）。
- 参数流水线（模型参数绑定两级契约）真实次序：
  1. relay 层：①`applyProfileDefaults`+`clampToRules`（模型 param_profile 非空时）→ ③`normalizeRequest` gate（apps/api/src/chat/chat-relay.service.ts:244-249）；
  2. 路由选渠道后每次尝试：②`applyChannelOverride`（渠道级 set/clamp/delete，set=硬 force，engine/src/param/apply-override.ts:14-19,127-162；调用点 execution-service.ts:644-646）；
  3. adapter 内 `buildChatBody` 末尾：④`dropUnsupportedBody(body, ctx.paramProfile)`（openai.ts:186-190；ctx 注入见 execution-service.ts:1533-1537）。
- **值域缩放（spec 5.3 `scale: "[0,2]->[0,1]"`）不存在**——只有 min/max clamp（apply-profile.ts:121-155），无线性重映射。字段翻译逐 adapter 硬编码（`maxOutputTokens`→OpenAI `max_tokens`/Anthropic `max_tokens`/Gemini `generationConfig.maxOutputTokens`；codex 明确**拒发** max_output_tokens，codex-oauth.ts:193-197）。

### 5. 流式归一

- 入站解析：`packages/adapters/src/internal/sse.ts`（106 行）——跨 chunk 分行缓冲、CRLF、多行 data 合并、`:` 心跳忽略、`[DONE]` 透传（sse.ts:1-17）。**无缓冲上限**（spec 5.1 要求 transcode 缓冲 ≤64KB，此处无约束）。
- IR 帧类型：`ChatStreamEvent` = message_start / content_delta / tool_call_delta(index+id/name/argumentsDelta) / usage / stop(stopReason+nativeFinishReason) / done / error（chat.ts:240-253）；旧文本流用 `StreamEvent`(delta/usage/done/error，contracts/adapter.ts:134-146，done 帧带引擎结算 jobId+cost)。
- usage 提取位置：OpenAI 尾帧（stream_options.include_usage，choices 为空的 chunk，openai.ts:462-467,800-806）；Anthropic message_start(input)+message_delta(累计 output 最后一次为准)（anthropic.ts:342-359,509-517）；Gemini 每 chunk usageMetadata 最新覆盖（gemini.ts:318-330）。
- 上游中断表达：流打开即非 ok → yield `{type:'error', error: httpStatusToUnified(...)}`（openai.ts:740-743 等）；codex `response.failed/error` 帧 → error 事件（codex-oauth.ts:468-477）；出站渲染时 error 帧 = OpenAI-wire `data:{"error":...}` 且**不发 [DONE]**（llm-protocol/src/openai/stream.ts:22-27,98-111）。传输层 stall：`StreamIdleTimeoutError`（默认 idle 120s + TTFT firstChunkTimeoutMs 单预算，retryable upstream_timeout，infra/src/http.ts:10-37,247-280）。
- 流结束防御：Anthropic/codex 无终止帧时补发 stop/usage/done（anthropic.ts:539-553；codex-oauth.ts:481-484）。

### 6. 错误映射

- 统一码表 = 11 个 `UNIFIED_ERROR_CODES`（contracts/src/adapter.ts:11-24）；`UnifiedError{code,message,upstream{provider,rawCode?},retryable,retryAfterMs?}`（adapter.ts:26-32）。
- 映射器 = **按 HTTP status 的单一函数** `httpStatusToUnified`（adapters/src/errors.ts:31-70）：400→invalid_input/false、401/403→unauthorized/false、404→resource_not_found/false、408→upstream_timeout/true、429→rate_limited/true、5xx→upstream_error/true。**retryable 内联于码表**，无独立 failover 标志——路由读 `AdapterError.unified.retryable`（adapters/src/routing.ts:147-149）；curl 传输失败类固定 retryable:true 以触发跨渠道 failover+熔断（infra/src/curl-http.ts:24-49）。
- 上游原始错误：仅保留 `upstream.rawCode`（error.code/type/status 字符串，openai.ts:370-374、anthropic.ts:244-249、gemini.ts:258-262）；**原始 body 不进 UnifiedError**（可选保存在 relay_trace，execution-service.ts:1545-1556）。**无 per-provider 错误码映射表**（spec 5.3 `code_map: {"1005": content_filtered}` 之类不存在）。

### 7. 能力校验

- `ModelCapabilities{tools,vision,audio,json,file?,reasoning?}`，从**模型行的 capabilities jsonb** 读（llm-protocol/src/capabilities.ts:1-29）。消费者 = chat relay（apps/api/src/chat/chat-relay.service.ts:237-249）。
- 语义混合：能力误用（tools/json/vision/audio/file）→ **报错 400**（= spec 4.2 strict）；reasoning 模型的采样参数 → **静默丢弃**（= lenient），但**无 warnings[] 回显**（normalize.ts:39-55）。
- adapter 自身的 `AdapterCapabilities` 声明**不被 dispatch gate 消费**（types.ts:24-30 注释原话 "not yet consulted by the dispatch-time gate ... Wiring these into capability-aware channel selection is a follow-up"）；adapter 的兜底是对无法表达的 content part 直接 REJECT（openai.ts:64-76、anthropic.ts:65-75；codex 例外——audio/file 退化为传 text，codex-oauth.ts:97）。

### 8. Transport

- 接口 `HttpClient{request, stream?}`（contracts/src/http.ts），生产实现 `FetchHttpClient`（undici fetch）：per-proxyURL 缓存 ProxyAgent、请求级 `proxyUrl` 接入（infra/src/http.ts:181-231）、默认总超时 30s（http.ts:10,207）；stream 无总超时、inter-chunk idle 120s、TTFT 与 header 等待共享单一 wall-clock 预算（http.ts:233-280）。
- `CurlHttpClient` = `HTTP_EGRESS=curl` 逃生舱（Node TLS 被阻断的沙箱/代管环境），子进程 curl、`-x` 代理、`--connect-timeout`、SSE 用 `-N -D -`；FormData 显式拒绝（infra/src/curl-http.ts:52-67,80-104,139-155,263-266）。
- 超时来源 = 渠道 faultPolicy 四超时，经 `wrapHttpWithTimeouts` 包装为 HttpRequest 的 timeoutMs/connectTimeoutMs/firstChunkTimeoutMs/idleTimeoutMs（execution-service.ts:1514-1525）。
- 代理解析：channel.proxyRef→resolveSecret→ctx.proxyUrl，回退全局 env UPSTREAM_PROXY_URL（execution-service.ts:1558-1565）；每个 adapter 手动 `withProxy(ctx)` spread 进每个请求（openai.ts:38-40 等，6 处重复样板）。
- 连接层与映射层**分离成立**（adapter 只造 HttpRequest），但凭证注入并未从映射层分离出来。

### 9. dify 路径：两个不同的东西

- `packages/dify` + `engine/src/dify-registration.ts` = **BYO Dify 工作流导入**，不是 Provider 接入通道：解析 Dify YAML DSL（kind:app、mode:workflow 校验，dify/src/parse.ts:15-40）→ 推导 io_schema + 兼容报告（block/warn，如知识检索节点）→ 事务持久化 resource+resource_version+dify_binding（dsl_hash 幂等版本化，dify-registration.ts:60-147）。运行时执行走 `difyWorkflowAdapter`（Bearer、POST {endpoint}/v1/workflows/run、response_mode:'blocking'、**user:'actionow' 硬编码**，dify-workflow.ts:29-63）。
- 真正的「插件化 Provider 接入」= §2 所述 provider_plugin（QuickJS 沙箱 + manifest + 平台侧签名注册表 + admin 测试端点 testPluginRequestSchema，contracts/provider-plugin.ts:103-124）。沙箱形态：quickjs-emscripten 每次全新 runtime/context、超时+OOM→SandboxError、返回值必须 JSON（sandbox.ts:44-94）；handler 收不到任何 secret（plugin-runner.ts:15-18）。

### 10. 一致性测试

- adapters 包 23 个测试文件（packages/adapters/test/）：逐 adapter 手写（openai-chat/anthropic-chat/gemini-chat/codex-oauth-adapter/async-media/dify-workflow/…）+ **少数横向文件**：`usage-breakdown.test.ts`、`provider-list-models.test.ts`、`native-finish-reason.test.ts`（各自把 openai/anthropic/gemini 三个 adapter 拉进同一文件断言同一行为）、`sse.test.ts`（分帧/分块容错）、`errors.test.ts`、`routing.test.ts`、`registry.test.ts`。
- llm-protocol 包 10 个（packages/llm-protocol/test/）：**`cross-dialect.test.ts`**（三方言矩阵：wire→IR→wire，证明语义在每跳存活，含 tool-call id 归一化）+ **`golden-sse.test.ts`**（同一 IR 事件序列在三方言的字节级 SSE 快照）+ per-dialect parse/render/stream。
- 对照 spec 5.6：**不存在**"每个适配器合入必须通过的对 mock 上游标准用例集"。缺项：签名逐字节样例向量（signers 有单测但非官方向量声明）、token 过期自动刷新测试属于 worker 而非 adapter 合约、任务状态映射全覆盖矩阵、轮询退避曲线（轮询本身就是固定间隔，engine/src/job-runner.ts:94-95,316-323：默认 1s 间隔 ×30 次上限，per-channel config 可调 maxPolls/pollIntervalMs，**无指数退避**）、三级超时行为矩阵。

## 与 spec 第 5 章 / 4.1 的逐项对照表

| spec 条目                                    | 有/部分/无                                                                                                                                                                                         | 证据                                                                                               |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 4.1 统一 IR（请求）                          | **部分** — ChatRequest 覆盖 messages/tools/params/extra，但无 facade/paradigm/operation/media[]/options/raw                                                                                        | contracts/chat.ts:101-125 vs spec 639-651                                                          |
| 4.1 StreamFrame 联合                         | **部分** — ChatStreamEvent 7 种 ≈ TextDelta/ToolCallDelta/UsageFrame/Done/ErrorFrame；无 AudioChunk                                                                                                | chat.ts:240-253                                                                                    |
| 4.1 TaskUpdate                               | **部分** — PollResult/CallbackResult{status,output,usage,error,mediaResult}；无 progress 百分比字段、raw 不落 task_events（有 relay_trace/job 表）                                                 | contracts/adapter.ts:109-120                                                                       |
| 4.1 CanonicalParams 统一值域基准             | **部分** — ChatParams 有统一语义（maxOutputTokens=输出上限、OpenAI messages 结构为基准），但值域不做跨家缩放                                                                                       | chat.ts:75-98；apply-profile.ts:121-155 只 clamp                                                   |
| 5.1 ① Transport 切面                         | **有（独立于 adapter）** — HttpClient 注入，fetch/curl 两实现，stream/request 双方法；无 openSocket/realtime                                                                                       | infra/http.ts:181-282、curl-http.ts:87-255                                                         |
| 5.1 ② CredentialInjector 切面                | **无（内置）/ 有（plugin）** — 内置 adapter 手写 header/query；plugin 路径有独立 signer 注册表（8 策略含 AK/SK 双家+JWT）                                                                          | openai.ts:397、gemini.ts:277、signers.ts、provider-plugin.ts:9-19                                  |
| 5.1 ③ RequestMapper 切面                     | **部分** — 每 adapter 私有 buildChatBody；plugin 的 mapRequest handler 是切面化的                                                                                                                  | openai.ts:122-191、plugin-runner.ts:148-166                                                        |
| 5.1 ④ ResponseNormalizer 切面                | **部分** — parse+extractUsage+mapError 存在但内联在各 adapter；transcode 即各 adapter 的 streamChat 生成器                                                                                         | anthropic.ts:432-554、types.ts:85-86                                                               |
| 5.1 ⑤ TaskLifecycle 切面                     | **部分** — submit/poll/parseCallback 在接口上；cancel **无**；verifyCallback 合并进 parseCallback（HMAC+时间窗在 adapter 内）                                                                      | types.ts:43-44,78、async-media.ts:326-376                                                          |
| 5.2 执行流水线固定顺序                       | **部分** — 实际顺序：profile 默认+clamp→gate→路由→渠道 override→adapter 映射→dropUnsupported→(内联凭证)→http；凭证注入不是"最后一步"，无注入后冻结                                                 | chat-relay.service.ts:244-249、execution-service.ts:644,1502-1539                                  |
| 5.2 注入后禁止改写                           | **无（内置）/ 结构化（plugin）** — plugin: mapRequest→signer→直接 http                                                                                                                             | plugin-runner.ts:56-97                                                                             |
| 5.3 声明式 DSL（YAML，80% 厂商）             | **无** — 最接近的是 provider_plugin（manifest 声明式 + JS handler 命令式）与 async-media 的 config 驱动路径                                                                                        | provider-plugin.ts:43-53、async-media.ts:237-283                                                   |
| 5.3 值域缩放 scale                           | **无** — 仅 clamp                                                                                                                                                                                  | apply-profile.ts:67-72,121-155                                                                     |
| 5.3 状态映射声明                             | **无** — async-media 状态词 completed/failed 硬编码                                                                                                                                                | async-media.ts:302-323                                                                             |
| 5.3 usage 提取声明（JSONPath）               | **无** — 每 adapter 硬编码 extractUsage                                                                                                                                                            | openai.ts:359-367 等                                                                               |
| 5.4 代码插件（AK/SK 签名/私有分帧/多步交互） | **部分** — AK/SK：volcSignV4/tencentTC3/klingJwt 已实现（仅 plugin 通道）；私有流式分帧：codex Responses SSE 内联实现；WS/Realtime：无；多步交互（先换 token）：codex OAuth 由 worker 旁路刷新实现 | signers.ts:96-200、codex-oauth.ts:370-484、token-refresh.processor.ts:31                           |
| 5.5 模型注册表（热更新/版本/灰度）           | **部分**（本报告维度外，但可见）— model 行带 capabilities jsonb + param_profile（mig 0064）+ channel_model 绑定；无 DSL ref/version 字段、无灰度                                                   | capabilities.ts:19-29、chat-relay.service.ts:232-249                                               |
| 5.6 一致性测试套件                           | **部分** — 三个横向 adapter 测试 + llm-protocol cross-dialect 矩阵 + golden SSE 快照；无强制 per-adapter 标准用例集/签名向量/退避曲线/三级超时矩阵                                                 | packages/adapters/test/\*、llm-protocol/test/cross-dialect.test.ts:16-23、golden-sse.test.ts:30-35 |
| 4.2 参数能力校验 strict/lenient              | **部分** — 能力误用固定 strict(400)；reasoning 参数固定 lenient(静默丢弃)且无 warnings[]；不可按租户配置                                                                                           | normalize.ts:39-88                                                                                 |

## 值得注意的事实（硬编码点、耦合点）

1. **adapters 禁 import llm-protocol**：codex-oauth 顶注明确 "adapters may not import `@actionow/llm-protocol`"，于是 Responses 方言翻译整体内联手写（codex-oauth.ts:1-12）。方言翻译存在两套：llm-protocol（客户端门面 wire⇄IR，apps/api/src/chat/{openai,anthropic,gemini}.controller.ts）与 adapters（IR⇄上游 wire），同一方言的知识写了两遍（如 OpenAI chat body 结构同时在 llm-protocol/openai/render-request.ts 与 adapters/openai.ts buildChatBody）。
2. **每 adapter 6 处重复样板**：`withProxy(ctx)` 手动 spread、`Authorization` 拼装、`endpoint ?? DEFAULT` 兜底在每个方法里重复（openai.ts:38-40 + 8 个方法）。凭证注入没有单点。
3. codex-oauth 硬编码：CLI 版本 `0.125.0`、User-Agent、Originator、默认 instructions（"You are a helpful assistant."）、OAuth client_id（codex-oauth.ts:40,492-498；engine/oauth/codex.ts:6-16）；后端 stream-only，blocking chat 由 aggregateStream 折叠（codex-oauth.ts:672-677）。egress 经 127.0.0.1 curl sidecar（listModels 注释，codex-oauth.ts:596-604）。
4. Anthropic `DEFAULT_MAX_TOKENS = 1024` 兜底（anthropic.ts:28,122）——IR 未带 maxOutputTokens 时静默设 1024。
5. OpenAI listModels 用正则黑名单剔除非聊天模型 `/embedding|whisper|tts-|dall-e|moderation|image-1/`（openai.ts:838）。
6. rerank/moderation 上游无 usage 时按 `ceil(bytes/4)` 本地估算 input tokens（openai.ts:322-334,663）。
7. async-media 实为「泛任务信封」适配器：task_id/status/result/image_url(s)/video_url/audio_url/duration 等字段名硬编码为 HuiMeng 中继约定（async-media.ts:91-140,191-219）；回调 HMAC-SHA256(`${ts}.${rawBody}`) + 5min 重放窗 + timingSafeEqual，签名/时间戳头名 per-channel config（async-media.ts:21-22,326-350）。
8. 错误映射粒度粗：**只按 HTTP status**，rawCode 仅作记录不参与分类；「HTTP 200 带业务错误码」的翻译只在 dify（data.status!=='succeeded'→job_failed，dify-workflow.ts:47-62）与 async-media（status:'failed'）有个案处理，无通用机制。
9. 轮询无退避：JobRunner 固定 `pollIntervalMs`（默认 1s）× `maxPolls`（默认 30）循环，渠道 config 可调大但**非自适应/无指数放宽**（job-runner.ts:92-95,316-331）；spec 4.3 的 UpstreamPoller 自适应间隔不存在。任务 cancel 接口整条链路缺席（types.ts 无 cancel 方法）。
10. 回调入口按「遍历所有注册 adapter 试 parseCallback」路由（apps/api/src/callbacks/callbacks.service.ts:81,110-112），非 /callbacks/{provider}/{task_id} 定向分发。
11. adapter 声明的 `capabilities` 与模型行 capabilities jsonb 是两套：gate 只消费模型行（chat-relay.service.ts:237）；adapter 声明"尚未接入 dispatch"（types.ts:24-30）。渠道选择目前不做能力过滤（require_params 路由是唯一的参数感知过滤，chat-relay.service.ts:270-291）。
12. 流水线顺序的一个既成事实：渠道级参数 override（②）发生在能力 gate（③）**之后**（gate 在 relay 层、override 在 engine 每渠道尝试内），意味着渠道 override 可以 set 出一个 gate 检查过但模型不支持的参数——顺序与 spec 5.2「校验→路由→映射」一致，但校验不会对 override 后的结果重跑。
13. 传输层 idle/TTFT 超时是 HttpRequest 级注入（faultPolicy→wrapHttpWithTimeouts），与 adapter 解耦良好（execution-service.ts:1514-1525）；但 FetchHttpClient 不支持 connectTimeoutMs（注释明说仅 curl egress 支持，http.ts:203-206）。
