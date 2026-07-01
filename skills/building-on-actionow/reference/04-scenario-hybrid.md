# 04 · 场景三 · 混合(Model-B + 复用 core 自助/充值)

**一句话:** 你自持用户(和场景二一样),但想少写「余额 / 用量 / 充值」界面,把这部分托管给 core。**何时选:** 正式产品、要自己的用户体系,但不想重造计费自助 UI。

## 复用矩阵(本场景)

- **复用:** 积分/充值/模型/文件 + core 的余额读(子钱包)。
- **自建:** 用户/权限/业务库(同场景二)。

## 两种做法

### 3a · 默认(稳,纯 Model-B)

你的后端用**控制面 JWT** 代读 core 的余额、渲染进**你自己的** UI:

- 余额:`GET /console/subjects/:id/sub-account`(`credit_balance`/`credit_held` µcredit 字符串)。**注意**:仅当该 subject 有 HARD 子钱包时可用;纯共享池用户会 404 —— 要么先 `POST /console/subjects/:id/sub-account/open` 开一个,要么展示租户池余额 `GET /console/balance`。
- 用量:core 的 `GET /console/usage-log` 是**租户级、无法按 subject 过滤**(单用户过滤只在 3b 的 `GET /member/usage`)。要在 3a 展示单个用户用量,用**你代理调用时自己记录的 `usage`/`cost`**(你在代打 `/v1`,响应里就有)。
- 充值:后端代调 `POST /console/payments/intents`(得 `{ intent_id, redirect_url?, qr? }`),把 `redirect_url`/`qr` 交给前端。

**不需要 member token。** 纯 Model-B 的 subject(用 `external_id` 建、无密码)天然走这条。机制:[../../actionow-integration/reference/04-billing-and-limits.md](../../actionow-integration/reference/04-billing-and-limits.md)。

### 3b · 进阶(把自助界面整个交给 core)

若想让前端直接读 core 的 `/member/*` 自助面,需要该用户在 core 有**密码**:用 `POST /auth/register-member`(带 `tenantId`)给他在 core 建号 → member JWT → 前端读 `/member/{balance,usage,limits}` + 自助改资料/密码/铸自己的 key。

- 代价:core 也持一份该用户的 Model-A 凭据;该 subject **没有 `external_id`**(register-member 不设),你按它的 **`id`** 关联。
- 约束:member JWT 仍**打不到 `/v1`**;AI 调用照旧走你后端的 `ak_`(或该用户自铸的 `ak_`)。

## 凭证与信任边界

- 3a:控制面 JWT **仅服务端**;端用户永远不直接碰 core。
- 3b:member JWT 前端持(只读自助);控制面 JWT 仍仅服务端。

## 逐步接入(3a)

1. 用户体系、onboarding、AI 调用:同 [03-scenario-capability-base.md](03-scenario-capability-base.md)(建 subject + 发 subject-scoped `ak_`)。
2. 在你的「账户中心」页:余额后端代读 `GET /console/subjects/:id/sub-account`(无子钱包则 `GET /console/balance` 显示租户池);单用户用量用你自己的调用记录(或 3b 的 `/member/usage`)。
3. 「充值」按钮 → 后端代调 `POST /console/payments/intents` → 前端跳 `redirect_url` 或展示 `qr`。

## 反模式

- 把控制面 JWT 下发浏览器(它能动全租户的账)。
- (3b)以为 member token 能打 `/v1` —— 不能,AI 调用仍走 `ak_`。
- 以为纯 Model-B(无密码)的 subject 能 `login-member` —— 不能;要 member 自助得先 `register-member`(3b)。
