# 运营（Ops）标签页重构 — 设计文档

- 日期：2026-06-22
- 范围：管理员控制台 `/console` 的「运营」组三页，及其在租户 `/app` 侧的镜像
- 状态：设计已锁定，待 review → 进入实现计划

---

## 1. 背景与目标

「运营」组当前含三页：

| 路由                    | 页面     | 数据源                                                                            |
| ----------------------- | -------- | --------------------------------------------------------------------------------- |
| `/console/dashboard`    | 仪表盘   | `GET /admin/tenants`、`/admin/resources`、`/admin/analytics/usage`、`/admin/jobs` |
| `/console/analytics`    | 分析     | `GET /admin/analytics/usage`、`/admin/usage`                                      |
| `/console/relay-traces` | 中转追踪 | `GET /admin/relay-traces`                                                         |

一次深度评审（9-agent，已对抗性验证）结论：三页都是**真接入、零 mock、设计语言基本达标**的成熟骨架，问题集中在两类——(a) 数据正确性/口径，(b) 后端能力缺口；纯视觉问题只剩"密度失衡 + 大面积留白"。

本次重构目标：

1. **信息架构去重**：消除三页间的功能/信息重合。
2. **布局现代化**：单屏可达、多栏/网格（bento）、筛选随处可用。
3. **补齐运营核心指标**：模型健康、RPM、成功率、p95 延迟。
4. **修正确性硬伤**：计数少计、范围切换幻参、客户端假排序/假搜索、KPI 闪假零。
5. **角色双视角**：分析/用量组件做成"可传范围"的可复用件，同服务管理员（全平台）与租户（自己）。

非目标（明确排除）：

- 不引入"租户管理员"角色 / 租户内成员（membership）模型。当前 `role IN ('user','admin')` 保持不变。所谓"角色定制"= 管理员 `/console`（全租户，含运营专属字段）vs 租户 `/app`（仅自己，隐藏毛利/上游成本）两套视角，靠同一套组件传不同 `scope` 实现。
- 不做导出/CSV、不做告警/通知（本轮）。

---

## 2. 锁定的决策

| #   | 决策         | 选择                                                                                                                                                                           |
| --- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | 角色范围     | 管理员 + 租户两套视角，共用"可传范围"组件；中转追踪保持 admin 专属                                                                                                             |
| D2  | 信息架构     | **合并** 仪表盘 + 分析 → 单页「概览·分析」；中转追踪独立保留；租户 `/app` 用同组件做镜像                                                                                       |
| D3  | 布局         | **L1**：吸顶筛选 + Bento 网格 + 单滚动页                                                                                                                                       |
| D4  | 租户选择器   | **T1**：升级现有弹窗为富信息行（名 + ID + 余额 + 状态），修标签碰撞                                                                                                            |
| D5  | 性能指标     | 加 模型健康（默认）、RPM（当前 KPI + 趋势）、成功率、p95/avg 延迟、错误数                                                                                                      |
| D6  | 筛选重合     | **修法 A**：顶部吸顶筛选 = 唯一"分析镜头"，驱动主图表 + 表格；健康/RPM 是独立运营组件，不进筛选；主图表无独立"图类型"按钮                                                      |
| D7  | 逐次日志重合 | 管理员「概览·分析」**去掉**逐次调用日志（保留聚合 + 下钻到中转追踪）；中转追踪 = 管理员唯一逐次/排障视角；租户 `/app` **保留**逐次用量日志（含每次花费，因租户无 traces 权限） |

---

## 3. 信息架构（前 → 后）

```
现状（admin 运营组，3 页）              重构后（admin 运营组，2 页）
├─ 仪表盘     /console/dashboard        ├─ 概览·分析  /console/overview   ← 合并 dashboard+analytics
├─ 分析       /console/analytics        └─ 中转追踪   /console/relay-traces
└─ 中转追踪   /console/relay-traces

租户 /app（镜像，复用组件）
├─ 概览  /app/overview   ← 同「概览·分析」组件，scope=self，无中转追踪
└─ 用量  /app/usage      ← 含逐次用量日志（每次花费）
```

