# Actionow 前端设计深度评审（2026-06-19）

> 由 24 个并行 agent 对全部 20 个前端面（公开页 / 租户 `/app` / 管理 `/console` / 外壳）逐面评审生成：样式、布局、排版、内容合理性、组件合理性、页面合并/拆分（IA）。每面打 verdict + 复用分，再做跨页 IA 与一致性综合。

## 总览

Actionow 前端整体处于**「骨架优秀、内容半成品」**的状态：外壳架构（ConsoleLayout 可换 nav 集、admin/tenant 共用骨架）是反重复的正解，设计系统 token 化程度高，绝大多数页面正确复用了共享原语（DataTable / CardCollection / Modal / Money / StatusBadge 等），没有蓝色违规、emoji 或大面积裸样式。真正拖后腿的不是视觉，而是**三类系统性缺陷**：(1) 错误态在全代码库零覆盖——失败请求被 34 处 `?? []` 静默伪装成「暂无数据」；(2) 多个 admin 列表页停在「只读列表 + 创建 modal」的半成品 CRUD；(3) 金额/枚举/状态徽章三套口径绕过已有的统一资产（Money / enums.ts / StatusBadge）。20 个面里 18 个 needs-polish、2 个 needs-rework（Tenants、Accounts），无 ship-ready，但也无返工级——方向正确，欠的是「做厚 + 收口」。

| Surface                                           | Verdict          | Reuse |
| ------------------------------------------------- | ---------------- | ----- |
| App shell（外壳骨架）                             | needs-polish     | 4     |
| Landing（/）                                      | needs-polish     | 3     |
| Auth（/login）                                    | needs-polish     | 4     |
| Tenant Overview（/app/overview）                  | needs-polish     | 4     |
| Tenant Usage（/app/usage）                        | needs-polish     | 4     |
| Tenant Models（/app/models）                      | needs-polish     | 4     |
| Tenant API Keys（/app/keys）                      | needs-polish     | 5     |
| Tenant Billing（/app/billing）                    | needs-polish     | 4     |
| Tenant Settings（/app/settings）                  | needs-polish     | 4     |
| Admin Dashboard（/console/dashboard）             | needs-polish     | 5     |
| Admin Analytics（/console/analytics）             | needs-polish     | 4     |
| Admin Relay Traces（/console/relay-traces）       | needs-polish     | 4     |
| Admin Catalog（/console/catalog）                 | needs-polish     | 4     |
| Admin Modifiers（/console/modifiers）             | needs-polish     | 4     |
| Admin Route Groups（/console/groups）             | needs-polish     | 5     |
| Admin Official Prices（/console/official-prices） | needs-polish     | 4     |
| Admin Dify Import（/console/dify）                | needs-polish     | 3     |
| **Admin Tenants（/console/tenants）**             | **needs-rework** | 5     |
| **Admin Accounts（/console/accounts）**           | **needs-rework** | 3     |
| Admin API Keys（/console/api-keys）               | needs-polish     | 4     |

---

## 最高优先级问题

按「影响面 × 修复杠杆」排序。前 5 项是跨全站的系统级缺陷，后续是高价值的单/多页修复。

### 1. 错误态系统性缺失——失败被伪装成空数据 `[critical]`

全代码库 `isError` 0 次、`refetch` 0 次、零重试按钮；19 个 feature 文件 34 处 `?? []` 把 query 失败吞成空数组，余额失败退化成大号 `'0'`（把未知当零余额），me 失败退化成 `'—'`。用户无法区分「加载中 / 真的没有 / 失败」。

- **修复**：抽统一 `<QueryBoundary>/<AsyncSection>`（或 `useListQuery` hook），集中处理 loading 骨架 / `<ErrorState onRetry={refetch}>` / empty 三态；全局禁用 `?? []` 兜底失败。这是唯一能一次性消灭头号缺陷的抽取。
- **影响页**：几乎全部数据驱动页（Overview / Usage / Models / Keys / Billing / Settings / Analytics / RelayTraces / Tenants / Dashboard…）。

### 2. 金额展示口径不统一——µUSD/`<Money>` 硬规则被绕过 `[high]`

