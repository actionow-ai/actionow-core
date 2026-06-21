# Actionow 前端正式接入后端 API — 设计文档（信息架构 + 逐页规格）

- 日期: 2026-06-17
- 分支: `feat/admin-frontend`（worktree `/Users/alienworm/actionow-web`）
- 前置: 地基已完成（L0–L3）；admin API 客户端、缓存规范、组件库、动效系统就位。
- 方式: **逐页推进** —— 每页：深入分析 → 设计 → 对接真实 API 构建 → 验证。现有 1–7 页可从零重做，不拘泥旧布局。

## 1. 信息架构（三个界面）

**A. 运营控制台**（`/console/*`，管理员 JWT → `/admin/*`）。导航分组：

- 概览：仪表盘
- 目录：资源（通道 · 凭证 · 定价）、模型注册表、Dify 导入
- 租户：租户、账户、API Keys（+ 模型授权）
- 计费：调价规则、用量分析、账目流水、支付、兑换码

**B. 租户自助台**（`/app/*`，租户 JWT → `/console/*`）：我的 Key、我的用量、充值、可用模型。

**C. Playground**（租户 API key → `/v1` 中转）：跨协议试用对话。

## 2. 构建顺序（按依赖 + 价值）

1. 资源 / 目录（资源 + 通道 + 凭证 + 定价）
2. 模型注册表（+ 授权 + token 计价）
3. 租户 · 账户 · API Keys
4. 用量分析（汇总 + 明细）
5. 账目流水 · 支付
6. 调价规则 · 7. 兑换码 · 8. Dify 导入
7. 仪表盘（聚合，最后做）
8. 租户自助台 · 11. Playground

每页一个独立的实施计划（writing-plans）+ 子 agent 构建 + 两段评审，逐页验证后再进入下一页。后续页面的深入分析在进入该页时补充到本文档或各自计划中。

## 3. 共享约定（所有页面遵循）

- 数据层：集中 `qk`（`lib/api/queryKeys`）；目录/参考类 `STALE_REFERENCE`，易变类 `STALE_VOLATILE`；过滤/分页列表用 `keepPreviousData`；mutation 统一 `mutationError(t)` + 失效相关 key。
- 过滤/标签/选择以 URL 为真源（`useUrlState` / 路由参数）。
- 字段统一 `onChange(value)` + `FormField`；枚举字段用 `SelectField`（不再自由文本强转）。
- **不写原始 JSON**：所有对象/数组字段用结构化表单（`KeyValueEditor` / `ChipsField` / 行编辑器 / 按 method 分支的 mini-form）。仅 3 类机器生成 blob 保留引导式文本框：Dify `yaml`、modifier `whenExpr`（后端目前不解析，纯注释）、OAuth `authJson`。
- **每个字段都有清晰描述**：行内 `hint` 小字 + 可选 `Tooltip`（标签旁 ⓘ 悬浮）。涉及单位/格式必须标注：**µcredits（1 credit = 1,000,000 µcredits）**、UUID、逗号分隔等。`fixedCredits` 与 modifier 的 credit-value 输入「人类 credit」；但 pricebook `spec` 内（rate/table/amount）与 model inputPrice/outputPrice 是「µcredits 原值」。
- 表格用增强版 `DataTable`（分页/搜索/排序/选择/批量/sticky/列显隐）；卡片用 `EntityCard`/`CardCollection`。
- 设计规则：无蓝、无 emoji（Phosphor）、深/浅双主题、按钮不换行、i18n zh-CN|en 双份、token 化、无障碍、reduced-motion。
- 真实 API：所有数据来自后端；空/错/加载态完整。**注意运行的后端需为最新**（含 channels/models/usage/analytics 等近期路由）。

## 4. 需要新封装的组件

**表单工具（Page 1a，跨页复用）**

