# 新供给网关切换预案①② 落地说明（model-supply greenfield 批次4 slice6）

Plan v3 切换四步中的前两步在批次4 末落地。本文是运维/DRI 视角的操作说明；
设计真相 = `docs/plans/draft_2026-07-10_model-supply-greenfield.md`，
批次5 执行第③④步（迁移通告 / 旧世界删除）。

## 预案① 新面全量上线（已完成，零停机，旧面未动）

新端点与旧端点在同一服务内**双面并存**，部署即生效，对所有租户开放，
无灰度开关：

- API 面（`apps/api/src/gateway/`，`GatewayModule` 已注册进 `AppModule`）：
  - `POST /v1/videos/generations`、`POST /v1/audio/music`、`POST /v1/tasks`
    （200 同步 / 202+Task 双形态，§3 自动升格纯服务端）
  - `GET /v1/tasks`、`GET /v1/tasks/:id`、`POST /v1/tasks/:id/cancel`、
    `GET /v1/tasks/:id/stream`（SSE）
  - `GET /v1/gateway/models`（新发现面）
  - `POST /v1/gateway/callbacks/:offeringId`（上游回调，验签先于解析）
- 方言 registry 在进程启动装配一次（`createBuiltinDialectRegistry`：四个代码
  方言 + huimeng DSL pack；api 与 worker 同源）。
- worker 侧五个 sweep 已全部注册进 `startWorkers`（`apps/worker/src/start.ts`）：
  `task-poll`（租约接管）/ `task-reaper`（direct 孤儿 + hold 过期）/
  `task-webhook`（§7.6 下游投递）/ `task-events-reaper`（retention）/
  `artifact-reaper`（签名轨到期）。
- 旧面（`/v1/run`、`/v1/jobs`、旧 `/v1/models`、旧 callbacks/webhook_outbox）
  窗口期原样存活，互不桥接。回滚 = 部署版本回退（旧表/旧账本全程未动）。

## 预案② 内部租户灰度钩子（本批交付钩子机制，实际切换在迁移窗）

「哪些租户的 **legacy 同步面**（chat/embeddings…）改走新网关」的判定钩子。
注意：新任务面端点**不受**此开关约束（见①）；chat/embeddings 的实际分支
接线属于迁移窗（批次5 时序）。

两级解析（`apps/api/src/gateway/gray-release.ts` · `isGatewayV2Tenant`）：

1. **per-tenant**：`tenant.config.gateway_v2`（boolean；
   `@actionow/db getTenantGatewayV2Flag`）。显式 `true`=该租户切新面，
   显式 `false`=强制留旧面（灰度回滚钩子），缺省=无意见。
2. **平台默认**：动态配置键 `GATEWAY_V2_DEFAULT`
   （SettingsResolver：admin override → env `GATEWAY_V2_DEFAULT` → `false`）。

失败即关：两级都无意见 ⇒ `false` —— 租户绝不会被"意外迁移"。

灰度操作（内部租户先行 ≥3 天，plan v3 判据）：

```sql
-- 给内部租户开灰度（admin 面上线前的 SQL 形态）
UPDATE tenant SET config = config || '{"gateway_v2": true}'::jsonb WHERE id = '<tenant-id>';
```

全量切换日：`PUT /admin/settings/GATEWAY_V2_DEFAULT` → `true`（个别租户可用
`"gateway_v2": false` 豁免）；回滚 = 反向操作，无需部署。

## 对账挂点（§9.2 降级口径，判据 2.6）

- 月度 usage 报表（已交付）：`GET /admin/reconciliation/report?from=&to=`
  按（日, 租户, 渠道, 供给项）聚合 sale/cost/毛利（µcredits 字符串），
  `cost_missing_count` 标记成本侧降级行。中转渠道按月人工核对。
- 官方渠道按日自动比对 + 告警：批次5（对账自动化，可砍项），阈值键
  `RECONCILIATION_DEVIATION_PCT` 已就位（动态配置）。
