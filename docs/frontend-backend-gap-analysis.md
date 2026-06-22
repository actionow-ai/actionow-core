# Actionow 前端↔后端差距与页面整理分析

> 方法论：对 `apps/api`（121 个 HTTP 端点）与 `apps/web`（23 个页面单元 + 外壳）做静态审计。
> 2 个清单代理（后端端点目录 + 前端接线图）→ 23 个逐页审计代理（接口覆盖 / 页面整理 / 样式布局三维）
> → 1 个覆盖分析代理 → 46 条高影响声明逐条对抗式验证（46/46 confirmed，0 refuted）→ 综合。
> 其中两条 P0（AppUsage margin 泄露、落地页虚构端点）已由人工独立复核确认。生成日期 2026-06-22。

## 一、总览

Actionow 后端在 admin（`/admin/*`）+ tenant（`/console/*`）+ data-plane（`/v1/*`）三个平面上提供约 **121 个端点**，但前端接入存在系统性滞后：admin API 层（`apps/web/src/lib/api/admin.ts`）与 console API 层（`consoleApi.ts`）对相当一部分能力要么完全未封装，要么封装了却零调用。经对抗式验证，确认存在 **约 20 个孤立端点**（后端有、前端无入口），包括整组 **admin M2M service tokens（POST/GET/DELETE）零 UI**、**POST /admin/provision 原子开通流程未封装**、**pricebook / modifiers / secrets 三类资源缺失编辑与删除**（CRUD 残缺），以及 **OAuth 登录端到端断裂**（无回调接收路由）。页面层面审计 **26 个页面/外壳单元**，裁决：**保留 25、合并 1（DifyImportPage → catalog 标签页）、新增 2 个 sibling（PricebookEditModal、shell 级 AccountMenu）**，无需拆分或删除。最高优先级是两类：**核心写能力缺失**（service tokens 无 UI、pricebook/modifiers 不可改删、provision 流程缺失）与**安全/正确性**（AppUsage 向租户泄露平台 margin/provider_cost、OAuth 登录断链、落地页虚构 API 端点）。

关键数字：

- 孤立端点（confirmed）：**~20**
- 残缺 CRUD 资源：**8**（modifiers / pricebook / secrets / tenants / accounts / admin tokens / route-groups[轻微] / tenant files）
- 失效前端调用（broken calls）：**0**
- 页面裁决：保留 **25** / 合并 **1** / 新增 sibling **2**

---

## 二、接口接入差距

### 高优先级（P0：缺失核心写能力 / 安全 / 流程断裂）

| 后端能力                                                                                                    | 现状                                                                                                                  | 建议落位页面                                                                                              | 优先级 |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------ |
| `POST/GET/DELETE /admin/tokens`（M2M 服务令牌全套 CRUD，`admin.controller.ts:376/391/401`）                 | 前端**零封装、零 UI**，`admin.ts` 无任何 token 方法                                                                   | 新增 admin Service-Tokens 页/标签（`features/console/` 旁 `ApiKeysPage.tsx`），mint+list+revoke           | P0     |
| `POST /admin/provision`（原子开通 tenant+account+key，`admin.controller.ts:255`）                           | `admin.ts` **未封装**，运营需手动三步（建租户→开账户→另页发 key）                                                     | `features/console/TenantsPage.tsx`（新增「Provision tenant」一键动作）                                    | P0     |
| `PATCH /admin/pricebook/:id` + `DELETE /admin/pricebook/:id`（`admin.controller.ts:645/654`）               | 价格条目**创建即不可改/删**；`admin.ts:130-136` 仅 list+create；`ResourceDetailPane.tsx:351-361` 无 rowActions        | 新增 `PricingEditModal`（镜像 `PricingModal.tsx`）+ `ResourceDetailPane.tsx` 价格表加行操作               | P0     |
| `PATCH /admin/modifiers/:id` + `DELETE /admin/modifiers/:id`（`admin.controller.ts:689/698`）               | modifier **创建即不可改/删/禁用**；`admin.ts:139` 仅 create；`ModifiersPage.tsx` 卡片无 actions                       | `features/console/ModifiersPage.tsx`（镜像 `OfficialPricesPage.tsx` 的 Drawer 编辑 + ConfirmDialog 删除） | P0     |
| `DELETE /admin/secrets/:id`（吊销凭据，`admin.controller.ts:440`）                                          | 凭据**创建后无法吊销**；`admin.ts:231-232` 仅 create+list                                                             | `features/console/ChannelEditor.tsx` 或专门凭据页加 revoke                                                | P0     |
| OAuth 登录回调（`GET /auth/oauth/:provider/callback` 返回裸 JSON token，`oauth.controller.ts:100`）         | **端到端断裂**：`routes.tsx` 无 token 接收路由，token 永不落 localStorage；`config.oauthEnabled` 默认关闭遮蔽了死代码 | 新增 `features/auth/OAuthCallbackPage`（`/auth/callback`），后端改 redirect 回 SPA                        | P0     |
| 租户看到平台 margin/provider_cost（`console.controller.ts` `toUsageRollupView` 返回完整 `UsageRollupView`） | `AppUsage.tsx:26-27` `Metric` 含 `'margin'`，图表对任意 group-by 渲染，**泄露平台对该租户的加价**                     | `features/app/AppUsage.tsx`（移除 margin 指标；后端建议 console 层 strip provider_cost/margin）           | P0     |