AppBilling 用 `(Number(amount_minor)/100).toFixed(2)`、ResourceDetailPane 用 `$${Number(m)/1_000_000}.toFixed(2)`、OfficialPrices/Modifiers 用裸字符串/自由文本。三种除数、丢 BigInt 安全、丢本地化。全树仅 6 个文件用 `<Money>`。

- **修复**：强制所有金额走 `<Money micro={…}>`，删除手搓 `toFixed`；Modifiers 按 op 量纲渲染（金额型→`<Money>`、百分比→`%` 后缀、倍率→`×` 前缀）；加 lint 规则禁止对金额字段直接 `toFixed`。
- **影响页**：AppBilling、Catalog（ResourceDetailPane）、Official Prices、Modifiers。

### 3. 两个 needs-rework 半成品 CRUD：Accounts + Tenants `[critical]`

Accounts 无 `listAccounts/getAccount` 端点，只能展示「本会话刚 create 的那一个账户」，刷新即丢，空状态文案「或选择已有账户充值」与实现直接矛盾，`credit_held` 有 i18n 标签却从不展示。Tenants 只能「列出 + 新建」，卡片不可点、无详情/编辑/删除、不显 tenant id 与任何派生指标。

- **修复**：见「页面合并建议 #1」——把 Accounts 合并进 Tenants 详情抽屉，一刀治好两处 rework。需后端补 `GET /admin/accounts`。
- **影响页**：Tenants、Accounts。

### 4. 枚举值未走已有 i18n，zh-CN 显示生硬英文 `[high]`

`lib/api/enums.ts` 已为 modality/visibility/capability/op 定义 labelKey，但 AppModels（`cell:(r)=>r.modality`）、AppUsage、Modifiers、Dify 直出原始英文常量。翻译资产已就绪却未消费，低成本高收益。

- **修复**：提供统一 `enumLabel(t, kind, value)` 或 `<EnumLabel>`，内部读 enums.ts labelKey；所有枚举渲染改走它。
- **影响页**：AppModels、AppUsage、Modifiers、Dify。

### 5. 状态徽章渲染分裂——console 用 StatusBadge，app 用裸 Pill `[high]`

9 个文件用 `<StatusBadge>`（多在 console），AppModels/AppUsage/AppBilling/AppSettings/RelayTraces 用裸 `<Pill tone=…>` 并各写状态→色映射（如 AppModels `visibility==='public'?'ok':'idle'`）。同一「状态」概念无单一事实源。

- **修复**：所有「状态/可见性/激活态」收敛到 `<StatusBadge>`（内部持 enum→tone 单一映射），裸 Pill 仅留非状态标签用途。
- **影响页**：AppModels、AppUsage、AppBilling、AppSettings、RelayTraces、Dashboard、Catalog。

### 6. 加载态不统一——图表区/余额卡空白或无骨架 `[medium]`

DataTable 有统一 RoseLoader，但 AppUsage/Analytics 图表区 loading 时渲染空白 panel，BalanceCard、me 查询无骨架。31 处 `isLoading` 各自为政。

- **修复**：随 #1 的 `<AsyncSection>` 一并统一骨架约定；图表区 loading 渲染 RoseLoader 而非空字符串。
- **影响页**：AppUsage、Analytics、Overview、Settings。

### 7. Landing 页可信度风险：死链 + 无标注假指标 `[high/content]`

导航「文档」指向 `#pricing`（标签-目标错配）、定价两张卡 CTA 都是死链 `href="#"`、LiveConsole 用写死假数字（128 租户/3402 调用/$18.6k）冒充真实指标且无任何「示意」标注。对一个讲「计费透明」的产品是直接的可信度伤害。

- **修复**：文档链接绑真实 `#docs`/外链；定价 CTA self→`/login`、support→真实联系方式；LiveConsole 加 `MockBadge` 或「示意数据」副标，金额改 `Money(µUSD)` 口径。
- **影响页**：Landing。

### 8. Mock/真实数据标注双向失真 `[medium]`