- 新路由 `/console/overview`（落地页）。`/console/dashboard` 与 `/console/analytics` → 301 重定向到 `/console/overview`，保留旧深链。
- 左栏 `nav-config.ts` 的 `ops` 组：`[{overview}, {relayTraces}]`（两项）。
- 移动端 `ADMIN_MOBILE_TABS` 同步把 `dashboard` 改为 `overview`。

---

## 4. 页面设计

### 4.1 概览·分析（admin，`/console/overview`）

L1 布局，自上而下：

1. **吸顶筛选条（唯一分析镜头，sticky）**：
   - 范围：T1 租户选择器（`全部租户` / 具体租户）。
   - 维度（groupBy）：`分钟 · 小时 · 天 | 模型 · 租户 · 渠道 · API Key`。
   - 指标（metric）：`成本 · 毛利 · 请求 · Token · 错误率 · 延迟`。
   - 日期范围。
   - 它**同时驱动主图表 + rollup 明细表**。`sticky` 定位，向下滚动仍可改（修"滚到底够不着筛选"）。
2. **KPI 带（6 格）**：模型健康徽标 · RPM 当前 · 成功率 · p95 延迟 · 成本 · 毛利。整组包进 `QueryBoundary`，加载/失败时不渲染假零。
3. **Bento（2 列）**：
   - 左（2fr）**主图表**：完全由顶部筛选决定——维度=时间 → 趋势线（`TimeSeriesChart`），维度=实体 → 柱状（`MetricBarChart`）。**无独立图类型按钮**。空/单点有专门空态（不再是孤点悬浮）。
   - 右（1fr）**模型健康卡**（常驻、独立运营组件，不受 维度/指标/日期 影响）：按渠道列出 健康/熔断中（带冷却倒计时+连败数）/需重新授权（oauth 过期）/已停用；页头取"最差"聚合徽标；每行点击 → `/console/relay-traces?channelId=…`。
4. **按成本排名 · 模型**（`RankingBar`，原仪表盘排名并入此处，去重）。
5. **rollup 明细表**（`DataTable`，镜头驱动）：分桶/模型 + 请求 + 成本 + 毛利 + 成功率 + p95 + 错误；数字列右对齐 + 等宽数字；列宽固定/弹性混合。channel 桶可下钻到 relay-traces。
6. **（移除）逐次调用日志**：见 D7。从 rollup 行提供「查看调用」下钻 → `/console/relay-traces`（带筛选）。

> 真实计数：KPI 的"租户/资源"必须是真实总数（见 §6 修复）。

### 4.2 中转追踪（admin，`/console/relay-traces`）

沿用吸顶筛选；修评审发现的问题：

- **吸顶筛选条**：范围（T1）+ Provider（**改下拉 Select**，源自已知 provider 枚举；后端是严格 `eq` 匹配，自由文本打错=0 行）+ 任务 ID + 渠道 ID + 日期范围 + **「仅看错误」/「状态」过滤**（后端小改）。裸 `<input>` → `FormField`（补 label/aria）；修"起 起 止 止"重复标签（装饰 span + DateField 自带 label 重复）。输入加 debounce；日期窗时区与显示一致；筛选宽度自适应（不再固定 `width:200`）。
- **表格**：列 时间/Provider/**租户·任务·渠道（新，截断 mono id，点击即筛，可隐藏）**/方法/状态/延迟/URL。**去掉**误导性的表内 `searchable` 与 latency `sortable`（无限分页下只作用已加载页、还假报"无匹配"）。行 hover 高亮 + 手型指针（点击提示）。翻页用 `LoadMore` 原语。
- **TraceViewer 抽屉**（已做得好，仅补）：id/URL/请求体/响应体 加复制按钮（复用已有 `CopyField`）。

### 4.3 租户镜像（tenant，`/app/overview` + `/app/usage`）

- 复用同一套分析/用量组件，`scope=self`（数据走租户态 console API，按 JWT 天然限定本租户，无 `tenantId` 参数 → 无幻参问题）。
- **隐藏运营专属字段**：毛利、上游成本（provider_cost）。
- **无**范围（租户）选择器、**无**模型健康卡（渠道是运营方基础设施）、**无**中转追踪。
- **保留**逐次用量日志（含每次花费）—— 租户唯一能看自己每次调用的地方。

