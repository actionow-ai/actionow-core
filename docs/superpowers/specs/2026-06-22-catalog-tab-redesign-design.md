# 目录 → 接入与供给(Providers) 标签页重构 — 设计文档

- 日期：2026-06-22
- 范围：管理员控制台「目录」组（模型 / 资源 / Dify 导入 / 凭证），重命名为「接入与供给」
- 状态：设计已锁定，待 review → 实现
- 关联评审：12-agent 工作流（结论已对抗性验证）；上一轮 [[ops-tab-redesign]] 同流程

---

## 1. 背景与目标

「目录」组当前 4 区：

| 路由                             | 区域      | 数据源                                                     |
| -------------------------------- | --------- | ---------------------------------------------------------- |
| `/console/catalog?tab=models`    | 模型      | `GET /admin/models`(+grants)                               |
| `/console/catalog?tab=resources` | 资源      | `GET /admin/resources`(+channels, pricebook)               |
| `/console/dify`                  | Dify 导入 | `GET/POST/PATCH/DELETE /admin/dify`                        |
| `/console/oauth-sessions`        | 凭证      | `GET/POST/DELETE /admin/oauth-sessions` + `/admin/secrets` |

评审结论：4 区共享规范的 DataTable/Drawer/Modal/RowAction 原语，工程底子不错；问题集中在 (a) 信息架构（模型/资源 概念混淆、目录组名误导、凭证夹在目录下），(b) 系统级表格缺陷（勾选行无高亮、列表丢分页、行操作样式），(c) 凭证元数据/CRUD 缺口。

目标：① 信息架构去歧义（合并模型→资源、重命名组、凭证子 tab）② 表格系统级修复 ③ 凭证增强（名称/备注/分组 + 完整 CRUD）。

---

## 2. 锁定的决策

| #   | 决策           | 选择                                                                                                                                                                        |
| --- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 模型 vs 资源   | **Option A：以资源为主，模型内嵌资源详情页**（去掉模型 peer tab）。匹配真实父子数据模型（`model.resource_id → resource`）。                                                 |
| D2  | 组重命名       | 「目录」→ **「接入与供给 / Providers」**（涵盖 资源+模型 / Dify / 凭证 整个供给侧；与「计费与路由」组对仗）。                                                               |
| D3  | 凭证增强       | 两类凭证（OAuth 会话 + API 密钥库 secret_ref）**都**加 **名称 / 备注 / 分组(自由文本标签)** + **编辑(PATCH)**；行操作换 RowAction；加 行选择 + 批量撤销；密钥库表改真分页。 |
| D4  | 表格系统级修复 | 勾选行金色高亮（DataTable 级）、行操作 gap 规范化、真分页（cursor）。                                                                                                       |

> **分组语义**：本轮「分组」= 凭证行上的**自由文本标签**字段（便于筛选/归类），**不**引入关系型分组实体（route-group 绑的是 channel，不绑凭证）。如需关系型分组为后续项。

---

## 3. 信息架构（前 → 后）

```
现状（目录组，4 leaf）                     重构后（接入与供给组，3 leaf）
├─ 目录 /console/catalog                   ├─ 资源  /console/catalog        ← 资源为主；模型内嵌详情页
│    ├─ 模型 tab                            ├─ Dify 导入 /console/dify
│    └─ 资源 tab                            └─ 凭证 /console/oauth-sessions  ← 子 tab: OAuth会话 | API密钥
├─ Dify 导入 /console/dify
└─ 凭证 /console/oauth-sessions
```

- nav 组 `catalog` 标签改为「接入与供给」(`nav-config.ts:46-54` + i18n `nav.groups.catalog`)。
- 去掉 `CatalogPage` 的 模型/资源 双 tab（`CatalogPage.tsx:10-13`）；`/console/catalog` 直接 = 资源页（保留 `?tab=` 旧深链 → 资源）。`/console/catalog?tab=models` 重定向到资源页。
- 模型相关 leaf 标签（mobile tabs / 旧 catalog 标签）相应调整。

---

## 4. 区域设计

### 4.1 资源（主，`/console/catalog`）

**布局重设计**：master-detail，但两侧都升级。

**左侧富信息列表**（替换现纯名字卡）：每张卡 = ProviderIcon + 资源名 + 模态/类型 + 一行紧凑统计「N 通道 · N 模型 · 状态 pill · 价区间」。可搜索；选中行金色高亮。统计的 N模型 = 客户端 `listModels().filter(resource_id===id)` 计数。

**右侧详情 = 头部条 + 子 tab**（替换现单列长滚动 — 加了模型后单列过长，已确认选「方案 1」）：

