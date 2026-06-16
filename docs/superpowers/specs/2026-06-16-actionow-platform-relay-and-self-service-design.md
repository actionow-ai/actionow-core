# Actionow 平台化设计:LLM 协议中转 + 租户自服务(自部署底座)

> **状态:** 设计稿,待用户评审 → writing-plans。
> **日期:** 2026-06-16
> **承接:** 本会话对「协议翻译矩阵 / 开箱即用 / 模型中转 / 权限三平面」的逐步澄清;并入并取代单独的 `llm-protocol-translation` 设想。

## 0. 定位与部署形态(所有支柱共享的地基)

Actionow 是一套**自部署的底层脚手架 + 管理员后端**。每个三方开发者**自部署一套实例**:

- **运营方 = 系统超级管理员**:自部署该实例的三方开发者本人。对**全局**(模型目录 / 渠道 / 计价 / 所有租户)有权限。映射到现有 `user.role='admin'`。
- **租户 = 运营方的客户**:计费边界,拥有 `account`(积分)与若干 `api_key`;经新增的 `/console/*` **用户登录态自服务**。
- **用户 = 登录主体**:本地或 OAuth 登录,归属一个租户。

两个目标场景**同形**,都是「三方自部署 + 其客户作为租户/用户」:

| 场景         | 形态                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| **开箱即用** | 三方自部署 Actionow,当作自己工具应用的后端;其客户=租户/用户。                                                 |
| **模型中转** | 三方自部署 Actionow,当 NewAPI 式中转站转售模型访问;其客户=租户/用户,经 OpenAI/Anthropic/Gemini 兼容端点调用。 |

**扁平租户**:不引入层级化子租户(tenant-of-tenant)。若三方还要在其客户之下再分用户,由三方在其上层自建——本设计只把「运营方 → 客户」这一层做到开箱即用。

---

## 支柱 A — LLM 协议翻译矩阵(对外 API 面)

> 已在本会话认可。Hub-and-spoke:**3 入站解析器 + 3 出站渲染器 + N 上游适配器**汇于一个中枢 IR(加法,非乘法)。

### A.1 中枢 IR(放 `@actionow/contracts`)

覆盖**最满档:文本 + 工具 + 多模态**。

```
ChatRequest { model, messages[], tools?[], toolChoice?, params{ temperature, topP,
              maxOutputTokens, stop[], seed, responseFormat: text|json_object|json_schema }, metadata? }
Message     { role: system|user|assistant|tool, content: ContentPart[], toolCalls?[], toolCallId?, name? }
ContentPart = {text} | {image, source: url|base64|file_id, mime} | {audio,...} | {file,...}
ToolDef     { name, description?, parameters: JSONSchema }
ToolCall    { id, name, arguments }
ChatResponse{ message(assistant, 可带 toolCalls + 多模态部件), stopReason, usage{inputTokens, outputTokens, ...} }
流事件(IR 级): message_start · content_delta · tool_call_delta · usage · stop · done · error
```

### A.2 新包 `@actionow/llm-protocol`(纯函数,仅依赖 contracts)

- **3 入站解析器**(wire→IR):OpenAI ChatCompletions / Anthropic Messages / Gemini generateContent。
- **3 出站渲染器**(IR→wire,含各自 **SSE 帧**):OpenAI `chat.completion.chunk`+`[DONE]`;Anthropic 事件型(`message_start`/`content_block_delta`/`message_delta`/`message_stop`);Gemini `alt=sse` 数组块。
- **归一化层**:能力降级 / 对不支持特性 400(如向无工具能力模型发 tools)。

### A.3 方言映射要点(最易漏)