---

## 5. 共享组件与改造

| 组件                                    | 改造                                                                                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TenantSelect`（T1）                    | 富信息行：名 + 截断 ID + 余额 + 状态徽标；"全部租户"独立标签、搜索框独立 placeholder（修三处 `allLabel` 碰撞）；键盘可达。需 `listTenants` 返回余额/状态（见 §7）。 |
| 分析组件（KPI 带 / 主图表 / rollup 表） | 抽成"可传 `scope` + `dimension` + `metric` + `range`"的纯展示件，admin/tenant 共用；tenant 版隐藏毛利/上游成本。                                                    |
| 模型健康卡                              | 新组件：消费 `GET /admin/health`（见 §7）；用 `StatusBadge`/`Pill`；"无 channel_health 行 = 健康"显式编码（避免全标灰）。                                           |
| RPM 当前 KPI                            | 后端就绪前用 relay-traces 近 60s 估值并标注「上游 RPM（近似）」；后端就绪后切真实 billable RPM。                                                                    |
| 图表 tooltip                            | 用 portal / `overflow: visible`，修 hover 时被父容器裁剪。                                                                                                          |
| `DataTable`                             | 数字列右对齐 + 等宽；列宽固定/弹性策略；行点击 affordance。                                                                                                         |
| `SegmentedControl`                      | 顶部 维度/指标 切换复用。                                                                                                                                           |

---

## 6. 正确性修复（评审 P0/P1，并入本次）

1. **真实计数**：「租户/资源」KPI 不能再取第一页 `.length`。真值来源 = 后端 `counts/summary`（§7.9，阶段1）。阶段0 在端点就绪前**不得显示权威错误数**：若分页 envelope 已带 `total` 则用之；否则以"首页计数 + `+` 后缀"明示为下限，不冒充总数。
2. **范围切换幻参**：管理员逐次日志已按 D7 移除，对应 `/admin/usage` 传 `tenantId` 被后端忽略的 P0 自然消失。rollup 的 `tenantId` 后端本就支持，范围筛选有效。
3. **KPI 加载边界**：totals KPI 包进 `QueryBoundary`，失败/未就绪不渲染假 `0/$0`。
4. **移除假排序/假搜索**：relay-traces 表的 `searchable` 与 latency `sortable`（无限分页上不可信）去除。

---

## 7. 后端改动（最小、分阶段、多数无迁移）

按依赖顺序：

1. **rollup 加延迟**（解锁 p95/avg，最小）：`packages/db/src/repositories/usage.ts` 的 `rollupUsage` SELECT 加 `avg(latency_ms)` + `percentile_cont(0.95) within group (order by latency_ms)`；`RawRollupRow`/`UsageRollupRow` 加字段。
2. **延迟入契约**：`packages/contracts/src/ops-views.ts` 的 `usageRollupViewSchema` + `toUsageRollupView`（`admin.controller.ts`）加 `avg_latency_ms`/`p95_latency_ms`；重生 `@actionow/sdk`。
3. **子日分桶（RPM 趋势）**：`bucketExpr`（`usage.ts`）加 `'hour'`/`'minute'`；`UsageRollupQuery.groupBy` union + `analyticsUsageQuerySchema` enum（`admin.dto.ts`）加之。无迁移。FE 须对空桶**零填充**。
4. **渠道健康只读**：`packages/db/src/repositories/catalog.ts` 加 `listChannelHealth()`（返回 `channel_id, cooldown_until, consecutive_failures, last_failure_at`，源 `channel_health` 表）。
5. **`GET /admin/health` 只读端点**（当前不存在）：组装 `{ window, rpm_billable（usage_log count over from/to）, channels:[{channel_id, provider_type, operator_status, live:'healthy'|'cooling', cooldown_until, consecutive_failures}]（upstream_channel ⟕ listChannelHealth）, 含 oauth_session.status/expires_at }`。FE 加对应 `admin.ts` 方法 + contract view。**只做读取组装，不引入第二套指标聚合**（避免与 analytics 分叉）。
6. **relay-traces 状态/错误过滤**：`relayTraceQuerySchema`（`admin.dto.ts`）+ repo `RelayTraceFilter`（`packages/db/src/repositories/relay-trace.ts`）加 `response_status` 范围 + `error`/`is_stream` 布尔。
7. **（可选）租户镜像 p95**：把 avg/p95 镜像进 `consoleUsageRollupViewSchema` + `toConsoleUsageRollupView`，**保持 provider_cost/margin 剥离**。
8. **（D6 配套）真实 RPM**：`listUsageLogsGlobal` 加 `from/to`，供 `rpm_billable` 计数。
9. **真实计数**：加 `GET /admin/summary`（或并入 `/admin/health`）返回 `{ tenants, resources, accounts }` 等总数（`count(*)`），供 KPI 真值；FE 加 `admin.ts` 方法。修 `listTenants`/`listResources` 至少返回完整 `Page`（保留 cursor），不再 `.rows`-only。

---

## 8. 交付顺序

**阶段 0 — 纯前端，立即可上（零后端）**

- 路由合并（`/console/overview` + 重定向）、nav 调整。
- L1 布局 + 吸顶筛选（修法 A 单镜头）+ Bento + KPI 带 + QueryBoundary。
- 合并排名、移除管理员逐次日志（下钻到 traces）、rollup 明细表整治（右对齐/等宽/列宽）。
- T1 租户选择器（先用现有 `listTenants` 字段，余额/状态待 §7 后补）。
- 成功率 + 错误数（analytics 已返回 requests+errors，groupBy model/channel）。
- 静态健康卡降级版：渠道 `active/disabled` + oauth `needs_reauth/expired`（已暴露），**标注"近似/静态"**。
- 「上游 RPM（近似）」KPI（relay-traces 近 60s，标注偏高）。
- relay-traces：去假搜索/假排序、Provider 下拉、FormField、修重复标签、行点击提示、LoadMore、debounce、TraceViewer 复制、列加 租户/任务/渠道。
- 图表 tooltip portal 修复。
- 计数 KPI：阶段0 用 envelope `total` 或"首页计数 + `+`"明示下限（不冒充总数）；真值随 §7.9 端点（阶段1）。

**阶段 1 — 后端小改随后补**

- §7.1–7.3：rollup 延迟 + 子日分桶 → 真 p95/avg、RPM 趋势。
- §7.4–7.5、7.8：`GET /admin/health` + 真实 billable RPM → 模型健康卡/RPM 当前切真实数据源，去掉"近似"标注。
- §7.6：relay-traces 状态/错误过滤 → 「仅看错误」生效。
- §7.7：租户镜像 p95。

---

## 9. 指标定义

| 指标         | 定义/阈值                                                                                                                                                                                             | 单位      | 可行性             |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------ |
| 模型健康     | 按渠道：无 `channel_health` 行或 `cooldown_until<=now`→健康；`cooldown_until>now`→熔断中(显倒计时+连败)；`status='disabled'`→已停用(灰，最高优先)；oauth `needs_reauth`/过期→需重新授权。页头取最差。 | 状态      | 后端小改           |
| RPM 当前     | 近 60s 计费请求数，与上一分钟比箭头。降级=relay-traces 近 60s（标"上游 RPM 近似"）。                                                                                                                  | req/min   | FE 近似 / 后端精确 |
| RPM 趋势     | 每分钟一点（默认近 60 分钟）；**空桶客户端零填充**。                                                                                                                                                  | req/min   | 后端小改           |
| 成功率       | `(requests-errors)/requests`；阈值 ≥99% 绿 / 95–99% 橙 / <95% 红；样本 `n<20` 显"样本不足"。                                                                                                          | %（带 n） | FE 现成            |
| p95/avg 延迟 | `percentile_cont(0.95)` / `avg`，按桶；阈值 p95 <2s 绿 / 2–5s 橙 / >5s 红（**可配置**，媒体/视频渠道天然高延迟）。                                                                                    | ms        | 后端小改           |
| 错误数       | `count filter (status<>'succeeded')`；>0 红。                                                                                                                                                         | 次        | FE 现成            |

---

## 10. 风险

- **RPM 近似偏高**：relay-traces 计上游调用，priority-fallback 下虚高 → 标注"上游 RPM"，真实值用 §7.8。
- **零填充陷阱**：分钟/小时 rollup 只出有流量的桶，FE 忘记零填充会让趋势线虚假连续。
- **小样本噪声**：成功率/p95 在 `n` 很小时失真 → 着色需样本下限并显分母。
- **健康语义反转**：`channel_health` 行缺失=健康，不可映射成"未知/灰"。
- **阈值硬编码**：p95、成功率阈值应可配置，否则误报慢但正常的媒体渠道。
- **租户泄漏**：租户镜像 view 绝不可带 provider_cost/margin；只镜像 avg/p95 延迟。
- **端点分叉**：`GET /admin/health` 仅做只读组装，不新增第二套聚合。

---

## 11. 测试

- 组件单测：T1 选择器（标签/搜索/键盘）、模型健康卡（四种状态 + "无行=健康" + 最差聚合）、主图表镜头映射（时间→趋势 / 实体→柱）、RPM 零填充、成功率小样本"样本不足"。
- 集成：路由重定向（dashboard/analytics → overview）、范围切换驱动图表+表、relay-traces「仅看错误」过滤。
- 回归：移除假搜索/假排序后 relay-traces 行为；KPI QueryBoundary 失败态不渲染假零；真实计数跨页。
- 角色：tenant `/app` 镜像不出现 毛利/上游成本/健康卡/范围选择器。

---

## 12. 受影响文件（索引，非穷尽）

- 前端：`apps/web/src/routes.tsx`、`components/console/nav-config.ts`、`features/console/{DashboardPage,AnalyticsPage,RelayTracesPage}.tsx`（→ 合并/重写）、`features/app/{AppOverview,AppUsage}.tsx`、`components/data/{TenantSelect,TimeSeriesChart,MetricBarChart,DataTable,TraceViewer,LoadMore,StatCard,RankingBar}.tsx`、`lib/api/admin.ts`、`lib/api/consoleApi.ts`、`i18n/locales/*/console.json`。
- 后端：`packages/db/src/repositories/{usage,catalog,relay-trace}.ts`、`packages/contracts/src/{ops-views,console-views}.ts`、`apps/api/src/admin/{admin.controller,admin.dto}.ts`、`apps/api/src/console/*`、`@actionow/sdk` 重生。

---

## 13. 实现说明（与设计的差异）

实现于 2026-06-22（分支 `feat/ops-tab-redesign`）。全量 typecheck/lint/test 通过，端点已对运行实例验证。与上文设计的几处有意取舍：

1. **KPI 的 p95 → 改为"平均延迟"**：跨桶的 p95 无法由各桶 p95 聚合得出（数学上不成立），故 KPI 带显示**加权平均延迟**（按 requests 加权，正确），**精确 p95 作为 rollup 明细表的逐桶列**（每桶精确）。
2. **模型健康的 oauth 重授权叠加在前端完成**：`GET /admin/health` 返回渠道熔断器状态 + `credential_ref`；前端用已有的 `GET /admin/oauth-sessions` 按 `credential_ref` 关联出"需重新授权"，避免后端再 join oauth（端点保持纯只读组装）。
3. **真实计数走 `GET /admin/summary`**：未改动 `listTenants/listResources` 的返回（仍 `.rows`，多处调用方依赖），计数 P0 由新 summary 端点解决。
4. **Provider 过滤用 ComboboxField（建议+自由文本）**而非严格 Select：渠道含非枚举 provider（codex-oauth/seedream 等），ComboboxField 给出 `COMMON_PROVIDERS ∪ 已见 provider` 建议同时不锁死未知值。
5. **租户镜像范围**：本轮 `/app/用量` 已复用同一套图表/表格组件并补齐延迟列 + 格式化 tooltip（contracts 已镜像 avg/p95）；`/app/概览`（租户首页）未重建为完整 bento —— 它是租户落地页，非本轮运营 tab 视觉重点，留待后续。
6. **DataTable 新增 `align` 列对齐**（数字列右对齐 + 等宽）作为共享原语能力；图表 tooltip 改为 overflow-visible 叠层（修遮挡）。