- **头部条**：ProviderIcon + 资源名 + 状态 pill + 操作（编辑/删除）常驻。
- **子 tab**：`概览 · 通道 · 定价 · 模型`，roving-tabindex/underline（复用 `ui/Tabs` 或 `CatalogPage` 现有 tab 实现），每 tab 一屏不长滚。
  1. **概览**：补 status SelectField pending/disabled；失效 `?id` 深链 → not-found 空态；modality 用 `enumLabel`（需 import MODALITIES）。
  2. **通道**：补 channel toggle loading；数值列 sortable；bulk-status 成功 toast + allSettled。
  3. **定价**：现有。
  4. **模型（新）**：列 `resource_id===当前资源` 的 model；复用 `ModelEditor`（固定 resourceId `:165`）新建/编辑；行 RowAction edit/grants(`ModelGrantsDrawer`)/delete；批量启停 allSettled；visibility 用 `.chip`；价显 per-1M（编辑器已算）；`/tok` 入 i18n。

`ModelsPage` 的表格/编辑/grants/批量逻辑抽成 `ModelsSection` 组件供「模型」子 tab 使用；旧 `/console/catalog?tab=models` 重定向到资源页。**跨资源扁平"全部模型"视图本轮取消**（A 的取舍，已确认）。

### 4.2 Dify 导入（`/console/dify`）

- **创建表单移入 overlay**（Modal 或 Drawer 皆可；勿强制 Drawer——兄弟页 Modal/Drawer 混用），SectionHeader 加「+ Dify 导入」cta（新 i18n `dify.new`）。
- tenant 字段裸 input → **TenantSelect**（tenantId 是 uuid）；resourceId 保留裸文本 + placeholder（新 slug）。
- **提交校验**：disabled-until-valid（模式见 `OfficialPricesPage.tsx:337`）+ 字段级 aria-invalid；import 前 `trim()` endpoint（与 edit 对齐，避免空格 422）。
- 行操作删除冗余内层 `<div gap:--s-1>`（见 §5）。
- 可选：兼容报告由裸 JSON → 结构化 findings/blockers 面板（形状已知 `{items, has_blockers}`，`admin-dify.controller.ts:87-90`）。

### 4.3 凭证（`/console/oauth-sessions`，归入「接入与供给」）

- 两张堆叠表 → **子 tab**：「OAuth 会话」｜「API 密钥」(secret_ref)。
- 两类每行新增列：**名称**（主标识，可编辑）· **备注** · **分组**（自由标签）；状态/过期/账号等保留。
- **编辑**：行 RowAction ✎ 开 **Drawer**（`.field` 输入 名称/备注/分组）。密钥材料不可改（要换则重建）。
- **行操作**换 `RowAction`（撤销 = `danger` 红色态），收窄 `actionsWidth`。
- **行选择 + 批量撤销**：`selectable` + `bulkActions`（后端按 id DELETE 已支持）。
- 密钥库表 `useQuery` → `useInfiniteQuery + LoadMore`（修丢 cursor 截断 50）。
- provider 列用 `ProviderIcon`（**先**给 `ProviderIcon.tsx:40` 的 OpenAI BRANDS 加 `'codex'` alias，否则 codex-oauth 渲染 'C' 字母；prop 名是 `provider` 非 `slug`）。
- account_id / secret id 裸 `<code>` → `CopyField`；日期 `toLocaleString(i18n.language)`。

### 4.4 模型（并入 4.1）

不再是独立 tab。`ModelsSection`（来自原 `ModelsPage`）补：真分页（cursor）、visibility 用 `.chip` 类（非手搓 pill、非 Pill idle）、价显 per-1M 等价（编辑器已算）、`/tok` 入 i18n、grants 日期 locale、批量启停 allSettled。

---

## 5. 表格系统级修复（DataTable 级，一次修好全站）

1. **勾选行金色高亮**（用户主诉根因）：`DataTable.tsx:585`(`rowBg`) 与 `:593`(`boxShadow` 金左轨) 目前只看 `selectedRow`(master-detail `selectedKey`)，**不读勾选 `selected` Set**。改为：
   ```
   rowBg = (selectedRow || (selectable && selected.has(key))) ? 'var(--hover-bg)' : undefined
   boxShadow 同样 OR 上 selected.has(key) 的 inset 金左轨
   ```
   一处修复 → 模型/资源/凭证 所有 selectable 表的选中反馈。
2. **行操作 gap 规范化**：多页给 RowAction 多套一层 `<div gap:--s-1>`，覆盖 DataTable actions span 的 canonical `var(--s-2)`（`DataTable.tsx:648-653`）。**统一删除内层 wrapper**，让 span 供 `--s-2`（全 console：DifyImportPage/OfficialPricesPage/ResourceDetailPane/RouteGroupsPage）。勿单页改成异类。
3. **真分页**：消除"`.rows`-only wrapper 丢 nextCursor + 客户端 pageSize 假分页"（后端 `DEFAULT_LIMIT=50`）。模型列表、secrets 列表改 `useInfiniteQuery + LoadMore`（或传高 limit）。

