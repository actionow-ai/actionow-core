# 新供给网关切换预案①②③ 落地说明（model-supply greenfield 批次4 slice6 · 批次5 slice3）

Plan v3 切换四步中的前两步在批次4 末落地，第③步（legacy 同步面接线）在
批次5 slice3 落地。本文是运维/DRI 视角的操作说明；
设计真相 = `docs/plans/draft_2026-07-10_model-supply-greenfield.md`，
批次5 slice5 执行第④步（旧世界删除）。

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

## 预案③ legacy 同步面接线（批次5 slice3 已落地：chat + embeddings）

预案②的开关正式接上 legacy 同步面。`POST /v1/chat/completions` 与
`POST /v1/embeddings` 的 controller 在**入口第一行**按 `isGatewayV2Tenant`
分支（`apps/api/src/chat/{openai,embeddings}.controller.ts`）：

- **flag=true**：整请求走纯新网关 —— OpenAI wire → §4.1 第1层 canonical 归一
  （`apps/api/src/gateway/chat-facade.ts`，别名归一 `max_completion_tokens`→
  `max_tokens`，显式参数 `isDefault:false`、模型契约 default 补齐
  `isDefault:true`）→ `gateway.execute`（§7.8 闸门/§8 路由/§9.2 结算）→
  OpenAI wire 渲染（`apps/api/src/gateway/openai-render.ts`：chat.completion /
  chunk SSE 以 `data: [DONE]` 收尾、错误帧无 [DONE]、OpenAI error 信封 +
  conflict→409 / rate_limited→429+Retry-After / model_not_found→404 /
  insufficient_credits→402 / unsupported_parameter→400）。编排在
  `apps/api/src/gateway/chat-v2.service.ts`（GatewayModule 导出）。
- **flag=false**：原样走旧 ChatRelayService / EmbedRelayService（逻辑零改）。
  新旧不桥接。

窗口期已知重叠（随 slice5 旧世界删除一并消失）：

1. 旧 controller 的 ApiKeyGuard+GovernanceGuard 挂载不动（旧面零改），故
   flag=true 请求先过 legacy 守卫（legacy RPM 窗 + limit-plan 规则）再过新面
   §7.8 四层闸——两侧同时执行，取更严者（fail-closed 方向；新面尚未接
   limit-plan，守卫重叠反而补住这块）。
2. `/v1/embeddings` 入口的旧 ZodBody wire 校验仍然先跑（旧面零改），v2 分支
   拿 `req.body` 原始体归一。
3. 新面要求真实 api key（冻结 IR：apiKeyId 必填）——dev `x-tenant-id`
   fallback 在 flag=true 时 401。

**已切 vs 待切**（删除 execution-service / 旧 chat 面前必须全切）：

| legacy 同步面                                           | 状态                                                                   |
| ------------------------------------------------------- | ---------------------------------------------------------------------- |
| `POST /v1/chat/completions`（OpenAI）                   | ✅ 已切（本 slice）                                                    |
| `POST /v1/embeddings`                                   | ✅ 已切（本 slice）                                                    |
| `POST /v1/messages`（Anthropic 门面）                   | ⏳ 待切（入口翻译器保留，§5；wire→GatewayRequest 门面 + 出口渲染未接） |
| `/v1beta/models/{model}:generateContent`（Gemini 门面） | ⏳ 待切（同上）                                                        |
| `POST /v1/rerank`                                       | ⏳ 待切（操作面 `rerank` 已在 OPERATIONS；门面+渲染未接）              |
| `POST /v1/moderations`                                  | ⏳ 待切（同上）                                                        |
| `POST /v1/audio/transcriptions`（multipart STT）        | ⏳ 待切（multipart 文件输入需走 §9.4 文件管道）                        |

供给前置：flag=true 的租户所用 chat/embeddings 模型必须有**完整 canonical
参数契约**（接入向导默认的空 `params:[]` 只是占位——§4.1 第2层
resolveEffectiveParams 只转发契约声明过的参数，空契约会把 `messages`/`input`
全部丢弃）。切灰度前先在目录校订契约（messages/input + 采样参数）。

## 对账挂点（§9.2 降级口径，判据 2.6）

- 月度 usage 报表（已交付）：`GET /admin/reconciliation/report?from=&to=`
  按（日, 租户, 渠道, 供给项）聚合 sale/cost/毛利（µcredits 字符串），
  `cost_missing_count` 标记成本侧降级行。中转渠道按月人工核对。
- 官方渠道按日自动比对 + 告警（批次5 slice4 已交付）：engine
  `reconcileDaily`（`packages/engine/src/gateway/reconcile-daily.ts`）——
  官方判定 = provider slug + upstream_model_name 命中 official_model_price；
  官方供给项按 settle 逐笔以官方价目重算应付成本 vs 记账
  `cost_side_credits`，偏差超 `RECONCILIATION_DEVIATION_PCT`（动态配置，
  缺省 5%）即结构化告警；中转渠道只标注（月报表口径不倒退）。挂点两个：
  worker 日 sweep `reconcile-daily`（每 24h 对前一完整 UTC 日）+ 只读
  `GET /admin/reconciliation/daily?date=YYYY-MM-DD[&threshold_pct=]`。
