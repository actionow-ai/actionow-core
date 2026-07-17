# 接入向导五步 API walkthrough（model-supply greenfield 批次5 slice2）

设计 §10「接入向导：建厂商 → 建渠道录凭证 → 发现勾选 → 批探测 → 定价 enable →
进路由组灰度」。本批按 plan v3 R4② 砍刀口径交付：**UI 不做，五步 API 可走通 +
本文档化步骤**（CRUD 砍刀）。设计真相 =
`docs/plans/draft_2026-07-10_model-supply-greenfield.md`。

所有端点挂 `/admin/*`，需 admin JWT（`POST /admin/auth/login` 换取）：

```bash
TOKEN=$(curl -s http://localhost:4000/admin/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@actionow.local","password":"…"}' | jq -r .token)
AUTH="authorization: Bearer $TOKEN"
```

创建类 POST 均支持 `Idempotency-Key` 头（同键同体回放）。

## 第①步 建厂商（provider）

品牌 + 默认值（默认方言 ref@version 精确指向 SPI registry；官方 vs 中转在
渠道层覆盖分叉）：

```bash
PROVIDER=$(curl -s -X POST http://localhost:4000/admin/supply/providers \
  -H "$AUTH" -H 'content-type: application/json' \
  -d '{
    "slug": "openai",
    "name": "OpenAI",
    "default_dialect": { "ref": "openai", "version": "1.0.0" }
  }' | jq -r .id)
```

内建方言：`openai` / `anthropic` / `gemini` / `volc`（代码切面）+
`huimeng`（DSL pack），版本均为 `1.0.0`。

## 第②步 建渠道 + 录凭证（channel + credential）

渠道 = 一个可调用的上游接入点；`auth_scheme` 决定凭证 secret 的结构
（bearer / x_api_key / query / ak_sk / oauth）。`route_group_id` 现在就可以挂
（第⑤步的倍率折入会读它），也可以最后再 PATCH：

```bash
CHANNEL=$(curl -s -X POST http://localhost:4000/admin/supply/channels \
  -H "$AUTH" -H 'content-type: application/json' \
  -d '{
    "provider_id": "'$PROVIDER'",
    "name": "openai-main",
    "auth_scheme": "bearer",
    "base_url": "https://api.openai.com/v1",
    "route_group_id": null
  }' | jq -r .id)

curl -s -X POST http://localhost:4000/admin/supply/credentials \
  -H "$AUTH" -H 'content-type: application/json' \
  -d '{
    "channel_id": "'$CHANNEL'",
    "name": "key-1",
    "secret": { "scheme": "bearer", "api_key": "sk-…" }
  }'
```

凭证响应永远脱敏（`secret_hint` only）；同渠道可挂 N 把 key 组成 key 池。

## 第③步 发现勾选（discover）

```bash
curl -s -X POST http://localhost:4000/admin/supply/channels/$CHANNEL/discover \
  -H "$AUTH"
```

两种来源（§10 二选一，服务端自动选）：

- `dialect_discovery` — 渠道方言的 DSL pack 声明了 `discovery` 端点：走真上游
  GET（凭证池头一把 key 注入后发出），`parseDiscoveredModels` 解析。
- `catalog` — 代码切面方言（openai/anthropic/gemini/volc）或 pack 无 discovery
  声明：按 provider slug 列官方目录（`model_spec`）候选。

响应每项带 `exists_as_offering`（该渠道是否已有此 upstream 名的供给项），
勾选时据此排重：

```json
{
  "source": "catalog",
  "models": [
    {
      "upstream_model_name": "gpt-4o",
      "display_name": "GPT-4o",
      "source": "catalog",
      "exists_as_offering": false
    }
  ]
}
```

## 第④步 批建 draft + 批探测 enable

### ④a 批量建供给项（一律 draft）+ 默认铸卡

