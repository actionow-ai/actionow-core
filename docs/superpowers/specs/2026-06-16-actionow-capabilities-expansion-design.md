# Actionow 能力扩展设计 — OSS · 执行模式 · OAuth · 支付（Phase 7–10）

> 状态：已获 user 设计认可（2026-06-16）。逐 phase 落地：spec → plan → 实现 subagent → 对抗式评审 → 合并。
> 选型均经 2026-06 官方文档/npm 实证（见各节 sources）。
> 前置：Phase 0–6 已完成并合并（统一网关 + 计价账本 + 5 adapter + Dify BYO + 鉴权/管理台 + 真实全栈 e2e）。

---

## 0. 总览与分解

四个相互独立但有依赖顺序的子系统,各成一个 phase,每 phase 至少一条路径**真跑通且有测试**,其余渠道按同一接口配置即上线:

| Phase | 子系统                                | 真实参考实现                         | 配置型 stub                  |
| ----- | ------------------------------------- | ------------------------------------ | ---------------------------- |
| 7     | OSS 文件存储                          | 统一 S3 客户端（真连 R2/MinIO 可测） | OSS/COS/TOS 仅配置差异       |
| 8     | 执行模式（SSE 流式 + async-callback） | SSE 真流式 + mock 流式 adapter       | —                            |
| 9     | OAuth + 统一身份                      | 真 OAuth 流程（token 交换可 mock）   | —                            |
| 10    | 支付（不止充值）                      | Stripe（测试模式 + mock webhook）    | 支付宝 / 微信 APIv3 / crypto |

**新增包/抽象**:`StorageProvider`(contracts 接口 + infra 实现)、`PaymentProvider`(新包 `@actionow/payments`)、`ProviderAdapter.stream?()`(adapters)。
**新增表**:`user` + `user_identity`(替代 `admin_user`)、`file_object`、`payment_intent` + `payment_event`。
**新增端点**:`/v1/files/*`、`/v1/callbacks/:provider`、`/auth/*`(oauth + 统一登录/注册)、`/v1/payments/*`。

## 0.1 横切:webhook 原始体纪律

回调(Phase 8)与支付 webhook(Phase 10)共用:在 `apps/api/src/main.ts` 对这些路由用 `express.raw({type:'application/json'})`(或全局 `express.json({verify:(req,_res,buf)=>{req.rawBody=buf}})`),签名校验**对原始字节**做,用 `crypto.timingSafeEqual`,绝不用重新序列化的 JSON。复用既有 `signPayload`、idempotency-claim 仓库、原子账本。

---

## Phase 7 — OSS / 文件存储

**目标**:为 io_schema 的 `file`/`file_list` 入参与图像/视频输出提供统一对象存储:客户端直传(预签名 PUT)、按需下载(预签名 GET),对象引用入库。

**统一 S3 抽象（关键发现:六家全 S3 兼容）**

- `StorageProvider`(contracts 纯接口):`presignPut · presignGet · head · delete · put · get`。
- `S3StorageProvider`(infra):`@aws-sdk/client-s3` v3 + `@aws-sdk/s3-request-presigner`(三件同版本,~3.106x)。每 provider 一份 config:
  | provider | endpoint | region | forcePathStyle |
  |---|---|---|---|
  | aws-s3 | 默认 | 真 region | false（保留默认校验和） |
  | r2 | `https://<acct>.r2.cloudflarestorage.com` | `auto` | false |
  | minio | 自建 URL | `us-east-1` | **true** |
  | aliyun-oss | `https://s3.oss-<region>.aliyuncs.com`（`s3.` 前缀） | `oss-<region>` | false |
  | tencent-cos | `https://cos.<region>.myqcloud.com`（bucket 名含 `-APPID`） | `ap-<region>` | false |
  | volcano-tos | `https://tos-s3-<region>.volces.com`（**tos-s3-** 变体） | `cn-<region>` | false |