LiveConsole「假装真」（无标注假数据）；RouteGroups/OfficialPrices「真装假」（审查标题仍挂 `[MOCK BACKEND]`，实际已接真实 `/admin/route-groups`、`/admin/official-prices`，无 mock 数据无 MockBadge）。

- **修复**：清理过时 `[MOCK BACKEND]` 标注；给 LiveConsole 补 MockBadge。务必在做 IA 决策前更正，避免据错误注记判断 MOCK 状态。
- **影响页**：Landing、Route Groups、Official Prices。

### 9. 即时写后端的弱交互：路由组绑定 + priority/weight `[high]`

RouteGroups 成员 priority/weight 每次 `onChange` 即触发 PUT upsert（边敲边写后端）；admin API Keys 的「绑定路由组」是 SelectField 静默写操作，无 pending/成功反馈；同时 RouteGroups 渠道计数列有 N+1 query（每行各起一个 query 拉全量成员）。

- **修复**：priority/weight 改受控本地 state + onBlur/显式保存（带保存中/已保存指示）；绑定加 `isPending` disabled + 成功 toast；channel_count 由后端聚合返回。
- **影响页**：Route Groups、Admin API Keys。

### 10. 模态 a11y 系统洞 + 触控目标下限未普及 `[medium/a11y]`

`useFocusTrap` 只 JS 拦 Tab，不对背景设 `inert`/`aria-hidden`——所有用 Modal/Drawer 的页面背景仍在可达性树内。同时 `--min-touch`(44px) 与 `.hit-slop` 已存在但未普及：ChipsField chip、Checkbox、Toggle、RowAction、移动端 DataTable 行、BottomTabs 仍低于 24/44px。

- **修复**：在 Modal/Drawer 打开时给文档其余部分加 `inert`；逐控件套用 `.hit-slop`/`--min-touch`。
- **影响页**：所有用 Modal/Drawer 的页（系统级）。

### 11. 安全关键的一次性明文密钥两端反馈不一致 `[medium]`

AppKeys（tenant）reveal 的 CopyField 未传 `failedLabel`，复制失败无差异反馈；ApiKeysPage（admin）一次性明文警告用 `--run` 琥珀而非 `--fail`，缺「仅此一次」强约束；且 mint/rotate/reveal 逻辑两端各写一遍。

- **修复**：抽 `useApiKeyLifecycle` hook + `<RevealKeyModal>`（统一 `--fail` 警告、`failedLabel`、「我已安全保存」勾选才允许关闭），两端复用。
- **影响页**：Tenant API Keys、Admin API Keys。

### 12. Auth 缺忘记密码入口 + 校验只走 toast `[high/content]`

登录页无「忘记密码」入口；invalid_input/401 等可归因到字段的错误只走一次性 toast，未用 TextField 字段级 `error`。

- **修复**：加 `Button variant="link"` 忘记密码（补 `auth.forgotPassword`）；可归因错误 `setError` 给对应 TextField，toast 仅兜底。
- **影响页**：Auth。

---

## 页面合并建议

### 合并 #1（高置信）：`/console/accounts` → Tenants 详情抽屉

Accounts 是最薄的 needs-rework（无 list/get 端点、刷新即丢、文案矛盾），账户在领域模型上天然从属于租户；Tenants 自身也是 needs-rework，其改造方向恰好是长出一个详情抽屉——该抽屉正是 accounts（balance/held/就地充值）的天然归宿。**一刀同治两处 rework。**

- **怎么做**：删除独立 `/console/accounts` 路由；EntityCard `onClick` 打开 Drawer（复用 ResourceDetailPane 模式），内嵌 `BalanceCard` 展示 `credit_balance/credit_held` + 就地充值按钮，并聚合该租户的 keys/resources/usage 计数 + 可复制 tenant id。后端补 `GET /admin/accounts`。tenants 组从 3 叶收敛为「租户中枢」入口。

### 合并 #2（中置信，有条件）：`groups + official-prices + modifiers` → `/console/pricing`（页内 tab）

三页同属「计费/定价配置」族、心智相邻，且都停在「只读列表 + 创建 modal」半成品。官方价是渠道加价基准、modifiers 在其上做命中调整、route group 驱动终端计费——同一条定价链路的三个环节。三个并列叶让 billing 组「导航重、内容轻」。

