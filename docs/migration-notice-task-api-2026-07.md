# 【草稿 · 未发送】Actionow 网关 API 迁移通告 —— /v1/run 与 /v1/jobs 进入下线期

> 状态:**草稿**(model-supply-greenfield 批次5 slice4 · 切换预案③)。
> 本文是面向租户的迁移通告底稿,**发送属于运营动作,不在本 slice 执行**。
> 发送前需 DRI 确认:①删除日期(下文占位)②发送渠道(邮件 / 群通知)③收件租户清单。

---

致各租户 / 接入方:

Actionow 网关已上线新一代任务 API(`/v1/tasks` 族)。旧的 `/v1/run` 与 `/v1/jobs` 端点自本通告发出之日起进入 **deprecated(废弃)** 状态,经过一个迁移窗后将被**彻底删除**。请在迁移窗内完成切换。

## 一、时间表

| 节点        | 日期                                                      | 说明                                                 |
| ----------- | --------------------------------------------------------- | ---------------------------------------------------- |
| 新 API 上线 | 已上线(v0.0.11+)                                          | `/v1/tasks` 族与旧端点双面并存,行为互不影响          |
| 通告发出    | 【占位:发送日,DRI 确认】                                  | 旧端点标记 deprecated                                |
| 迁移窗      | 通告发出后 **1 周**                                       | 旧端点照常可用、行为零变化;新旧两面互不桥接          |
| 旧端点删除  | 【占位:删除日 = 发出日 + 1 周,DRI 显式确认后执行,不可逆】 | `/v1/run`、`/v1/jobs`、`/v1/resources` 全部下线(404) |

迁移窗内如遇阻塞,请在删除日前联系平台方;删除动作执行前会做最后一次确认。

## 二、变了什么

### 1. 端点替换(核心)

| 旧(删除倒计时)             | 新                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| `POST /v1/run/:resourceId` | `POST /v1/videos/generations` · `POST /v1/audio/music` · `POST /v1/tasks`(body 带 `type`) |
| `GET /v1/jobs/:id`         | `GET /v1/tasks/:id`                                                                       |
| `GET /v1/jobs`             | `GET /v1/tasks`(`?status=` / `?type=` 过滤,游标分页)                                      |
| `GET /v1/jobs/:id/stream`  | `GET /v1/tasks/:id/stream`(SSE:`snapshot` → `progress`\* → `done`/`error`)                |
| `POST /v1/jobs/:id/cancel` | `POST /v1/tasks/:id/cancel`                                                               |
| `GET /v1/resources[/:id]`  | `GET /v1/gateway/models`(模型 + 操作面 + 参数契约)                                        |

**不受影响的端点**:`/v1/chat/completions`、`/v1/messages`、`/v1beta/*`、`/v1/embeddings`、`/v1/rerank`、`/v1/moderations`、`/v1/images/generations`、`/v1/audio/speech`、`/v1/audio/transcriptions`、`/v1/files/*`、`/console/*`、`/member/*` —— wire 形状不变,无需改动(慢模型的同步媒体端点可能返回 202+Task,见下)。

### 2. 寻址方式:resource id → model 名

新 API 不再用 `resourceId` 寻址。请求体带 `model`(模型对外名),其余键为该模型参数契约声明的 canonical 参数:

```jsonc
// 旧
POST /v1/run/video-relay
{ "inputs": { "prompt": "a red bicycle" }, "exec_mode": "async-poll" }

// 新
POST /v1/tasks
{ "type": "video.generation", "model": "seedance-pro", "prompt": "a red bicycle" }
```

模型可用的操作与参数以 `GET /v1/gateway/models` 为准;未声明的参数会返回 `400 unsupported_parameter`(不再静默丢弃)。

### 3. 响应双形态(submit-and-wait)