- **必做关键修复**:对所有非 AWS client 设 `requestChecksumCalculation:'WHEN_REQUIRED'` + `responseChecksumValidation:'WHEN_REQUIRED'`(SDK v3.729+ 默认 CRC 校验会 400 掉 R2/MinIO/OSS/COS/TOS)。
- **预签名注意**:签名 header 必须与实际发送一致(presign PUT 尽量只带 Bucket/Key);最大有效期 7 天;浏览器直传需配 bucket CORS。

**数据模型**:`file_object(id, tenant_id, provider, bucket, key, size, content_type, etag, status, created_at)` — **存引用不存 URL**;下载时按 provider 重新 mint 预签名 GET。

**端点(ApiKeyGuard)**:

- `POST /v1/files/presign-upload {filename, content_type, size}` → 校验策略(mime/size)、生成 server-side key `{tenant}/{uuid}.{ext}`、返回预签名 PUT URL + `file_id`。
- `POST /v1/files/{id}/confirm` → `HeadObject` 验在 + 落 size/etag/content_type,`status=ready`。
- `GET /v1/files/{id}/url` → 预签名 GET URL。
- io_schema 的 `file`/`file_list` 入参值即 `file_id`(或 `{file_id}` 引用),执行前解析为对象引用/URL 传给 adapter。

**provider 配置**:env/config 注入各 provider 凭证;租户默认 provider 可配(scaffold:全局默认 + env)。

**测试**:对 **MinIO**(docker-compose 加一个 minio 服务)做真实集成测(presign PUT 上传 → HeadObject → presign GET 下载),验证「关校验和」修复;其余 provider 配置以单测覆盖(endpoint/forcePathStyle/checksum 选项正确)。

**sources**:AWS SDK v3 checksum 变更 #6810 / S3 data-integrity 文档;R2 / OSS / COS / TOS 各家「用 AWS S3 SDK 接入」官方文档;MinIO checksum issue #20845。

---

## Phase 8 — 执行模式:SSE 流式 + async-callback

**目标**:在 blocking/async-poll 之上补 `stream`(SSE)与 `async-callback`。

**adapter 流式**:`ProviderAdapter.stream?(input, ctx): AsyncIterable<StreamEvent>`(可选,似 `poll?`)。`StreamEvent = {kind:'delta'|'usage'|'done'|'error', text?, usage?, error?}`。**用原始 `fetch` SSE 解析**(不引入 openai/anthropic/genai 重 SDK):

- openai:`stream:true` + `stream_options:{include_usage:true}` → 末尾空 `choices` chunk 带 `usage`。
- anthropic:原生 SSE,`message_start`(input_tokens) / `content_block_delta.delta.text` / `message_delta`(output_tokens,累积)。
- gemini:`:streamGenerateContent?alt=sse` → 末 chunk `usageMetadata`。
- 给 `FetchHttpClient` 加流式变体(暴露 `fetch().body` 异步迭代),不动既有 buffered `request()`。

**引擎管线(解决 settle-at-end + settle-once)**:`ExecutionService.runStream(req) → {jobId, holdAmount, events}`。NestJS 用 **`@Sse()` 返回 `Observable<MessageEvent>`**:

1. **先**(返回 Observable 之前,在 controller/RunService 内)`validate → quote → hold(上限)` — 因为 Nest 在 handler 体执行前就建立 SSE 连接,402/400 必须在此前作为真实 HTTP 错误抛出。
2. 代理 `delta` 事件;捕获末尾 usage → `event: usage`。
3. **`finalize()`**(完成/上游错误/客户端断开都触发)→ `computeFinalCost` → **`settleJob` 一次**(其状态转移 guard 已保证幂等,同 poll/callback 去重);断开无 usage → 按 hold 上限保守结算;reaper 兜底。
4. 网关事件:`event: delta {text}` · `event: usage {...}` · `event: done {job_id, cost, usage}` · `event: error {code,message}`(`cost.credits` 仍是 µcredit 十进制字符串);可选 `event: ping` 心跳(~15s),对该路由关压缩/`X-Accel-Buffering:no`。