### 中优先级（P1：覆盖补齐、分页、二级 CRUD）

| 后端能力                                                                                            | 现状                                                                                                                                                                                                                | 建议落位页面                                                                       | 优先级 |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------ |
| `GET /admin/dify` + `PATCH/DELETE /admin/dify/:resourceId`（`admin-dify.controller.ts:98/108/117`） | `DifyImportPage.tsx` **仅 import**，无法查看/改/删已导入绑定；`admin.ts:144-145` 仅 `difyImport`                                                                                                                    | 合并进 catalog 标签（`catalog?tab=dify`），DataTable 列出绑定 + 行 PATCH/DELETE    | P1     |
| `difyImportSchema` 的 `serviceKeyRef` + `allowBlockers`（`catalog-requests.ts:186-194`）            | 表单未发这两字段；blocked workflow **无法导入**（后端 422），无法绑 service key；i18n `dify.form.allowBlockers` 已存在却无控件                                                                                      | `features/console/DifyImportPage.tsx`（补两个控件）                                | P1     |
| `PATCH /admin/tenants/:id`（改 isolation mode，`admin.controller.ts:281`）                          | `admin.ts` **无 `updateTenant`**；`TenantsPage.tsx:234-236` isolation 只读                                                                                                                                          | `features/console/TenantsPage.tsx`（加 `api.updateTenant` + Drawer 编辑表单）      | P1     |
| `AppUsage` 的 from/to 日期范围（`console.dto.ts:33-37` 端到端已通）                                 | `AppUsage.tsx:38-42` 只传 `{groupBy}`，租户**无法按账期筛选**                                                                                                                                                       | `features/app/AppUsage.tsx`（镜像 `AnalyticsPage.tsx:228-255` 日期选择器）         | P1     |
| 全局/跨页分页（keyset cursor，多端点 DEFAULT_LIMIT=50）                                             | 多页**只取首页 .rows、丢弃 nextCursor**：`ApiKeysPage`、`RedemptionCodesPage`（单批可发 1000 码！）、`AppMedia`、`AppKeys`、`AppBilling`、`OAuthSessionsPage`、`ModifiersPage`、`TenantsPage`、`OfficialPricesPage` | 各页改 `useInfiniteQuery`+Load-more（house pattern：`AppUsage.tsx:45-51,193-203`） | P1     |
| dimensional bucket 名称解析（`AnalyticsPage` tenant/channel/api_key 显示裸 UUID）                   | `usage.ts:140-144` 返回 UUID，下游不解析；3/5 group-by 不可读                                                                                                                                                       | `features/console/AnalyticsPage.tsx`（用 `TenantSelect` 同源 id→name 映射）        | P1     |
| `jobId` / `channelId` 过滤 + 深链（`admin.dto.ts:148/151`，FE/admin.ts 已传）                       | `RelayTracesPage` **无控件**；Job 行/Analytics-by-channel 行**无深链**预置 `?jobId=`/`?channelId=`                                                                                                                  | `RelayTracesPage.tsx` 加过滤控件 + `DashboardPage`/`AnalyticsPage` 行点击深链      | P1     |
| `GET /admin/ledger`（租户流水，`admin.controller.ts:797`）                                          | `admin.ts:318` 定义 `listLedger` 但**零调用**                                                                                                                                                                       | `features/console/TenantsPage.tsx`（TenantDetailDrawer 加流水标签）                | P1     |
| `GET /admin/usage`（全局逐次调用日志，`admin.controller.ts:965`）                                   | `admin.ts:290` 定义 `listUsage` 但**零调用**                                                                                                                                                                        | `AnalyticsPage.tsx` drill-down 或 `RelayTracesPage.tsx` sibling 标签               | P1     |
| `GET /admin/payments`（admin 视角支付意图，`admin-payments.controller.ts:20`）                      | `admin.ts:324` 定义 `listPayments(tenantId)` 但**零调用**                                                                                                                                                           | `features/console/TenantsPage.tsx`（TenantDetailDrawer 加支付历史标签）            | P1     |
| 租户建 key 时的 `resourceAllowlist`+`rateLimit`（`console-requests.ts:22`，端到端已通）             | `AppKeys.tsx:33` 硬编码 `createApiKey({})`；卡片渲染了 rate_limit/allowlist chip 却**永远是死 UI**                                                                                                                  | `features/app/AppKeys.tsx`（加 mint Modal，镜像 `ApiKeysPage.tsx:155-175`）        | P1     |
| `capabilities` 字段（`/console/models` 返回，`console-views.ts:51`）                                | `AppModels.tsx:23-47` cols 丢弃 capabilities（租户选模型最关键信息）                                                                                                                                                | `features/app/AppModels.tsx`（加 capabilities 列，复用 `enums.ts:98-104`）         | P1     |
| 支付状态轮询/确认（console 无 `GET /console/payments/intents/:id`）                                 | `AppBilling.tsx` 创建意图后**无任何确认**；history 不在返回时 invalidate                                                                                                                                            | 后端补 console 单意图状态端点 + `AppBilling.tsx` 轮询/聚焦刷新                     | P1     |
| 租户文件上传（`POST /v1/files/presign-upload`+`/confirm`，data-plane）                              | `AppMedia.tsx` **只 list 不能传**；console 无等价端点                                                                                                                                                               | 后端补 console 上传端点 + `features/app/AppMedia.tsx` 加上传按钮                   | P1     |