- **`Tooltip`** + `FormField` 增 `tooltip` 属性：标签旁 ⓘ，悬浮/聚焦显示说明；reduced-motion 即时；无蓝。任意字段据此可加悬浮描述。
- **`KeyValueEditor`**：增删「键→值」行 → `Record<string,string>`（用于通道 `config` 等任意 record）。
- **`ChipsField`**：自由增删字符串列表 + 可选建议项 → `string[]`（用于 `execModes`、enum `options`、matrix `key`、资源白名单）。
- **`Drawer`**：右侧滑出面板（比 Modal 重），承载通道编辑器等长表单。复用 `useFocusTrap` + `--overlay-bg` + motion token；reduced-motion 即时；Escape/遮罩关闭。
- **枚举选项集 `lib/api/enums.ts`**：集中导出各枚举选项数组 + i18n label key（modality/method/timing/channelStatus/kind/…）+ `COMMON_PROVIDERS`、`EXEC_MODES` 建议；`toOptions(opts,t)` 映射为 `SelectField` 选项，让选项与 `types.ts` 联合类型共用单一来源。

**结构化字段编辑器（Page 1a，按真实后端结构）**

- **`IoSchemaField`**：`ioSchema` 的 inputs/outputs 两组行编辑器。每行 `key` + 类型下拉(`string/number/boolean/enum/file/file_list`) + `required` 开关 + 可选 `label`/`default`/`maxLength`；`enum` 时出现 options（`ChipsField`）。产出 `{inputs:IoField[],outputs:IoField[]}`（见 `packages/contracts/io-schema`）。
- **`PricebookSpecForm`**：按 `method` 分支产出 `spec`。`unit`=维度/费率行（µcredits 整数）；`fixed`=仅填 `fixedCredits`（人类 credit，后端换算）；`passthrough`=markup `{type,value}`；`formula`=单行表达式 + 实时校验（仅 `+ - * ( )`/整数/变量名）+ 变量提示；`matrix`=`key`(ChipsField)+ 组合键→µcredits 行(+可选 multiplier/perItem)。顶层 `markup` 同 `{type:percent|flat, value}` mini-form。

**延后**

- **`ConfirmDialog`**（「API Keys」页有 DELETE 时）：破坏性操作确认，基于 Modal。
- model `capabilities` → 4 个开关（tools/vision/audio/json）；`resourceAllowlist` → 资源多选 —— 各在其页用 `ChipsField`/多选实现。

## 5. 第 1 页规格 —— 资源 / 目录（运营端）

**受众**：仅运营/管理员。
**目的**：管理平台对外暴露的目录——每个资源携带上游通道（路由）、凭证、定价表。

### 5.1 布局（重做）

主从结构：左列资源列表，右侧详情。详情用 `Tabs`（概览 · 通道 · 定价）。

- 窄屏：列表与详情切换（沿用 `/console/resources/:id` 路由参数为真源）。
- 宽屏：左右两栏。

### 5.2 资源列表

- 数据：`api.listResources()` → `GET /admin/resources`；`qk.resources()` @ `STALE_REFERENCE`。
- 展示：`DataTable`（或卡片列表）—— provider（`ProviderIcon`）、id、modality、exec_modes、status（`StatusBadge`）、current_version；可搜索；点击行→详情（选中态）。
- 顶栏操作：「新建资源」按钮（`useSetConsoleAction`）。

### 5.3 详情 · 概览 Tab

资源头：`ProviderIcon` + id + `modality · provider · exec_modes` + `StatusBadge` + 版本。

### 5.4 详情 · 通道 Tab

