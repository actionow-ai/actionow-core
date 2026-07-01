# 在 actionow-core 上构建 AIGC 应用 — 工程指南

面向要基于 core **快速上线**一个 AIGC 应用的团队。这是人读版;agent 可读版是 [`skills/building-on-actionow/`](../skills/building-on-actionow/SKILL.md),调用机制细节在 [`skills/actionow-integration/`](../skills/actionow-integration/SKILL.md),可跑脚手架是 [`examples/app-starter/`](../examples/app-starter/)。

---

## 1. 定位:core = 能力基座

core 不是你的整个后端,而是一层**能力基座**:AI 中继(chat/image/video/audio)、信用账本、支付、对象存储、每端用户的计费/归属身份。你**复用**这些,**自建**业务用户体系、产品 UX、Prompt/编排、领域数据。

**复用矩阵(实测):**

| core 的系统                         | 直接复用 | 边界                                                                                                                |
| ----------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| 用户系统(Model-A)                   | ✅       | `subject` = 计费/归属身份 + 自助(`/member/*`:读余额/用量、改资料/密码、自建自己的 key)。不含业务档案/你的权限模型。 |
| 积分                                | ✅       | 租户池 + 每用户子钱包,hold→settle,µcredit(1 credit=1e6 µcredit,响应是字符串,BigInt 解析)。                          |
| 充值                                | ✅       | 支付 intent(`{intent_id,redirect_url?,qr?}`)+ 卡密兑换 + 子钱包充值/守恒划转。                                      |
| 模型                                | ✅       | OpenAI/Anthropic/Gemini 兼容 + 路由/容错/计费。                                                                     |
| 文件                                | ✅       | presign 上传/下载 + 配额。                                                                                          |
| 业务档案/权限、UX、Prompt、领域数据 | ❌ 自建  | core 不存业务数据。                                                                                                 |

**必知约束:** 端用户的 member JWT **不能直连 `/v1`**;AI 调用必须经持 `ak_` 的服务端,或给端用户发 subject-scoped `ak_`(member 也可自铸一把)。

## 2. 三种接入姿势

|               | 托管快启(Model-A)      | 能力基座(Model-B,推荐)           | 混合(Model-B + 复用自助)                                              |
| ------------- | ---------------------- | -------------------------------- | --------------------------------------------------------------------- |
| 端用户身份    | core                   | 你(`external_id` 联邦)           | 你                                                                    |
| 余额/用量自助 | core `/member/*`       | 你自建                           | 后端代读 `/console` 渲染(默认)或 core `/member/*`(需 register-member) |
| 充值 UI       | core 托管              | 你自建 or 复用                   | 复用 core                                                             |
| 你要建的      | 前端 + 极薄 `ak_` 代理 | 用户/权限/业务库 + 联邦 + 薄后端 | 用户库 + 复用 core 自助                                               |
| 适合          | 内部工具/DEMO/轻产品   | 长期演进的正式产品               | 想少写计费界面的正式产品                                              |

**决策:** 自己管用户体系吗?否→托管快启;是→想复用 core 余额/充值自助?是→混合;否→能力基座。逐场景 playbook 见 skill 的 `reference/02/03/04`。

## 3. 迁移:一 → 二

Model-A 的 subject 只有 email+password、**没有 `external_id`**,且 `external_id` **不可变**。所以升级不是「回填 external*id」,而是:在你侧建用户表存 core 的 **`subject_id`(UUID)**、给每个 subject 铸 subject-scoped `ak*`、你接管认证。core 侧数据不动。详见 [reference/05-migration-A-to-B.md](../skills/building-on-actionow/reference/05-migration-A-to-B.md)。

## 4. 技术栈推荐(TS 优先)

- **薄后端**:持控制面 JWT + 每用户 `ak_`;首选 `@actionow/sdk`(端到端类型),关系型库自管、**只存 core 的 ID**(`subject_id`/`file_id`/`job_id`)。
- **异步**:队列 worker 收 webhook(或轮询)。
- **密钥**:控制面 JWT + `ak_` 进 KMS/Vault,绝不进浏览器。
- **其他语言**:用 OpenAI 兼容客户端打中继 + 裸 HTTP 打 `/console`;`@actionow/sdk` 仅作类型参考。
- 起点:`examples/app-starter/`(框架无关 `core-kit` + Express 薄后端;换 Hono/Nest 只改 `routes/`)。

## 5. 编码约定(铁律)

1. **双 client 隔离**:控制面 USER JWT 仅服务端;数据面 `ak_` 按端用户。
2. **只存 ID,不镜像数据**:存 `subject_id`/`file_id`/`job_id`,余额/用量按需回源读。
3. **钱是 µcredit 字符串**:`BigInt` 解析,绝不 `Number`(µcredit = 线上的 µUSD,1 credit = $1 = 1e6 µUSD);`expiresIn` 是时长字符串(`"12h"`)不是秒。
4. **按 `retryable` 重试**:绝不重试 `402`/`400`;billed `/v1/run` 重试带 body `idempotency_key`。
5. **webhook 原始字节验签 → 快速 ack → 回拉 `GET /v1/jobs/:id`**(回调体只是 `{job_id}` 最小 ping);`callback_url` 必须公网可达。
6. **`end_user = <external_id>`**,不是 subject UUID;且 `end_user` 只在 `/v1/run` 生效(chat 靠 key 的绑定 subject 归属)。
7. **SDK 类型面窄**:整个中继方言 + `/console/{subjects,redeem,limit-plans}*` 未类型化 → 裸 `fetch`;typed = `/console/api-keys*`·`/console/payments*`·`/v1/{run,jobs,resources,files,audio/transcriptions}`。
8. **Express 4 异步错误**:包 `asyncHandler` + 终端错误中间件,否则一个 `402` 会挂起请求并拖垮进程。

## 6. 你自身对外 API 规范(照抄 core 的范式)

- **Contract-first**:zod → openapi → 类型;后端 `.parse()`、前端/SDK 只导类型。
- **统一错误信封**:`{ error: { code, message, retryable, retry_after_ms? } }`;客户端按 `retryable` 分支,不按状态码猜。
- **keyset 分页**:`{ data, next_cursor, has_more }`。
- **命名**:请求 camelCase / 响应 snake_case(与 core 一致)。
- **错误翻译**:把 core / 上游错误映射成你面向用户的错误,不外泄 provider/上游细节。

## 7. 线上网关

本组织的 core 网关:**`https://core.actionow.ai`**(Swagger UI:`https://core.actionow.ai/docs`)。把 `ACTIONOW_BASE_URL` 指向它;事实以该 gateway 的 `/docs` 为准。

## 8. 去哪儿看

- [`skills/building-on-actionow/`](../skills/building-on-actionow/SKILL.md) — agent 可读的场景 playbook + 决策 + 铁律。
- [`skills/actionow-integration/`](../skills/actionow-integration/SKILL.md) — 调用机制(端点/鉴权/请求响应/错误/计费/webhook)。
- [`examples/app-starter/`](../examples/app-starter/) — 场景二可 clone 脚手架。
- [`examples/quickstart/`](../examples/quickstart/) — 最小 API 演示。
- [`docs/INTEGRATION.md`](./INTEGRATION.md) · [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md) — 集成总览 / 部署 core 本身。
