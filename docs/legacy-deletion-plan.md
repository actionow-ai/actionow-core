# 旧世界删除计划（切换预案④ · DRI 确认后执行 · 不可逆）

> **状态：待 DRI 确认。本文档只是删除计划，删除本身尚未执行。**
>
> 依据 plan v3 切换预案 D1：「删除是最后一步不可逆动作，DRI 显式确认后执行」。
> 生成于批次 5（运营面收口 + 切换接线已落地），删除留待迁移窗结束 + DRI 签字。

## 0. 删除前置门（全部满足才可动手）

| #   | 前置                                                                                                                | 现状（2026-07-13）                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| P1  | **7/7 旧同步面全部切到新网关**                                                                                      | ❌ **2/7**（chat + embeddings 已切；anthropic / gemini / rerank / moderations / transcriptions 待切） |
| P2  | 内部租户灰度 ≥3 天（`GATEWAY_V2_DEFAULT=true` 或 per-tenant flag），旧 chat 面零流量                                | ⏳ 迁移窗生产动作，未开始                                                                             |
| P3  | 迁移窗（目标 1 周）内新旧双活，切换日出新旧双账快照，对账零偏差                                                     | ⏳ 迁移窗生产动作                                                                                     |
| P4  | 灰度租户所用模型有完整 canonical 契约（空 `params:[]` 会让第 2 层丢 messages→上游 400）                             | 需逐模型核                                                                                            |
| P5  | GovernanceGuard 拆除与新面接 limit-plan 同步（否则 v2 流量失额度套餐执行）                                          | 新面 limit-plan 接线待补                                                                              |
| P6  | 迁移通告已发（[migration-notice-task-api-2026-07.md](migration-notice-task-api-2026-07.md)，删除日期占位待 DRI 填） | 草稿就绪，未发送                                                                                      |
| P7  | **DRI 显式确认删除**（D1 不可逆动作）                                                                               | ❌ 待确认                                                                                             |

**P1 与 P7 是硬闸**：chat 面未全切时删 `execution-service` 会炸编译；删除不可逆。

## 1. 删除对象（plan D2 / 交接卡禁区）

- **dify 子系统**：`packages/dify` 整包、`dify_binding` 表、`dify-workflow` adapter、dify-registration、BYO 导入、admin-dify controller/service。
- **QuickJS sandbox/plugin**（dify 用）：`engine/src/{sandbox,plugin-runner,plugin-adapter}.ts`、`provider_plugin` 表、seed-plugins。
- **`/v1/run` + `/v1/jobs`**：run/jobs/resources controller+service、`execution-service`、`job-runner`（worker）、旧 `callbacks` 模块、`job` / `webhook_outbox` 表。
- **resource 三层**：`resource` / `resource_version` / `upstream_channel` / `channel_model` / `model` / `model_grant` / `pricebook_entry` 表 + repos、`channel-routing.service`、旧 `model-resolver`、seed-providers。

## 2. 保留资产（删旧时不能误删 · plan §12）

µUSD 计费（domain/pricing）、`account` / `ledger_txn` / µ 记账、`audit`（append-only）、`subject` / `tenant` / `api_key`、`route_group` / tags、`modifier`、`limit_plan`、`official_model_price` / `model_spec`（目录参考层）、`fault-policy`、`platform_setting`、`relay_trace`、`channel_breaker`（FSM，key 已迁供给项）、infra（http/ssrf/storage/settings）、`breaker.ts` FSM、R2 存储。

**三个混合文件（局部删，勿整删）**：

- `schema/execution.ts`：删 `job` + `webhookOutbox`，**留 `ledgerTxn` + `idempotencyKey` + `requestIdempotency`**。
- `schema/catalog.ts`：删 resource 三层 + `difyBinding`，**留 `secretRef` + `secretMaterial`**（新 `supply_credential.secret_ref_id` FK 依赖）。
- `schema/pricing.ts`：删 `pricebookEntry`，**留 `modifier` + `giftCode`**。

## 3. 编译破坏切割点（必须先断）