不再有 `exec_mode` —— 服务端自行决定:快模型返回 **200 同步结果**;慢/异步返回 **202 + Task 对象**,轮询 `GET /v1/tasks/:id` 至终态(`succeeded / failed / canceled / expired`)。请务必同时处理两种形态(判别 `body.object === "task"`);SDK 的 `submitTaskAndWait` 一次调用消化两种形态。

### 4. 幂等键

旧 body 字段 `idempotency_key` → 新 **`Idempotency-Key` 请求头**,且带请求体指纹:同键同体回放原任务(不重复计费);**同键不同体返回 `409 conflict`**。键在租户内唯一,请按「用户+逻辑操作」命名空间化。

### 5. Webhook 验签(有破坏性变化,必须改)

- 旧:最小 ping `{ job_id }`,签名 = 裸 HMAC-SHA256(secret, body)。
- 新:完整事件信封 `{ evt_id, event_type, created_at, task }`(自带完整 Task 体,终态无需回查),签名头变为 **`X-Actionow-Signature: t=<unix秒>,v1=<hex>`**,摘要 = `HMAC-SHA256(secret, t + "." + rawBody)`,请校验时间戳(建议容忍 ±300 秒)并按 `evt_id` 幂等。
- **secret 改为租户级配置**(不再按回调 URL 从环境推导)——迁移前请与平台方核对你租户的 webhook secret。
- SDK:`verifyTaskWebhookSignature`(新)/ `verifyWebhookSignature`(旧,随旧面一起废弃)。

### 6. 归因方式

新任务面**没有 `end_user` 字段**,按端用户归因唯一方式 = 每用户一把 subject 级 `ak_` key。仍在用「租户级 key + `end_user`」的接入方,请在迁移窗内改为 subject 级 key(`POST /console/api-keys { subjectId }`)。

## 三、切换步骤(建议顺序)

1. **升级 SDK**:`pnpm add @actionow/sdk@latest` —— 新增 `submitTaskAndWait` / `waitForTask` / `verifyTaskWebhookSignature`,`/v1/tasks` 族全部有类型。
2. **替换发现面**:`GET /v1/resources` → `GET /v1/gateway/models`,按返回的参数契约核对你发送的参数。
3. **替换创建调用**:`/v1/run/:resourceId` → `/v1/tasks`(或资源风格端点),`inputs.*` 摊平为顶层参数,`exec_mode` 删除,幂等键上头。
4. **替换查询/取消**:`/v1/jobs/*` → `/v1/tasks/*`;持久化字段 `job_id` → `task_id`。
5. **替换 webhook 接收器**:改新信封解析 + 时间戳验签 + `evt_id` 幂等;与平台方核对租户 webhook secret。
6. **回归验证**:用 skill 内 `scripts/run-and-poll.mjs`(task submit-and-wait)与 `scripts/verify-webhook.mjs --serve` 打真环境验证;全绿后下线旧代码路径。

接入指引(完整契约):`actionow-integration` skill(仓库 `skills/actionow-integration/`,或 multica registry 同步版);工程/架构层:`building-on-actionow` skill。

## 四、Deprecation 响应头说明

迁移窗内调用**被废弃的模型**会在响应头收到下线预告:

```
Deprecation: true
X-Actionow-Model-Deprecated: <model>
```

收到即代表该模型进入下线预告期,预告期结束后返回 `404 model_not_found`。建议在客户端日志中对 `Deprecation` 头告警,以免错过模型级下线。(注意:这是「模型」的下线预告机制;`/v1/run` / `/v1/jobs` 的「端点」下线以本通告的时间表为准。)

## 五、迁移窗内的行为承诺

- 旧端点在迁移窗内**行为零变化**(路由、计费、webhook 均按旧口径),新旧两面互不桥接:`/v1/run` 建的 job 查不到 `/v1/tasks`,反之亦然。
- 切换日前后各租户账单口径连续(新旧账本并存、快照对账),无需任何账务动作。
- 回滚保障:删除动作执行前,平台随时可版本回退,旧面数据全程未动。

如有疑问,请回复本通告或在工作群联系平台 DRI。

—— Actionow 平台