---

## 6. 后端改动（凭证元数据 + 编辑纵切；按依赖顺序）

仅 D3 需要后端；其余（D1/D2/D4 + Dify/表格）纯前端。

1. **migration**：`oauth_session` + `secret_ref` 各加 `name text`、`notes text`、`group_tag text`（均 nullable）。
2. **repo**（`packages/db/src/repositories/{oauth-session,secret-resolver/...}.ts`）：加 `updateOAuthSession(id,{name?,notes?,group?})` + `updateSecretRef(id,{...})`；list 查询 select 新列。
3. **契约**（`packages/contracts/src`）：`updateOAuthSessionSchema` + `updateSecretSchema`（name?/notes?/group?）；在 `oauthSessionListViewSchema`(ops-views) + `secretViewSchema` 暴露三字段。
4. **service**（`admin.service.ts`）：`updateOAuthSession` / `updateSecret`。
5. **controller**：`@Patch('oauth-sessions/:id')` + `@Patch('secrets/:id')` + DTO（建议 `@Idempotent` 与既有创建一致）；openapi 注册两条 PATCH + 新字段。
6. **SDK**：`contracts gen:openapi` → `sdk gen` 重生。
7. **前端 api**（`admin.ts`）：`updateOAuthSession(id,body)` / `updateSecret(id,body)`。

---

## 7. 交付顺序

**阶段 0 — 纯前端（无后端）**

- D2 重命名（nav + i18n）。
- D1 合并：去模型 tab、`ModelsSection` 内嵌资源详情、`/console/catalog?tab=models` 重定向。
- D4 表格：DataTable 勾选行高亮、行操作 gap 规范化、模型/secrets 真分页。
- 凭证：RowAction(danger 撤销)、selectable+批量撤销、ProviderIcon(+codex alias)、CopyField、子 tab、日期 locale。
- Dify：创建移 overlay + TenantSelect + 校验 + +New cta + 删冗余 wrapper（+可选结构化兼容报告）。
- 资源/模型 各项 P2/P3 打磨（toast/loading/not-found/enumLabel/sortable/per-1M 价）。

**阶段 1 — 后端纵切（凭证元数据+编辑）**

- §6 全部 → 前端凭证两类加 名称/备注/分组 列 + 编辑 Drawer（PATCH）。落地前过渡：把 account_label 当"名称"列展示，编辑入口 stub。

---

## 8. 风险

- **模型内嵌的下钻成本**：单资源数十个 model（codex sync）时，详情页 Models 区需自身分页/搜索；扁平跨资源视图取消（已确认取舍）。
- **`group` 自由标签 ≠ 关系分组**：仅文本，跨凭证筛选靠字符串匹配；若将来要真分组需另设实体。
- **密钥库 PATCH**：secret 材料不可改，PATCH 仅元数据；UI 要讲清"编辑=改备注，不改密钥"。
- **DataTable 高亮改动**面广（全站 selectable 表）：回归测既有 master-detail 选中（relay-traces 行点击 selectedKey）不被影响。
- ProviderIcon 加 alias 前不要切 codex 列（否则 'C' 字母比裸文本更差）。

---

## 9. 测试

- 组件：DataTable 勾选高亮（selected vs selectedKey 两路径）、ModelsSection（按 resource_id 过滤 + 编辑）、凭证子 tab + 编辑 Drawer + 批量撤销、Dify overlay 校验门控。
- 集成：`/console/catalog?tab=models` 重定向；凭证 PATCH（阶段1）；分页 LoadMore。
- 回归：relay-traces/ops 表的行点击 selectedKey 高亮仍正常；行操作 gap 全站一致。
- 角色：凭证/资源为 admin-only（不泄漏到 /app）。

---

## 10. 受影响文件（索引）

- 前端：`apps/web/src/features/console/{CatalogPage,ResourcesPage,ResourceDetailPane,ModelsPage→ModelsSection,ModelEditor,ChannelEditor,DifyImportPage,OAuthSessionsPage}.tsx`、`components/data/{DataTable,ProviderIcon,EntityCard,CopyField}.tsx`、`components/ui/RowAction.tsx`、`lib/api/admin.ts`、`components/console/nav-config.ts`、`routes.tsx`、`i18n/locales/*/console.json`。
- 后端（阶段1）：`packages/db/src/schema/{oauth,catalog/secret}.ts` + migration、`packages/db/src/repositories/{oauth-session,secret-resolver}.ts`、`packages/contracts/src/{admin-requests,ops-views,catalog-views}.ts` + `openapi.ts`、`apps/api/src/admin/{admin.controller,admin.service,dto}.ts`、`@actionow/sdk` 重生。