### 低优先级（P2：单资源 GET 规范化、补强字段）

| 后端能力                                                             | 现状                                                       | 建议落位页面                                       | 优先级 |
| -------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------- | ------ |
| `GET /admin/tenants/:id`、`GET /admin/accounts/:id`                  | 未用；Drawer 从 list 行 join 派生（可能 stale）            | `TenantsPage.tsx` Drawer 用 canonical GET hydrate  | P2     |
| `GET /admin/{modifiers,pricebook,secrets,route-groups}/:id`          | `getRouteGroup` 等定义/未用，编辑表单复用 list 行          | 各编辑表单改用单资源 GET                           | P2     |
| `POST /auth/link/:provider`（绑定第三方身份）                        | 全前端**无 UI**                                            | `features/app/AppSettings.tsx`（账户绑定区）       | P2     |
| OfficialPrices 的 `updated_by`、`cached_input_price_per_1m`、`notes` | 返回但表格未显示                                           | `OfficialPricesPage.tsx`（补审计列）               | P2     |
| modifiers 的 `stackable`/`active`/`when_expr`/`version`              | create 表单/卡片均未暴露                                   | `ModifiersPage.tsx`（补字段）                      | P2     |
| RedemptionCodes 的 `redeemed_at` + expired 状态着色                  | 未渲染；`statusTone` 无 unused/redeemed/expired 映射，全灰 | `RedemptionCodesPage.tsx` + `StatusBadge.tsx:5-16` | P2     |