- **怎么做**：收敛为单一 `/console/pricing`，页内 tab 三段（route-groups / official-prices / modifiers），对齐 CatalogPage 已验证的「单路由 + URL-state 深链 tab」样板（复用 `ui/Tabs`，勿内联重造）。
- **前置条件**：先把三页补成完整 CRUD（尤其 modifiers 的 µUSD/Money 单位语义），清理过时 MOCK 标注。若短期仍是半成品，合并能立即减少导航碎片，优先级高于继续各自开页。

### 合并 #3（低置信）：`/app/models` → Overview「可用模型」区块（备选）

Models 极薄（4 列，无定价/capabilities，且 capabilities 已取回却被丢弃），处于「撑不起独立路由」临界。

- **倾向方案 A（做厚而非合并）**：补 capabilities（已有 `enums.capability.*` 键）+ 定价 + 行内详情 + StatusBadge，则保留独立 `/app/models`（模型参考是调用前高频查询）。
- **方案 B（合并）**：若短期不补，降级为 Overview 的「可用模型」卡片，从 home 组移除该叶。**倾向 A。**

---

## 页面拆分建议

无强拆分信号。两处轻度信号均建议「整改交互而非拆路由」：

- **`/console/groups` 的 GroupChannelsDrawer 成员管理**：主体（分组 CRUD + group_ratio 倍率）与成员管理（priority/weight）是两块职责，但抽屉目前够用。**暂不拆**——先升级抽屉交互（受控 state + onBlur/显式保存 + 保存指示），预留「未来成员策略变重时升级为分组详情子页」的演进路径。
- **`/console/catalog` 的 resource detail 单列堆叠**（overview/channels/pricing）：findings 判定为有意的「无 tab 单列」设计，信息相关、可接受。**保持现状不拆**；仅当三段都明显变长时在 detail 内做次级 tab，无需路由级拆分。明确记录为「非拆分项」。

---

## 信息架构 / 导航

外壳架构正确，无需重构。问题集中在 admin 平面的「分组语义」与「路由颗粒度」：

- **admin（当前 4 组 11 叶）**：
  - tenants 组的颗粒度错配——把从属实体 accounts 误升为与 tenants 平级的路由（见合并 #1）。
  - billing 组是导航碎片化重灾区——三叶全是半成品薄 CRUD（见合并 #2）。
  - ops 组（dashboard/analytics/relay-traces）与 catalog 组（catalog/dify）分组清晰、颗粒度恰当，**无需动**；catalog 路由内「模型 | 资源」页内 tab 是 IA 正面样板。
- **tenant（/app，2 组 6 叶）**：分组贴合开发者心智。两处小瑕——models 页过薄（见合并 #3）；overview 与 usage 是合理的「概览 vs 明细」分工，但**缺「查看全部」导流**（overview 截断 20 行会让用户误以为只有这点数据，需显式链到 /app/usage）。移动 tab（overview/usage/keys/billing）取舍正确。
- **admin↔tenant 平行性**：两端「用量分析」几乎逐行重复（同一套 SegmentedControl+TimeSeriesChart+MetricBarChart+DataTable），但受众/数据范围/权限不同（admin 跨租户看 provider_cost/margin，tenant 只看自己、**不应**看到供应商成本）——这是**组件级复用信号（抽 UsageAnalyticsShell），绝非路由合并信号**。API Keys 两端同理：共享底层 mint/reveal hook，分角色呈现，不合并。

---

## 设计系统一致性

### 审计快照已部分过时（先纠偏）

`docs/component-audit.md`（2026-06-18）把 `--z-*` token、`lib/zIndex.ts`、`--min-touch`、共享 `Floating` 原语列为「待建/缺失」，但 live 代码里它们已全部落地：theme.css 已有完整 `--z-*`(0/1/40/100/200/300/400) 与 `--min-touch:44px`；`lib/zIndex.ts` 已是单一真相源（toast 300 已正确高于模态 scrim 100，原 toast-over-modal 碰撞已修）；`ui/Floating.tsx` 已建、Tooltip 已迁移（原 Tooltip 裁切已修）。**任何照搬审计 z-index/Tooltip/min-touch 结论的判断都应以 live token 为准。**

