# 03 · 场景二 · 能力基座(Model-B,主线)

**一句话:** 你自持用户/权限/业务库,把每个用户镜像成 core 的一个 `subject`(`external_id` = 你的用户 id),复用 core 的积分/充值/模型/文件。**何时选:** 需要自己的用户体系、要长期演进的正式产品。这是推荐主线。

## 复用矩阵(本场景)

- **复用:** 积分账本、充值、模型中继、文件存储、治理额度。
- **自建:** 用户/认证/权限、业务数据库、联邦层(你的用户 ↔ core subject 的映射)、薄后端。

## 架构 + 时序

你的后端持**两把凭证**:控制面 USER JWT(仅服务端,用于建号/发 key/动账)+ 每个用户的数据面 `ak_`。

```
你的前端 ──▶ 你的后端 ──(控制面 JWT)──▶ core /auth, /console      onboard / 充值
                     └──(用户的 ak_)───▶ core /v1                 chat / run / files
core ──(webhook 最小 ping)──▶ 你的后端 ──(ak_)──▶ GET /v1/jobs/:id  异步结果
```

## 凭证与信任边界

- 控制面 USER JWT 是**租户管理员**级(能为任意 subject 发 key、动账)——**只放服务端**,绝不下发浏览器。
- 数据面 `ak_` 按端用户一把;后端持有,或下发给**受信客户端**(你的取舍)。
- 只在你的用户行存 `subject_id` + `ak_`(加密),不镜像 core 数据。

## 逐步接入

每步给端点 + 机制链接;body/响应细节见 actionow-integration。

### A. Onboard(每个用户一次)

`POST /console/subjects { externalId=<你的用户id> }` → 存 `subject.id`;`POST /console/api-keys { subjectId }` → 存 `plaintext`(`ak_`,仅一次)。机制:[../../actionow-integration/reference/01-authentication.md](../../actionow-integration/reference/01-authentication.md)。

> `/console/subjects`(及 `/sub-account/*`、`/limit-plan`)、`/console/redeem`、`/console/limit-plans` 都**不在** OpenAPI —— 用裸 `fetch`;`/console/api-keys`、`/console/payments/intents` 有类型。同理**整个中继方言**(`/v1/chat/completions`、`/v1/embeddings`、`/v1/audio/transcriptions` 等)与 `/auth/refresh`、`/auth/logout` 也未类型化,只有 `/v1/run`·`/v1/jobs`·`/v1/resources`·`/v1/files` 有类型。完整「哪些 SDK 有类型、哪些走裸 fetch」清单见 [../../actionow-integration/reference/07-sdk-reference.md](../../actionow-integration/reference/07-sdk-reference.md)。

### B. 充值 / 额度

控制面 `POST /console/payments/intents` 或 `POST /console/redeem`;或给 subject 开子钱包并充值:`POST /console/subjects/:id/sub-account/{open,topup,transfer}`(`:id`=subject id,TenantAdmin);治理额度用 `limit_plan` 绑到 subject。机制:[../../actionow-integration/reference/04-billing-and-limits.md](../../actionow-integration/reference/04-billing-and-limits.md)。

### C. Chat

后端用该用户的 `ak_` 打 `POST /v1/chat/completions`(OpenAI 线);`stream:true` 走 SSE。机制:[../../actionow-integration/reference/02-chat-and-relay.md](../../actionow-integration/reference/02-chat-and-relay.md)。

### D. 媒体 / 异步

`POST /v1/run/:resourceId`(`async-poll` 轮询 或 `async-callback` webhook)→ `GET /v1/jobs/:id`;第三条结果通道:`GET /v1/jobs/:id/stream`(SSE 进度推送,终态 `done`/`error`)。机制:[../../actionow-integration/reference/03-media-jobs-and-files.md](../../actionow-integration/reference/03-media-jobs-and-files.md) + [../../actionow-integration/reference/06-webhooks.md](../../actionow-integration/reference/06-webhooks.md)。

### E. 文件

presign → PUT → confirm → 下载 URL;`file_id` 作 `/v1/run` 的输入。机制:[../../actionow-integration/reference/03-media-jobs-and-files.md](../../actionow-integration/reference/03-media-jobs-and-files.md)。

## 示例代码 / 脚本

端到端可跑:[../scripts/onboard-and-call.mjs](../scripts/onboard-and-call.mjs)(登录 → 建 subject → 发 key → 兑换 → chat)。完整 TS 脚手架见 Phase 1 `examples/app-starter/`。

## 反模式

- 把控制面 JWT 下发浏览器(它能动全租户的账)。
- 把 subject UUID 当 `end_user` —— 应传 `external_id`(见铁律 6)。
- 把 core 的余额/用量/文件复制进你的库 —— 只存 ID,按需回源读。