---

## 三、页面整理建议

### 总表

| 页面                                                 | 裁决                                | 理由                                                           |
| ---------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------- |
| DashboardPage.tsx                                    | 保留                                | 117 LOC，与 Analytics 职责清晰，应**充实**而非重构             |
| AnalyticsPage.tsx                                    | 保留                                | 单一职责，图表/表格已抽离，BigInt 安全                         |
| RelayTracesPage.tsx                                  | 保留                                | 206 LOC，已委托 TraceViewer；缺口是深链（覆盖问题）            |
| CatalogPage / ResourcesPage / ModelsPage             | 保留                                | shell+tab 设计正确，旧路由重定向已接                           |
| Catalog editors（ResourceDetailPane 等 5 个）        | 保留 + **新增 sibling**             | 缺 PricebookEditModal（覆盖能力）                              |
| ModifiersPage.tsx                                    | 保留（**就地补全**）                | 镜像 OfficialPricesPage 补 edit/delete                         |
| RouteGroupsPage.tsx                                  | 保留                                | 483 LOC 但 membership drawer 需 group 上下文，不宜拆           |
| OfficialPricesPage.tsx                               | 保留                                | 409 LOC 单一 CRUD，是 billing 组完整范本                       |
| **DifyImportPage.tsx**                               | **合并**                            | 70 LOC 仅 import、死胡同，后端有完整 CRUD；nav 已归 catalog 组 |
| OAuthSessionsPage.tsx                                | 保留                                | 298 LOC 单一域，已有测试                                       |
| TenantsPage.tsx                                      | 保留（**补全** provision+edit）     | Tenants+Accounts 合并是有意为之                                |
| ApiKeysPage.tsx                                      | 保留                                | 与 AppKeys 是不同 auth 平面，不可合并                          |
| RedemptionCodesPage.tsx                              | 保留                                | 190 LOC 单一职责，DS 规范                                      |
| AppOverview/Usage/Media/Models/Keys/Billing/Settings | 保留                                | 均单一职责；AppUsage↔Analytics 是有意的 admin/tenant 镜像      |
| AuthPage.tsx                                         | 保留                                | 351 LOC；OAuth 回调页为延迟 sibling                            |
| LandingPage + components/landing/\*                  | 保留                                | 31 LOC 组合 shell，section 已拆分                              |
| Console shell/chrome（6 文件）                       | 保留 + **新增 AccountMenu sibling** | 缺 shell 级身份展示                                            |

### 裁决≠保留的逐条展开

**合并：DifyImportPage.tsx → `catalog?tab=dify`** — 70 LOC 纯 import 表单，后端有完整 list/patch/delete，运营导入后看不到/改不了/删不掉。折叠为 catalog 第三个 tab（DataTable + 行 PATCH/DELETE + import drawer），同时补 `serviceKeyRef`/`allowBlockers` 控件。一步关闭「合并」+「CRUD 缺口」。

**新增 sibling 1：PricebookEditModal** — 镜像 `PricingModal.tsx`，配合 `admin.ts` 加 `updatePricebook`/`deletePricebook`/`getPricebook`，并在 `ResourceDetailPane.tsx` 价格 DataTable（351-361）接 rowActions（仿同文件 channels rowActions 285-315）。

**新增 sibling 2：shell 级 AccountMenu（`components/console/chrome/AccountMenu.tsx`）** — 整个 shell 不渲染登录身份，唯一账户入口是登出图标。消费 `/console/me`（`ConsoleMeView` 仅含 id/email/role/tenant_id，无 display name/tenant name），在 Rail（桌面）+ TopBar mobile 渲染身份 + 下拉到 settings/logout。

---

## 四、样式与布局排版评估

### 跨页面共性问题（优先系统性修复）