### 抽取机会（按价值排序）

1. **`<QueryBoundary>/<AsyncSection>`**（loading/error/empty 三态 + onRetry）——消灭头号 critical，全站受益。
2. **`<UsageAnalyticsShell>`**——admin Analytics 与 tenant Usage 共享过滤栏/图表切换/chartTitle/fmtMetric，两页传入列定义 + 可见指标白名单（tenant 隐藏 provider_cost/margin），路由不合并。
3. **`<Money>` 强制化 + lint**——删手搓 toFixed。
4. **`enumLabel`/`<EnumLabel>`**——统一枚举→标签，消灭直出英文。
5. **`<StatusBadge>` 单一事实源**——收敛状态徽章。
6. **`useApiKeyLifecycle` + `<RevealKeyModal>`**——两端复用 mint/rotate/reveal。
7. **`ui/Tabs` 增 `fill`/`layout="column"` 变体**——CatalogPage 删手写版，找回 `minHeight:var(--min-touch)`。
8. **`<SlidingIndicator>` + `useLogout`（含二次确认）**——Rail/SubNav/TopBar 复用，消除外壳内部重复。
9. **后端聚合 channel_count**——消除 RouteGroups N+1。

### Token 漂移与缺口

- **字重/字距 token 集过窄**：`--fw-*` 仅 600/700/800，代码里出现 500/650/680/760/780/850（23 处字面量）；`--track-*` 仅两档，出现 18 处裸 letterSpacing em + 3 处内联 `clamp()`（硬规则禁止）。landing 与各 StatCard、CatalogPage、SubNav 是重灾区。**建议**：新增 `--fw-display`、`--fs-feature` 等 token 后统一引用；为 500/-0.01em 等高频值补 token 或收敛到现有档。
- **间距标尺缺口**：`--s-*` 缺 28/36/48/56 中间档，导致 3px/6px/10px/30px 反复 off-grid 漂移。**补常用中间档或显式记录「胶囊微 padding」例外。**
- **重叠原语边界模糊**：Pill / StatusBadge / MockBadge / `.chip` 四者职责重叠却各有微 padding（chip 2px9px、badge 3px9px，彼此 off-grid 不一致）。**明确：值/状态胶囊一律走 Pill/StatusBadge，`.chip` 仅限特定场景。**
- **字段控件状态契约漂移（S4 半成品）**：TextField/NumberField 仅设 aria-invalid 无红边、无 width:100%，而 JsonField 有红边、ChipsField/JsonField 满宽。**核实「error→红边」「width:100%」是否已下沉到 `.field`，否则 Modal 内输入框比同侪窄、sighted 用户在 Text/Number 上无视觉错误态。**
- **断点文档落后**：`CONVENTIONS.md` 只列 md768/wide880/lg960/xl1100，但 `lib/breakpoints.ts` 多出 `sm(640)`、`xxl(1280)`。**更新文档，避免页面审查误判合法用法为违规。**

---

## 分页速览