| 维度               | OpenAI                                          | Anthropic                                         | Gemini                                                       |
| ------------------ | ----------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------ |
| system             | `system` 角色消息                               | 顶层 `system` 参数                                | `systemInstruction`                                          |
| 工具定义/调用/结果 | `tools[].function` / `tool_calls` / `role:tool` | `input_schema` / `tool_use` 块 / `tool_result` 块 | `functionDeclarations` / `functionCall` / `functionResponse` |
| 图像               | `image_url{url}`                                | `image.source.base64/url`                         | `inlineData`/`fileData`                                      |
| usage              | `prompt/completion_tokens`                      | `input/output_tokens`                             | `usageMetadata.*TokenCount`                                  |

### A.4 适配器契约升级

`ProviderAdapter` 增 `chat?(ir,ctx): Promise<ChatResponse>` 与 `streamChat?(ir,ctx): AsyncIterable<ChatStreamEvent>`,返回 **IR 级**结果(保留工具/多模态/stopReason/usage),替换现有 `{text}` 塌缩。升级 openai/anthropic/gemini 三 adapter。旧 `submit/stream` 留给非 chat 模态(图像/视频/dify)。每个 model/adapter 声明能力(tools/vision/audio/json/stream)。

### A.5 端点(均走 `ApiKeyGuard`[+`RateLimitGuard`])

- `POST /v1/chat/completions`(OpenAI)
- `POST /v1/messages`(Anthropic)
- `POST /v1beta/models/{model}:generateContent` 与 `:streamGenerateContent`(Gemini)
- `GET /v1/models`(可选,模型发现)
  错误按各方言错误体 + 正确 HTTP 码渲染。`model` 名经支柱 C 的模型注册表解析。

### A.6 官方 SDK 策略

`openai` / `@anthropic-ai/sdk` / `@google/genai` **仅作类型与规范来源**(必要处镜像成 zod),驱动解析/渲染/适配器的字段正确性;**运行时**的解析、渲染、SSE 序列化、上游 HTTP 全部留在现有 `HttpClient` 端口手写(逐请求凭证、字段透传、OpenAI 兼容上游、网络隔离测试)。

---

## 支柱 B — 身份、权限与租户自服务 console

> 让「开箱即用」成真。复用 Phase 9 的 `user`/`user_identity`/JWT 与 Phase 10 的 payments。

### B.1 权限三平面(明确化 + 加固)

- **运营方 admin**:现有 `AdminGuard`+`@Roles('admin')`,全局。`role` 加 DB 约束(目前自由文本)。
- **租户/用户**:用户 JWT(本地 + OAuth,已存在),作用于**自身租户**。
- 自部署语义:seed 出第一个 admin(运营方);其余皆为客户侧用户。

### B.2 新增 `/console/*`(用户 JWT 守卫,scope=自身租户)

补上审计发现的核心缺口(**自助注册用户拿不到自己租户的 key,tenant 孤立**):

- **API Key 自助**:列 / 建 / 轮换 / 停用 **本租户** 的 key(明文只回一次)。
- **用量自查**:本租户的 jobs / ledger / 调用日志(支柱 C)。
- **自助充值**:复用 payments 创建充值意图,**用户 JWT 授权本租户**(现状只有 admin 能 topup)。
- **模型选择**:列出对本租户可见的模型(支柱 C 的可见性)。
- `ConsoleGuard`:从 `user.tenant_id` 解析租户上下文(独立于 `ApiKeyGuard` 的数据面)。

### B.3 跨租户隔离收紧(把"取后再判"改"谓词式")

审计判定当前隔离 solid 但 jobs/resources 走 fetch-by-id-then-check(结构性脆)。提供 `getJobForTenant`/`getResourceForTenant` 等 **tenant 谓词进 SQL** 的变体,console 与 /v1 一致使用。

### B.4 自部署安全硬化(高优,自部署者易误配)

- 修 **`x-tenant-id` dev 回退**:改为显式开关(默认关),不再仅靠 `NODE_ENV`。
- 修 **dev JWT 密钥静默默认**:非 production 也要求显式密钥或启动告警/拒启。
- **`account.tenant_id` 唯一约束** + job 落 `account_id`(消除一租户多账户把 hold/settle 拆开的风险)。
- 生产构建 / Docker 镜像 / 健康检查 / seed admin 一条龙(让"自部署"真的开箱)。