- `execute()` 里 `stream` 单独分支(不再并入 BLOCKING_MODES)。

**async-callback 入口**:`POST /v1/callbacks/:provider`(**不挂 ApiKeyGuard**,HMAC 即鉴权):原始体 + **按 binding 的 per-channel secret** 校验 + 时间戳重放窗口(~5min) → 既有 `engine.handleCallback(payload)`(已 dedup-safe,按 `getJobByUpstreamHandle` 关联)。签名拼装因 provider 而异 → 放进 adapter(`verifyCallback`/`parseCallback`)。

**测试**:加一个 `mock-stream` adapter(确定性 delta + 末 usage)→ 真 `@Sse` e2e:订阅 delta、收 done.cost、断言一条 settle 账本;断开中途 → finalize settle(上限)。callback:HMAC 正确→settle、错误→拒、重复→一条账本。

**sources**:NestJS SSE 官方 + lifecycle(finalize/断开)、连接先于 handler #11332、shutdown #9517;OpenAI include_usage;Anthropic streaming;Gemini alt=sse;webhook 安全(raw body + timing-safe + 时间戳窗口 + 幂等)。

---

## Phase 9 — OAuth + 统一身份

**目标**:Google/GitHub 辅助登录 + 本地注册 + 账号绑定;管理员与普通用户**同一套** `user` 逻辑。

**库**:`arctic`(非 Passport、非已弃用的 Lucia)。Google(OIDC+PKCE)、GitHub(OAuth2+state),签发既有 `@nestjs/jwt`。

**数据模型(迁移 `admin_user` → `user`)**:

- `user(id, email unique(lower), email_verified, password_hash NULLABLE, role['admin'|'user'], status, created_at, tenant_id?)`。
- `user_identity(id, user_id FK, provider['google'|'github'], provider_user_id, created_at, unique(provider, provider_user_id))` — **按 (provider, sub) 关联,绝不按 email**。
- 迁移:把现有 `admin_user` 行迁入 `user`(role=admin);`@Roles` guard 改读 `user.role`,管理台端点逻辑不变。

**流程**:

- `POST /auth/register {email,password}` → 建 user(role=user)+ 为其建 tenant+account(登录闭合到计费);本地登录沿用现有(generalize `/admin/auth/login` → `/auth/login`,兼容)。
- `GET /auth/oauth/:provider` → 生成 state(+PKCE for Google),存短时 HttpOnly cookie(或 Redis),重定向。
- `GET /auth/oauth/:provider/callback` → 换 token、取 profile(GitHub 另调 `/user/emails` 取 primary+verified)、按 `(provider,sub)` 查 `user_identity`:命中→登录;未命中→轻量注册(建 user,password_hash NULL,email_verified=provider 的 verified)+ identity 行(一事务)。
- `POST /auth/link/:provider`(已登录)→ 绑定;**仅 verified email 自动关联**;绑到「未验证口令账号」强制改密/重验(防接管)。
- state/codeVerifier 单次、HttpOnly+Secure+SameSite=Lax;redirect_uri 精确白名单;不信任未验证 email。

**测试**:OAuth 单测/集成(token 交换与 profile fetch 经注入的 fake HttpClient mock);注册→登录→OAuth 绑定→OAuth 快速登录;按 (provider,sub) 去重、未验证 email 不自动关联、迁移后 admin 登录仍可用。

**sources**:Arctic Google/GitHub providers;Lucia 弃用说明;安全身份绑定(WorkOS/Clerk);Google sub-vs-email 漏洞;RFC 9700/OAuth 2.1。

---

## Phase 10 — 支付（不止充值）

**目标**:Stripe/支付宝/微信/crypto,用途 `topup | order | subscription`,成功 → 履约(充值入账本 / 订单置已付)。

**抽象 `@actionow/payments`(新包)**:`PaymentProvider`:`createIntent(purpose,amountMinor,currency,meta) → {providerRef, redirectUrl|qr}`;`verifyWebhook(rawBody, headers) → {eventId, type, providerRef, status}`。导入 contracts/infra(boundaries 增 `payments`;engine → +payments)。