- **App shell**：✅ context 下发槽 + 可换 nav 集架构干净、token 化高、玻璃/reduced-motion/safe-area 周全。⚠️ RAIL_STEP 52/SUBNAV_STEP 42/宽高 magic px 与标尺脱钩；登出无二次确认、刷新全量 invalidate 过粗。
- **Landing**：✅ 分区合理、GSAP 全门控 reduced-motion。⚠️ 成片 fontWeight 字面量 + 内联 clamp()；文档死链、定价 CTA `href="#"`、LiveConsole 无标注假指标（可信度风险）。
- **Auth**：✅ 全程复用原语、错误码 i18n + 429 倒计时细致。⚠️ 缺忘记密码入口；校验只走 toast 未用字段级 error。
- **Tenant Overview**：✅ 几乎全靠 BalanceCard/DataTable/Money 拼成、token 纪律好。⚠️ 余额加载/失败退化成 '0'；两个 query 不处理 isError；ledger type 直出未翻译枚举；截断 20 行无「查看全部」出口。
- **Tenant Usage**：✅ 结构清晰、复用 SegmentedControl/图表原语。⚠️ 图表 loading 渲染空白 panel、全页无 isError；与 admin Analytics 高度重复待抽 Shell。
- **Tenant Models**：✅ 薄 DataTable 包裹、样式零缺陷。⚠️ `?? []` 吞失败；capabilities 取回却丢弃；枚举未走 i18n；visibility 该用 StatusBadge；过薄临界。
- **Tenant API Keys**：✅ 复用度最高（CardCollection+EntityCard+CopyField+ConfirmDialog），token 干净。⚠️ /min 单位硬编码；reveal CopyField 无 failedLabel；禁用密钥成无操作死卡片；Mint key 用 ghost 弱化了主操作。
- **Tenant Billing**：✅ 结构清晰、复用 SegmentedControl/Money。⚠️ 充值落地页却不显当前余额/held；金额手搓 `/100`；QR 以裸 mono 字符串呈现而非二维码图。
- **Tenant Settings**：✅ 两段式布局干净、复用 SectionHeader/TextField。⚠️ 密码输入缺 autoComplete、表单非 `<form>` 无法 Enter 提交；me 查询无 loading/error 三态区分；email_verified 未呈现、新密码无二次确认。
- **Admin Dashboard**：✅ 复用度最高、µUSD+Money、深浅主题成立。⚠️ 任务卡 created_at 错挂「状态」标签下（label/value 错配）；仅 2 个无 delta KPI、信息密度偏低、缺 error/骨架态。
- **Admin Analytics**：✅ 四段式结构、金额全程 µUSD/BigInt、i18n 齐全。⚠️ StatCard 裸 px + letterSpacing 漂移；明细表首列 header 恒为「Bucket」在非 day 分组下语义错配；缺 isError；折线图仅首尾标签、无 Y 轴/悬停。
- **Admin Relay Traces**：✅ TraceViewer 字段取舍专业、明确标注脱敏/截断。⚠️ 缺状态/错误维度过滤；无 error 态；provider 裸文本输入；client searchable 与 cursor 分页语义冲突（只搜已加载行）。
- **Admin Catalog**：✅ master-detail 响应式 + URL-state 深链 + 幂等键，工程质量高。⚠️ CatalogPage 逐行重造 `ui/Tabs`（丢 44px 触控高度、漂移 padding/字重）；渠道成本 USD 手搓格式化。
- **Admin Modifiers**：✅ 骨架正确、几乎无 magic number。⚠️ value 单位随 op 切换却裸字符串展示（违反 µUSD 硬规则）；列表只读缺编辑/删除/启停；when_expr/stackable/version 未展示；op 枚举裸英文；数字输入用 TextField 而非 NumberField。
- **Admin Route Groups**：✅ 完全复用原语、倍率转换设计清晰、双语 i18n 完整。⚠️ 渠道计数 N+1 query；priority/weight 边敲边写后端；过时 `[MOCK BACKEND]` 标注（实已接真后端）。
- **Admin Official Prices**：✅ DataTable+Drawer+ConfirmDialog 干净。⚠️ 自建 DateField 用 `className="panel"` 丢暖色 focus 环（焦点不可见 a11y 缺陷）+ native date 唤起系统蓝日历；金额绕过 Money；过时 MOCK 标注。
- **Admin Dify Import**：✅ FormField/SelectField/JsonField 共享原语、token 到位。⚠️ tenant 用裸 TextField 手敲 UUID（全站唯一破例）；serviceKeyRef/allowBlockers 未暴露；YAML 误用 JsonField；compat_report 只是 JSON.stringify。
- **Admin Tenants** `needs-rework`：✅ 设计系统复用极佳、零样式漂移、双语完整。⚠️ 只写不读不改的半成品 CRUD：卡片不可点、无详情/编辑/删除、不显 tenant id 与派生指标；创建无校验、未传 idempotencyKey。
- **Admin Accounts** `needs-rework`：✅ 代码整洁、复用 Modal/NumberField/TenantSelect/Money。⚠️ 只能展示本会话刚建的账户、刷新即丢、空状态文案矛盾；credit_held 死键从不展示；手写 .glass 余额卡未复用 BalanceCard。
- **Admin API Keys**：✅ 复用度高、token 纪律到位。⚠️ 绑路由组静默写无 pending/成功反馈；一次性明文用 `--run` 琥珀而非 `--fail`、缺「仅此一次」强约束；chip 单位硬编码。