- 数据：`api.listChannels(id)` → `GET /admin/resources/:id/channels`；`qk.channels(id)`。
- 表格（增强 `DataTable`）：列 = provider（logo）、endpoint、model、weight、status（`StatusBadge`）；`rowActions` = 「编辑」（打开 Drawer）+「启用/停用」（`PATCH` status）；`selectable` + `bulkActions` = 批量启用/停用（逐个 `PATCH`）。
- 新增/编辑（`Drawer`）：字段 providerType（`TextField` 自由字符串，后端为 `z.string()`；下方 hint 列常见值 openai/anthropic/gemini/… `ProviderIcon` 已能解析任意值）、endpoint（`TextField`）、model（`TextField`）、proxyRef（`TextField`）、weight（`NumberField`）、status（`SelectField` active/disabled）、config（`JsonField`）、credentialRef（凭证选择，见 5.6）。
  - 新增 → `api.createChannel(id, body)`；编辑 → `api.updateChannel(id, channelId, body)`（`PATCH`，可空字段清除）。
  - 成功后 `invalidateQueries(qk.channels(id))` + `mutationError(t)`。
- 无 DELETE 端点：用 status='disabled' 软停用，不做硬删除。

### 5.5 详情 · 定价 Tab

- 数据：`api.listPricebook(id)` → `GET /admin/pricebook`；`qk.pricebook(id)`。
- 表格：method、timing、version、active（`StatusBadge`）。
- 新增定价（Modal）：resourceVersion（`NumberField`，默认 `resource.current_version`）、version（`NumberField`）、method（`SelectField`：unit/matrix/fixed/formula/passthrough）、timing（`SelectField`：pre/post）、`fixedCredits`（`NumberField`，仅 method=fixed 时显示）、spec（`JsonField`）、active（`Toggle`）。→ `api.createPricebook(body)`；成功失效 `qk.pricebook(id)`。

### 5.6 凭证（在通道表单内）

- 「新建凭证」按钮 → 小弹窗：value（`TextField`，密文）、label（`TextField`）→ `api.createSecret({value,label})` → `POST /admin/secrets` → 返回 `SecretView{id,...}`，把 `id` 填入通道的 `credentialRef`。
- 注：`createSecret` 仅返回引用（无明文回显需求）。凭证选择器本期最简：保存后回填 credentialRef 输入；完整凭证管理器延后。

### 5.7 新建资源（Modal）

`api.createResource(body)` → `POST /admin/resources`：id（`TextField`）、tenantId（`TenantSelect`）、kind（`SelectField` model/workflow）、modality（`SelectField` 枚举 text/image/video/audio/composite）、providerType（`TextField` 自由字符串 + 常见值 hint）、execModes（`TextField` 逗号分隔）、ioSchema（`JsonField`）。成功失效 `qk.resources()`。

### 5.8 端点清单（本页用到）

`GET /admin/resources` · `POST /admin/resources` · `GET /admin/resources/:id/channels` · `POST /admin/resources/:id/channels` · `PATCH /admin/resources/:id/channels/:channelId` · `POST /admin/secrets` · `GET /admin/pricebook` · `POST /admin/pricebook`。（客户端方法 L1 已就位。）

### 5.9 缓存

- `qk.resources()` @ `STALE_REFERENCE`；`qk.channels(id)` / `qk.pricebook(id)` 默认；mutation 后精确失效；列表过滤用 `keepPreviousData`；选中资源 = 路由参数（刷新/返回保留）。

### 5.10 组件

复用：`DataTable`、`Tabs`、`Modal`、`SelectField`、`NumberField`、`TextField`、`JsonField`、`Toggle`、`CopyField`、`StatusBadge`、`ProviderIcon`、`TenantSelect`、`mutationError`、`qk`、`useUrlState`。
新建：`Drawer`、`lib/api/enums.ts`。

### 5.11 i18n / 受众 / 验证

- i18n：通道/凭证/定价表单字段、枚举 label、按钮、空/错态文案，zh-CN + en 双份。
- 受众：仅 admin（`ProtectedRoute role="admin"`，已有）。
- 验证：对接真实 API（后端最新）；建资源、加通道+改通道、建凭证回填、加定价全链路；切资源不闪、刷新保留选中；键盘可达；深/浅双主题。

## 6. 不在本页范围

模型注册表/用量/账目/支付/兑换码/Dify/仪表盘（后续页）；租户自助台与 Playground（后续界面）；通道硬删除（后端无 DELETE）；完整凭证管理器（本期最简回填）。