每个勾选项二选一：`model_id`（绑到已有对外模型）或 `new_model`（顺手注册一个
draft 模型；缺省 modality=text、operations=chat.completions sync+stream，
canonical 契约事后校订）。整批一个事务，任何一项撞唯一约束整批回滚 400：

```bash
curl -s -X POST http://localhost:4000/admin/supply/channels/$CHANNEL/offerings/batch \
  -H "$AUTH" -H 'content-type: application/json' \
  -d '{
    "items": [
      { "upstream_model_name": "gpt-4o", "new_model": { "name": "gpt-4o" } },
      { "upstream_model_name": "gpt-4o-mini", "model_id": "<已有模型 uuid>" }
    ]
  }'
```

- **status 无法传入**——批建一律 `draft`，`enabled` 只能经第④b 步的门（裸
  PATCH `status:'enabled'` 同样被 400 拦）。
- `fetch_profile` 缺省按方言取该模型主操作面的第一个 fetch mode（chat 方言 →
  direct，任务型媒体方言 → submit_poll）；请求级可统一覆盖。
- **默认铸卡**：模型无售价卡时按 `(provider.slug, upstream_model_name)` 匹配
  官方价目（`official_model_price`），命中则铸卡并绑定——渠道 route_group 的
  `group_ratio_bps` 倍率折入合成 spec（无组 = 10000 恒等）；匹配不上则该项
  `pricing.status = "needs_pricing"`，模型保持无卡（enable 门会拒，**永不 0 价
  上架**），响应 `needs_pricing_count` 汇总待人工定价数。

### ④b 批量 golden probe + enable（通过才可 enable）

```bash
curl -s -X POST http://localhost:4000/admin/supply/channels/$CHANNEL/offerings/probe-and-enable \
  -H "$AUTH" -H 'content-type: application/json' \
  -d '{}'   # 缺省 = 该渠道全部 draft/probing 供给项；或 {"offering_ids": ["…"]}
```

逐个走 slice1 完整门栈：needs_pricing + 3 条配置期不变量（纯检查，先跑，
不花探测预算）→ golden probe（真上游小样）→ 过则 `enabled`。响应逐项回显
verdict（`violations[]` 结构化失败原因 + `probe` 结果）与 `enabled_count`。

探测预算（R5）：平台日预算（`PROBE_DAILY_BUDGET_USD`，默认 5 USD/天）+
每供给项最小间隔（`PROBE_MIN_INTERVAL_SEC`，默认 60s）在**共享**预算闸上生效
——批量端点不另设预算也不绕过，预算拒绝表现为该项的 `golden_probe` violation
（`probe.status = "rejected"`），稍后重跑即可。探测失败的供给项停在
`probing`（诚实语义：探过没过），修好配置/上游后重跑本端点。

## 第⑤步 定价校订 + 进路由组灰度

- 未命中官方价目的模型：手动铸卡再绑定——
  `POST /admin/supply/price-cards`（或 `POST /admin/supply/models/:id/price-card/from-official`）
  → `PATCH /admin/supply/models/:id` 带 `price_card_id`；改价走
  `POST /admin/supply/price-cards/:id/versions`（卡不可变，版本是唯一改价路径）。
- 进路由组灰度：`PATCH /admin/supply/channels/$CHANNEL` 带 `route_group_id`
  （倍率、跨组 fallback 随组生效）。方言灰度按供给项逐个切 dialect 版本
  （§6 热更新一致性）。
- 模型上架：`PATCH /admin/supply/models/:id` 置 `status: "active"`
  （needs_pricing 门要求此时已有售价卡）。

## 收尾自检

```bash
curl -s "http://localhost:4000/admin/supply/offerings?channel_id=$CHANNEL&status=enabled" -H "$AUTH"
```

`enabled` 是路由消费的唯一状态；`disabled` 即时停收新请求（in-flight 任务由
任务中心跑完）。SDK 侧同序列可用 `@actionow/sdk`（openapi 单源重生成，
`/admin/supply/*` 全部带类型）。