---

## 建议的执行顺序

**Phase 0 — 纠偏（半天，零代码风险）**
更正过时标注：清理 RouteGroups/OfficialPrices 的 `[MOCK BACKEND]`，给 LiveConsole 补 MockBadge；同步 `CONVENTIONS.md` 断点清单（补 sm/xxl）。在做任何 IA 决策前完成，避免据错误注记判断。

**Phase 1 — 系统级抽取（最高杠杆，先做）**

1. `<QueryBoundary>/<AsyncSection>`（loading/error/empty + onRetry），全站替换 `?? []`——消灭头号 critical。
2. 同批统一加载骨架约定（图表区用 RoseLoader、BalanceCard 未知态用 '—'）。
3. `<Money>` 强制化 + lint 规则；`enumLabel`/`<EnumLabel>`；`<StatusBadge>` 单一事实源。这三项是机械替换，与 #1 并行。

**Phase 2 — 治 needs-rework（一刀两治）** 4. 把 Tenants 做厚成「租户中枢页」（EntityCard onClick → 详情抽屉，聚合 accounts/keys/resources/usage + 可复制 id + RowAction），把 Accounts 合并进去并删独立路由。需后端补 `GET /admin/accounts`。

**Phase 3 — 设计系统补洞 + 共享原语** 5. theme.css 补 `--fw-display`/`--fs-feature`/间距中间档 token，统一引用消除字重/字距/off-grid 漂移。6. 抽 `<UsageAnalyticsShell>`（admin Analytics + tenant Usage）、`useApiKeyLifecycle`+`<RevealKeyModal>`、`ui/Tabs` fill/column 变体（CatalogPage 删手写版）。7. 核实 `.field` 是否已下沉「error 红边 + width:100%」，未下沉则补齐。

**Phase 4 — 内容/可信度 + a11y** 8. Landing 死链 + 假指标修复（文档链接、定价 CTA、LiveConsole 标注）。9. Auth 忘记密码入口 + 字段级 error；Settings 表单化 + autoComplete。10. Modal/Drawer 背景 `inert`；逐控件套 `.hit-slop`/`--min-touch`。11. RouteGroups priority/weight 改 onBlur 保存 + 后端聚合 channel_count；Billing 余额卡 + 真二维码。

**Phase 5 — IA 收敛（依赖前置补完）** 12. 把 groups/official-prices/modifiers 三页补成完整 CRUD 后，收敛为 `/console/pricing` 页内 tab。13. 决策 /app/models：做厚保留 or 降级并入 Overview；给 Overview 截断表补「查看全部」导流。

**关键依赖**：Phase 1 必须最先（其他页面整改都会触碰 query 层）；Phase 5 的定价合并依赖三页先补完 CRUD；合并 #1 与 IA 决策依赖 Phase 0 的标注纠偏。

---

相关文件路径（绝对路径）：

- 审计快照（部分过时，需以 live 为准）：`/Users/alienworm/actionow-web/docs/component-audit.md`
- 前端逐页设计分析：`/Users/alienworm/actionow-web/docs/frontend-design-analysis.md`
- 设计 token：`/Users/alienworm/actionow-web/apps/web/src/styles/theme.css`、`glass.css`
- z-index 真相源：`/Users/alienworm/actionow-web/apps/web/src/lib/zIndex.ts`
- 断点：`/Users/alienworm/actionow-web/apps/web/src/lib/breakpoints.ts`（文档落后于此）
- 枚举 labelKey：`/Users/alienworm/actionow-web/apps/web/src/lib/api/enums.ts`
- 两个 needs-rework 页：`/Users/alienworm/actionow-web/apps/web/src/features/console/AccountsPage.tsx`、`TenantsPage.tsx`
