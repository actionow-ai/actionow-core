# 02 · 场景一 · 托管快启(Model-A)

**一句话:** 让 core 认证端用户、托管余额/充值,你只做前端 + 一个极薄的 `ak_` 代理。**何时选:** 内部工具、DEMO、轻产品——最少自建、最快上线。

## 复用矩阵(本场景)

- **复用:** core 的用户(Model-A)、积分、充值、模型、文件。
- **自建:** 前端 + 极薄代理(持一把服务端 `ak_` 代打 `/v1`)。

## 架构 + 时序

```
端用户 ──▶ 你的前端 ──(member JWT 登录/自助)──▶ core /auth, /member/*        身份 + 自助读/改
                    └──▶ 你的极薄代理 ──(服务端 ak_)──▶ core /v1/chat/completions   AI 调用
                                        └────────────▶ core /v1/payments/intents    代下单充值
```

端用户在 core 登录拿 member JWT(自助读余额/用量 + 改资料/密码 + 自建自己的 key);member JWT **只能**到 `/auth` 和 `/member/*`,**打不到任何 `/v1`**。AI 调用与充值都走你的代理(服务端 `ak_`)。

## 凭证与信任边界

- member JWT 前端持有:`/member/*` 自助(读 + 改资料/密码/自建自己的 key),**无法**打 `/v1`。
- 服务端 `ak_` **只在你的代理**,绝不下发浏览器。且这把代理 `ak_` 必须是**租户级**(不绑 subject),这样每次调用带 `end_user=<external_id>` 才能把花费归到具体用户;subject-scoped 的 key 只能服务它绑定的那一个用户(`end_user` 不符 → 401)。
- 控制面 JWT 只在你首次建号/配置时用,不参与请求热路径。
- 想省掉代理?让前端用 member JWT 调 `POST /member/api-keys` 自助铸一把 `ak_`、再直连 `/v1` 也可行——代价是 `ak_` 落到浏览器,自行权衡。

## 逐步接入

### 1. 端用户注册 / 登录

`POST /auth/register-member` · `POST /auth/login-member`,**body 必带 `tenantId`** → member JWT(`typ:subject`)。机制:[../../actionow-integration/reference/01-authentication.md](../../actionow-integration/reference/01-authentication.md)。

### 2. 端用户自助(余额 / 用量 / 额度)

前端用 member JWT 读 `/member/balance` · `/member/usage` · `/member/limits`。机制:[../../actionow-integration/reference/01-authentication.md](../../actionow-integration/reference/01-authentication.md)。

### 3. 充值(经你的代理,不是 member JWT)

充值是数据面/控制面动作,**member JWT 打不到**——`/member/*` 上没有任何充值路由。两种正确做法:你的代理(持服务端 `ak_`)在校验 member JWT 后代调 `POST /v1/payments/intents`;或租户管理员用控制面 JWT 调 `POST /console/payments/intents` 给共享池充值。浏览器永远不持支付凭证。机制:[../../actionow-integration/reference/04-billing-and-limits.md](../../actionow-integration/reference/04-billing-and-limits.md)。

### 4. AI 调用(经你的代理)

前端 → 你的 `/api/chat`(校验前端带来的 member JWT)→ 代理用服务端 `ak_` 打 `POST /v1/chat/completions`,并带 `end_user=<该 member 的 external_id>` 归属到具体用户。机制:[../../actionow-integration/reference/02-chat-and-relay.md](../../actionow-integration/reference/02-chat-and-relay.md)。

## 示例代码 / 脚本

极薄代理的最小可跑实现(`managed-proxy.mjs`)与 `scenario-managed/` 变体在 **Phase 1** 落地;本节先给时序 + 关键片段。端到端登录/建号可参考主线脚本 [../scripts/onboard-and-call.mjs](../scripts/onboard-and-call.mjs)。

## 反模式

- 把服务端 `ak_` 下发浏览器(它是计费凭证,泄露即被人代花)。
- 以为 member JWT 能直连 `/v1`(含 `/v1/payments`)—— 会 401;要么经你的代理,要么先用 `POST /member/api-keys` 铸一把 `ak_` 再用它调。