- **Stripe(真参考)**:`stripe` v22,Checkout Sessions(mode payment|subscription),`constructEvent` 验签(`Stripe-Signature`,原始体),监听 `checkout.session.completed`/`payment_intent.succeeded`/`invoice.paid`;outbound `idempotencyKey`。**只在 webhook 履约,不在 redirect 履约**。
- **支付宝(stub)**:`alipay-sdk` v4,RSA2,`trade.page.pay`,notify 用 **`checkNotifySignV2`**(避 passback_params 坑)、用支付宝公钥验、验签+业务成功后回 `success`。
- **微信 APIv3(stub)**:`wechatpay-node-v3`(陈旧,薄封装),Native/JSAPI;验签按 `Wechatpay-Serial` **分支**(`PUB_KEY_ID_*`→公钥 / 否则平台证书,2026 迁移),回调 `resource` 用 APIv3 key **AES-256-GCM** 解密。
- **crypto(stub)**:Coinbase Commerce,`X-CC-Webhook-Signature` = HMAC-SHA256(raw body, 共享密钥);`charge:confirmed` 履约;`provider_ref`=charge id(非 tx hash),金额存结算币最小单位,留 on-chain 扩展位。

**数据模型**:

- `payment_intent(id, tenant_id, provider, provider_ref unique-per-provider, purpose, target_ref, amount_minor bigint, currency, credit_amount bigint, status[created|pending|succeeded|failed|expired|refunded], idempotency_key, created_at, updated_at)`。
- `payment_event(id, payment_intent_id?, provider, provider_event_id, type, raw_payload jsonb, signature_ok, processed_at?, received_at, unique(provider, provider_event_id))` ← 幂等锚。

**统一流程(一条码路 + provider 插件)**:`create intent → 跳转/二维码 → webhook → 原始体验签(拒则止)→ INSERT payment_event ON CONFLICT DO NOTHING(0 行=已处理,200 止)→ 按 provider_ref 匹配 intent、置状态 → 一事务履约(topup→复用原子账本+idempotency-claim;order→置已付;subscription→授时)→ mark processed → 200`。金额整数最小单位;币种→credit 汇率**在 create 时固定**存 `credit_amount`,履约即授该值。

**端点**:`POST /v1/payments/intents`(创建,返回跳转/QR)、`POST /v1/payments/webhooks/:provider`(原始体、验签、幂等履约)、`GET /v1/payments/intents/:id`。管理台:列支付/对账。

**测试**:Stripe 用 mock(构造带正确签名的 webhook → 验签通过 → topup 入账本;重复事件 → 一笔;签名错 → 拒)+ purpose=order 履约;支付宝/微信/crypto 的 verifyWebhook 用各自签名算法单测(正/误/重放)。

**sources**:Stripe Checkout vs PaymentIntents / webhook 验签 / 幂等;Alipay Node SDK v4 + checkNotifySignV2;微信 APIv3 验签 + 公钥迁移 + AES-GCM;Coinbase Commerce webhook 安全。

---

## 测试与验收(每 phase)

- 单测 + Testcontainers 集成 + 真实路径 e2e(Phase 7 真 MinIO、Phase 8 真 SSE、Phase 9 真 OAuth 流程 mock token、Phase 10 Stripe mock webhook → 入账)。
- `pnpm typecheck/lint/build/test` 全绿;包边界(`no-restricted-imports`)保持;无密钥落日志(原始体/签名/凭证)。
- 每 phase 独立 spec/plan → 合并 main。

## 不在本轮(诚实标注)

- 真实生产凭证下的端到端联调(需 user 提供 Stripe/支付宝/微信商户号、OAuth App、各云 OSS 凭证)。
- crypto on-chain 直监听、支付宝/微信前端收银台 UI、OSS 图像处理(OSS `x-oss-process`)/ TOS 原生能力。
- 多账户/租户成员模型细化(user.tenant_id 单租户假设,延续 FOLLOWUPS)。