1. **手搓 money 格式化绕过 `Money` 组件（高频）** — `ResourceDetailPane.tsx:157-166`、`ModelsPage.tsx:163-187`、`AppBilling.tsx:88`、`AppOverview.tsx:68-76`、`AppUsage.tsx:56-61`。修复：金额一律走 `Money`（µUSD）；为 `Money` 加 `signed`/`tone` 变体；新增 `UsdPer1M` 与法币 minor-unit 格式化组件（BigInt 安全）。
2. **status 不走单源 `StatusBadge`** — `AppBilling.tsx:26-30` 自建 `payTone`；`RedemptionCodesPage` 三状态全渲染灰（`StatusBadge.tsx:5-16` 缺映射）；`ModelsPage.tsx:191-206`、`TenantsPage.tsx:99/234` 裸 inline chip。
3. **日期/时间无共享格式化器** — `toLocaleString()` 散落 `AppOverview`/`AppUsage`/`AppBilling:74`/`AppMedia:175`/`RelayTracesPage:62`/`ApiKeysPage:133`。抽 `<Time>`/RelativeTime DS 组件。
4. **空状态/日期输入手搓重复** — 多页手搓 `.panel` 空状态而非共享 `EmptyState`；`AnalyticsPage:218-255`/`RelayTracesPage:141-167`/`OfficialPricesPage:213-247` 裸 `<input type="date">` 而非 DS `DateField`。
5. **inline style 魔法值绕过 token** — `width:200` 反复（`DashboardPage:52`/`AnalyticsPage`/`RelayTracesPage:47/126`/`ApiKeysPage:108/136`）；`AppMedia:47` `width:160`；`AppBilling:109` `maxWidth:460`。抽 `.stack`/`.col` 工具类 + 共享 filter-slot 宽度常量。

### 按页面的高优先级具体问题

- **ResourceDetailPane.tsx（高）** — 价格表 `active` 列渲染 `StatusBadge` 暗示可交互，但 `351-361` **无任何 edit/delete/toggle**，是死胡同 affordance。`248-257` 资源状态 select 把非 active 静默改写为 disabled。
- **CatalogPage.tsx（中）** — `57-117` 手搓整个 tablist（role/roving tabindex/方向键），文件自承 "mirrors ui/Tabs"，应直接复用 `components/ui/Tabs`。
- **Nav.tsx（高，落地页）** — `:71`/`:124` 主 CTA 指向 `to="/console"`（admin-only）；已登录非 admin 租户会被弹到 `/app`（错路由）。改指 `/login` 或 `homePath(user)`。
- **LiveConsole.tsx（高，落地页）** — `:18` `POST /v1/video/generations`、`:21` `POST /v1/embeddings` **两个后端不存在的端点**（video 走 `v1/run`+`v1/jobs` 异步；embeddings 全无）。对外虚假能力声明，需删改为真实端点。
- **ModifiersPage.tsx（中）** — EntityCard 无 `actions`（`88-99`），整个卡网格非交互；`value` 输入无 op 单位提示。
- **ConsoleLayout/chrome（中）** — 单 md(768px) 断点，**移动端无 Rail 无 SubNav**，admin 13 叶路由仅 4 个进 BottomTabs，多页移动端仅能深链到达。`TopBar.tsx:85-97` refresh 用裸 `<button>` 而非 `IconButton`，且无参 `invalidateQueries()` 清空整缓存。
- **AppBilling.tsx（中）** — `190-201` QR checkout 渲染为裸 mono 字符串而非二维码图像（桌面无法扫文本）。
- **AnalyticsPage.tsx（中）** — `MetricBarChart` 截断 UUID 且无 title/tooltip（`MetricBarChart.tsx:52-62`）。
- **AppKeys.tsx（中）** — mint 为零配置一键动作（`58-65`），应改 Modal；`:124` 警告文案误用 `var(--run)`（job 状态色）作语义警告，应 `--warn`/`--fail`。

---

## 五、优先级路线图

### P0 — 破坏性 / 缺失核心功能 / 安全（先做）