---

## 支柱 C — 模型中转运营件

> 让「模型中转」成真。建在支柱 A(协议面)+ B(权限面)之上。

### C.1 模型注册表(运营方/admin 管理)

- `model(id, name unique, display, modality='chat', capabilities jsonb, visibility: public|tenant, status, created_at)`。
- `model.name → 一个 chat resource`(复用现有 `upstream_channel` 渠道 + 加权路由 + 失败转移 + 凭证)。入站 body/path 的 `model` 名解析到它。
- 可见性:`public` 对所有租户可见;`tenant` 经 grant 表授权;`api_key.resource_allowlist` 泛化到 model 维度。

### C.2 按模型 token 计价(= 运营方转售价)

- 每模型 `input_price` / `output_price`(µcredit/token)。因**运营方即 admin**,转售加价就是 admin 设的价(上游成本之上的毛利),无需独立 markup 层。
- 走现有引擎:quote(输入 token + maxOutputTokens 估)→ hold → settle(按最终 usage),冻结于 quote。

### C.3 兑换码 / 卡密(可选,运营件)

- `redemption_code(code unique, credit_amount, status, redeemed_by_tenant?, expires_at?)`。admin 批量生成;console 兑换 → 入账(复用 `topUp` 账本路径,幂等于 code)。

### C.4 逐次调用日志 / 统计

- 轻量 per-call `usage_log(tenant_id, model, input_tokens, output_tokens, cost, latency_ms, status, created_at)`。
- console 看本租户;admin 看全局。是中转站运营的基本盘(NewAPI 的"日志"页)。

---

## 实施拆解(3 条 track,顺序留待 writing-plans 细化)

```
Track B(地基)──→ Track C(运营件)──→ 集成
      └────────────→ Track A(协议面, 路由对接 C 的模型表)
```

- **Track B 先行**:三平面加固 + `/console` 骨架 + 自部署硬化(B.4 高优)。
- **Track C**:模型注册表 + token 计价 + 卡密 + 调用日志。
- **Track A**:IR + 3 方言 + 适配器升级;`/v1/chat/completions` 等端点的模型路由对接 Track C 的 `model` 表。
- A 的 IR/方言/渲染可与 B/C 并行;仅"模型名→渠道"这一步依赖 C。

## 复用清单(不重复造)

- **复用**:`user`/`user_identity` + JWT(Phase 9)、`api_key`/`account`/`ledger_txn`、payments(Phase 10)、`upstream_channel` 加权路由、engine `quote→hold→settle` + settle-once、storage(Phase 7)。
- **新增**:`@actionow/llm-protocol` 包;`model` / `redemption_code` / `usage_log` 表;`apps/api/src/console/*`;chat 端点;adapter `chat/streamChat`。

## 测试与验收(各 track 关键点)

- **A**:方言 parse→render 往返一致;跨方言互转(OpenAI 入→Anthropic 上游→OpenAI 出,带工具+图像);三方言流式帧 golden SSE;e2e 用 mock-chat adapter 验证 hold/settle + token 计价 + 断连只结算一次。
- **B**:注册用户经 console 自建 key 后能调 /v1;跨租户 console 访问 404;自助充值入账;两个 NODE_ENV 高危关闭后的回归;account 唯一约束迁移。
- **C**:model 名解析 + 可见性门控;token 计价正确;卡密幂等入账;调用日志记账。

## 风险与开放项

- 多模态在三方言的形状/流式差异最大(A 的最大坑),按映射表逐项测试。
- `model→resource` 复用是否够:若某上游能力与现有 resource/channel 抽象不吻合,可能需 adapter 扩展(记入 plan)。
- 自部署者误配仍是主要风险面:B.4 必须在 Track B 内闭环,不可后置。