- **A**：chat/embeddings/media → 旧 `ExecutionService`/`ChannelRoutingService`/`pricebook_entry`/`model`/`channel_model` → **P1 全切后才可删 execution-service**。
- **B**：`ledger_txn.job_id` FK → `job` → 删 `job` 表前先 `ALTER TABLE ledger_txn DROP CONSTRAINT`。
- **C**：`supply_credential.secret_ref_id` FK → `secretRef` → catalog.ts 局部删，secretRef/secretMaterial 必留。
- **D**：`admin.module` 复用 `JobsService`/`JobStreamService`/`AdminDifyController`/catalog CRUD → 删时同步改 admin.module。
- **E**：barrel 导出（engine/adapters/db-repositories/sdk index）→ 删文件同步删 re-export。

## 4. 安全删除顺序（DRI 确认后按序，每步独立可验）

1. **前置**：完成 P1（余 5 面切换）→ P2 灰度 → P4/P5 核查 → P6 发通告 → **P7 DRI 确认**。
2. **删 dify 子系统**（最独立，仅 2 个 importer）：断 admin-dify.service + dify-registration → 删 AdminDify controller/service（改 admin.module）→ 删 dify-registration.ts（改 engine barrel）→ 删 dify-workflow.ts（改 adapters barrel）→ 删 `packages/dify` 整包（改 2 个 package.json）→ 删契约 dify DTO + openapi → 删 `dify_binding` schema/repo。
3. **删 QuickJS sandbox/plugin**：确认 chat 不走 `provider_plugin` → 删 seed-plugins、sandbox/plugin-runner/plugin-adapter（改 engine barrel）→ 删 `plugin` schema/repo → admin model-test 试跑段 → 移除 `quickjs-emscripten` 依赖。
4. **删 `/v1/run` + resources**：删 run/resources controller+service + execution.module（改 app.module）→ 删 `execution-service.ts`（A 已断 chat）→ 删旧 callbacks（新 gateway-callbacks 留）→ 删 openapi/e2e。
5. **删 `/v1/jobs` + job-runner**：删 jobs 模块（改 app.module + admin.module 的 JobsService 复用）→ 删 worker job-exec.processor + start.ts 旧队列 → 删 engine job-runner/stream/reaper/job-progress（改 barrel）→ 删 SDK 旧 helper submitAndWait/consumeJobStream/verifyWebhookSignature（改 sdk barrel）。
6. **删 resource 三层 + 旧供给**：删 channel-routing.service、旧 model-resolver 旧路径、admin catalog CRUD、seed-providers/seed 供给段。schema 局部删（resource/version/upstream_channel/model/modelGrant/channelModel/pricebookEntry；留 secretRef/secretMaterial/modifier）+ 对应 repo。
7. **DROP migration（最后 · 单独批 · DRI 二次确认）**：drizzle migration append-only 不可删旧 SQL → 新增一支 DROP migration（mig 0072+）：`ALTER TABLE ledger_txn DROP CONSTRAINT ..._job_id_...` → `DROP TABLE job, resource, resource_version, upstream_channel, channel_model, dify_binding, provider_plugin, pricebook_entry, webhook_outbox`。**一旦上生产不可回滚**，与代码删除分开发布、独立确认。
8. **收尾**：全链 typecheck/lint/test + 漂移门绿；skill 二次清除迁移窗保留段（见 batch5-slice4 报告清单）；更新 openapi 快照 + docs.e2e；seed 改为「目录 + 方言包」；清 worker 旧队列文档。

## 5. 破坏面（删除时一并清的测试/文档）

- e2e：`run.e2e` / `jobs-isolation.e2e` / `stream-callbacks.e2e` / 旧 chat-relay e2e / acceptance/full-stack 中的 /v1/run·/v1/jobs 断言。
- engine：execution-service / job-runner / run-stream / reaper / channel-routing / sandbox / plugin-runner / plugin-adapter / dify-registration 测试。
- openapi.json：`/v1/run` / `/v1/jobs` / `/v1/resources` / `/admin/dify*` / `/admin/resources*` + dify schema 注册（删后 docs.e2e 快照变）。
- SDK：`submit-and-wait.ts` / `job-stream.ts` / `verifyWebhookSignature`（留新 `task.ts` / `verifyTaskWebhookSignature`）。

## 6. 回滚

删表 migration 前的任何时点：回滚 = 部署版本回退（旧代码在 git、旧表未动、旧账本未动 · plan Approach）。**DROP migration 上生产后不可回滚**——故第 7 步单独批、DRI 二次确认。