1. **安全：AppUsage 移除 margin 指标**（`AppUsage.tsx:26-27`），后端 console 层 strip `provider_cost`/`margin`，停止向租户泄露加价。
2. **修复 OAuth 端到端断链**：新增 `features/auth/OAuthCallbackPage`（`/auth/callback`）+ 后端 redirect 回 SPA；或明确门控标注未完成。
3. **落地页虚构端点**：`LiveConsole.tsx:18/21` 删改；`Nav.tsx:71/124` CTA 改 `homePath(user)`/`/login`。
4. **Admin Service Tokens 全新页**：`admin.ts` 加 mint/list/revoke + 新页/标签接 `POST/GET/DELETE /admin/tokens`。
5. **Pricebook 可改/删**：`admin.ts` 加 `updatePricebook`/`deletePricebook`/`getPricebook` + `PricebookEditModal` + `ResourceDetailPane` 价格表 rowActions。
6. **Modifiers 可改/删/禁用**：`admin.ts` 加 `updateModifier`/`deleteModifier` + `ModifiersPage` 镜像 OfficialPrices 的 Drawer+ConfirmDialog。
7. **Secrets 可吊销**：`admin.ts` 加 `deleteSecret` + revoke 动作。
8. **Provision 一键开通**：`admin.ts` 加 `provision` + `TenantsPage` 新增动作。

### P1 — 覆盖补齐 + 页面整理

1. **统一分页**：`ApiKeysPage`/`RedemptionCodesPage`/`AppMedia`/`AppKeys`/`AppBilling`/`OAuthSessionsPage`/`ModifiersPage`/`TenantsPage`/`OfficialPricesPage` 全改 `useInfiniteQuery`+Load-more。RedemptionCodes（单批 1000 码、默认页 50）优先级最高。
2. **DifyImportPage 合并入 catalog tab**：list/edit/delete 绑定 + 补 `serviceKeyRef`/`allowBlockers`。
3. **Tenants 补全**：`updateTenant`（改 isolation）+ Drawer 加 ledger/payments 标签 + canonical GET hydrate。
4. **AppUsage 加日期范围** + StatCard 汇总（去掉 margin 卡）。
5. **AnalyticsPage UUID→name 解析** + `MetricBarChart` 加 title。
6. **RelayTraces 取证深链**：jobId/channelId 过滤 + 从 Job/Analytics 行深链。
7. **AppKeys mint Modal**（allowlist+rateLimit）+ **AppModels capabilities 列**。
8. **AppBilling**：支付状态轮询/聚焦刷新 + BalanceCard + QR 图像。

### P2 — 打磨

1. **DS 系统化**：`Money` signed/tone、`UsdPer1M`/法币格式化、共享 `<Time>`/`EmptyState`/`DateField`/`KeyValueRow`、布局工具类。
2. **status 单源化**：`StatusBadge` 补 expired/unused/redeemed tone；删 `AppBilling.payTone`；isolation_mode/visibility/role 改走 StatusBadge/Pill。
3. **CatalogPage 复用 `ui/Tabs`**；shell 移动端 sub-nav drawer + AccountMenu。
4. **TopBar refresh** 改 `IconButton` + scoped invalidate；单资源 GET hydrate。
5. **补字段**：OfficialPrices 审计列、modifiers stackable/active/when_expr、RedemptionCodes redeemed_at；`AppSettings` 加 email_verified 徽章 + OAuth 绑定 + has_password 门控。
6. **租户文件上传**（待后端 console 端点就绪后在 AppMedia 加上传）。

---

### 相关核心文件

`apps/web/src/lib/api/admin.ts`、`consoleApi.ts`、`features/console/{TenantsPage,ModifiersPage,ResourceDetailPane,DifyImportPage,AnalyticsPage,RelayTracesPage}.tsx`、`features/app/{AppUsage,AppKeys,AppModels,AppBilling,AppMedia}.tsx`、`features/auth/AuthPage.tsx`、`components/landing/{Nav,LiveConsole}.tsx`、`components/console/chrome/*`、`components/data/{StatusBadge,Money,TenantSelect}.tsx`。
