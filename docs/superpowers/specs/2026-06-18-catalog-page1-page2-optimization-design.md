# Page 1 / Page 2 优化设计 —— 目录布局重构 · 表单选择化 · 对齐计费重构（设计稿，先设计不写码）

- 日期：2026-06-18
- 分支：`feat/admin-frontend`（`/Users/alienworm/actionow-web`）
- 关联后端设计：`actionow-core` 的 `docs/superpowers/specs/2026-06-17-actionow-billing-channel-routing-design.md`（计费与渠道路由重构，**DESIGN ONLY，后端尚未实现**）
- 状态：**设计稿**，不写码。确认后分阶段实施。

本稿回应三条诉求：(A) 第三栏布局/IA 重构；(B) 表单「能选则不让填」原则落地；(C) 对齐即将到来的计费/路由重构，明确 Page1/2 的演进与分期。

---

## 0. 关键前提：计费重构会动到 Page1/2 的地基

后端计费重构（design-only）几条 locked 决策直接影响当前 Page1/2：

- **货币单位改为 µUSD**（`1 credit = $1`，µUSD = 1e-6 USD）。当前 Page2 的「µcredits/token」**语义将作废**。
- **模型价格单位改为 µUSD / 1M tokens**（不再是 µcredit/token）。Page2 价格字段、列、提示都要改。
- 新增 **official_model_price**（官方价格表，成本基准，admin 维护，sync 自动套价）。
- 新增 **route_group（分组）** + **route_group_channel（分组↔渠道，含 priority/weight）**：分组是「访问 + 计价 + 兜底」三合一层。`api_key` 绑定分组。
- `model` 增 **needs_pricing**（同步未匹配到官方价 → 建为 disabled）。
- `upstream_channel` 增 **input_cost_per_1m / output_cost_per_1m**（每渠道成本，仅用于毛利）。
- 客户价 = `base_model_price × group_ratio_bps/10000`，**路由前即确定**；渠道只影响成本/毛利，不影响报价。

**结论**：Page1/2 的「定价」「通道」语义会被计费重构改写。**布局/IA 重构与表单选择化（A、B）现在就能做且不会白做；计费相关 UI（C）必须等后端对应 track 落地后再接**——本稿给出设计与分期，不提前写计费 UI 代码。

---

## A. 布局与信息架构重构（立即可做，不依赖后端）

### A1. 第三栏铺满容器、去掉外层 padding

现状：`ConsoleLayout` 内容容器 `padding: var(--s-3)`（12px），其内页面再叠自己的 padding → 双层内缩，主体没占满。

**改法**：

- `ConsoleLayout` 内容容器去掉 `padding`（改 `padding: 0`），让第三栏主体铺满（仅保留外层壳 `--s-4` 与列间 `gap`，或按需也收紧）。
- 阴影/选中环不被裁切的「呼吸空间」下沉到**真正滚动的内层区域**：滚动容器用 `overflowX:hidden` + 内层用「负 margin 抵消 + 等量 padding」技巧（容器铺满，内容仍贴边、阴影有余量）。
- 卡片/表格的左右贴边由各区域 section 自己的内边距控制，而非外层统一 padding。

净效果：主体边到边铺满，滚动区内部仍有阴影余量，不再「中间一块、四周留白」。

### A2. 概览｜通道｜定价 合并为一个面板（去 Tabs）

现状：`ResourceDetailPane` 用 `Tabs(概览/通道/定价)`。

**改法**：合并为**单个纵向滚动面板**，分区堆叠：

1. **概览区**：ProviderIcon + id + 元信息 + 状态编辑（保留）。
2. **通道区**：标题 +「添加通道」+ 通道 `DataTable`（行为不变：编辑/启停/同步模型/删除 + 批量）。
3. **定价区**：标题 +「添加定价」+ 定价 `DataTable`。

去掉 `useUrlState('tab')`；用区块标题（可加锚点/折叠）替代 Tab 切换。面板随第三栏铺满、独立滚动。

### A3. 资源 + 模型 合并为「目录」页的两个 Tab

现状：`资源`、`模型` 是 catalog 子导航里的两个独立路由/页面。

**改法**：合并为统一的 **目录（Catalog）** 页，顶部一个 Tab 切换 `资源 | 模型`：

- Tab「资源」= 现有主从（左列表 + A2 合并详情面板）。
- Tab「模型」= 现有模型注册表 `DataTable`。
- 路由：`/console/catalog?tab=resources|models`（保留 `/console/resources/:id` 选中态为 URL 真源；或迁移为 `/console/catalog?tab=resources&id=...`）。子导航 catalog 组该项指向「目录」。
- 顶栏操作按钮随当前 Tab 切换（资源 Tab 显示「新建资源」，模型 Tab 显示「新建模型」）。

**为后续留位**：计费重构会再加 `官方价格`、`分组` 两类目录/路由实体。建议目录 Tab 设计成可扩展：v 当前 `资源 | 模型`；计费 track 落地后视归属扩为 `资源 | 模型 | 官方价格`（成本基准属目录），而 `分组` 因含路由/计价语义，更适合放到独立的 **计费/路由** 导航组（见 C3）。Tab 组件需支持 ≥2 个可增减项。

> 决策点 A-i：目录页用「单路由 + ?tab」还是「保留两路由 + 共享顶部 Tab 条」。推荐**单路由 + ?tab**（IA 更干净，顶栏动作随 tab 切换自然）。

---

## B. 表单「能选则不让填」原则落地

原则：**若字段取值是可枚举的（来自接口或常量），就用 下拉 / 单选 / 多选，不让用户手填**。仅「真正自由」的值（标识符 id、URL、显示名、密文）保留文本框。下面逐字段审计 Page1/2。

### B1. Page 1 —— 新建资源 Modal

| 字段         | 现状                     | 改为                                  | 选项来源                                                                                |
| ------------ | ------------------------ | ------------------------------------- | --------------------------------------------------------------------------------------- |
| id           | TextField                | 保留（标识符，自由）                  | —                                                                                       |
| tenantId     | TenantSelect             | 保留 ✓                                | `listTenants`                                                                           |
| kind         | SelectField              | 保留 ✓                                | 常量 RESOURCE_KINDS                                                                     |
| modality     | SelectField              | 保留 ✓                                | 常量 MODALITIES                                                                         |
| **provider** | **TextField + hint**     | **Combobox（下拉常用 + 允许自定义）** | 常量 COMMON_PROVIDERS（后端 `z.string()` 接受任意值 → 用「可输入下拉」而非严格 select） |
| execModes    | ChipsField + suggestions | 保留 ✓（建议项即枚举）                | 常量 EXEC_MODES                                                                         |
| ioSchema     | IoSchemaField            | 保留 ✓                                | —                                                                                       |

### B2. Page 1 —— 通道编辑 Drawer

| 字段              | 现状                       | 改为                           | 选项来源                                                                          |
| ----------------- | -------------------------- | ------------------------------ | --------------------------------------------------------------------------------- |
| **providerType**  | **TextField + hint**       | **Combobox（常用 + 自定义）**  | 常量 COMMON_PROVIDERS（计费重构后 provider 还要参与官方价匹配，规范化更重要）     |
| endpoint          | TextField(url)             | 保留（URL，自由）              | —                                                                                 |
| **model**         | **TextField**              | **Combobox（可输入下拉）**     | 该 resource 已同步的模型名（`listModels` 过滤 resource）/ 官方价 slug；允许自定义 |
| proxyRef          | TextField                  | 暂保留（代理引用，无枚举来源） | —                                                                                 |
| **credentialRef** | **仅「内联新建凭证」回填** | **Select 现有凭证 + 「新建」** | **需补 `listSecrets`**（后端已有 list/get/delete，client 仅有 createSecret）      |
| weight            | NumberField                | 保留 ✓                         | —                                                                                 |
| status            | SelectField                | 保留 ✓                         | 常量 CHANNEL_STATUSES                                                             |
| config            | KeyValueEditor             | 保留 ✓                         | —                                                                                 |

> 关键补强：**credentialRef 从「只能新建」升级为「选现有 + 新建」**——这是「能选则不填」的典型场景，需要给数据层补 `listSecrets()`（`SecretView{id,provider,created_at}`，无明文）。

### B3. Page 1 —— 定价 Modal

method/timing/spec/active 均已是 select/结构化 ✓。（计费重构后定价语义改写，见 C。）

### B4. Page 2 —— 模型编辑 Drawer

resource/modality/visibility/status = select ✓；capabilities = 开关组 ✓；name/display 自由（标识符/显示名，保留）；prices = NumberField（计费重构后改单位，见 C5）。**Page2 已基本符合原则**，仅价格单位待 C 调整。

### B5. 通用组件需求

- **新增 `ComboboxField`（可输入下拉）**：下拉常用值 + 允许自定义输入（用于 provider、model 等「常量但可扩展」的字段）。受控 `value:string` + `options:string[]` + 允许自由值。复用 `SelectField` 的键盘/玻璃样式规范。
- **新增 `SecretSelect`**（或在通道编辑器内组合）：`listSecrets` 下拉 + 「新建凭证」。
- 数据层补 `listSecrets()`。

---

## C. 对齐计费/路由重构（design-only，按后端 track 分期接入）

> 下列 UI **不现在写**；等后端对应 track（见后端 spec「Implementation tracks」）合并、有真实接口后再按页接入。此处只锚定设计与归属，避免 A/B 的改动与未来冲突。

### C1. µUSD 重锚（后端 track 1）—— 影响 Page1/2 全部金额

- 模型价格：`µUSD / 1M tokens` → 展示为 **`$X / 1M tokens`**（USD）。
- Page2 价格字段：标签/提示从「µcredits/token · ≈N credits/1M」改为「**$ / 1M tokens**」；输入仍整数 µUSD/1M，旁注 `= $X.XX /1M`。表格列同理。
- Page1 定价（pricebook）金额、（后续）余额/账目/用量全部按 µUSD=USD 展示。
- `CREDIT_RATE` 退休；现有「µcredit」文案/换算清理。
- 这是**破坏性单位变更**：现有 Page2 的价格 UI 需整体替换（不是叠加）。

### C2. official_model_price 官方价格表（后端 track 2）—— 目录新页

- 新页（建议作为 目录 第三个 Tab「官方价格」）：`DataTable`(provider, model_slug, display_name, 输入价 $/1M, 输出价 $/1M, cached, effective_at, 来源)。
- CRUD 表单：provider = **下拉常量**；model_slug/display_name/source_url/notes = 文本；价格 = NumberField（$/1M）；effective_at = 日期选择。
- 与同步联动：sync-models 自动按 (provider, normalize(slug)) 套官方价；未匹配 → 模型 `needs_pricing` + disabled。前端在模型页呈现「需定价」。
- 可加「重新套用官方价」动作（backfill）。

### C3. route_group 分组（后端 track 3/4）—— 新「计费/路由」导航组

- 新页「分组」：`DataTable`(name, group_ratio_bps→展示为 `×1.50` / `+50%`, status, description)。CRUD 表单：name 文本；**group_ratio 用专门输入**（bps 整数，旁显倍率/百分比，避免用户算 bps）；status select。
- **分组↔渠道成员管理**（route_group_channel）：在分组详情里挂渠道，设 **priority（兜底层级）+ weight**。priority/weight 用 NumberField + 说明（priority 高者先试）。
- 反向：通道编辑器可只读展示「该通道所属分组及其 priority/weight」。
- 「固定走某渠道 + 固定收费」= 单渠道分组 + 该组 group_ratio —— UI 给个引导/预设。

### C4. 通道成本列（后端 track 5）—— Page1 通道

- 通道编辑器增 **input_cost_per_1m / output_cost_per_1m**（$/1M，运营实际成本；直连≈官方价，codex-oauth≈0）。
- 仅用于毛利：通道表/详情可展示「成本」与（结合用量后）「毛利」。订阅型渠道成本≈0 → 毛利≈全价（提示说明）。

### C5. 模型页计费语义（后端 track 1+2+5）—— Page2

- 价格 = **base（成本基准，$/1M）**，由官方价自动套；客户实付 = base × 分组 group_ratio（**按分组不同而不同**）→ 模型表只展示 base，「客户价」是 (模型×分组) 维度（可在分组页或单独「计价预览」呈现）。
- 新增 **needs_pricing** 状态徽章 + 「设定价格/套用官方价」快捷动作；needs_pricing 模型默认 disabled。
- 现有「µcredits/token」整套替换为 µUSD/1M（见 C1）。

### C6. API Key → 分组（后端 track 3）—— 影响后续 Page3

- API Keys 页（Page3）创建/编辑时增「分组」**下拉**（`listRouteGroups`）；key 绑定分组即决定其可用渠道与价格倍率。`resourceAllowlist` 作为更细过滤保留。

---

## D. 建议执行顺序

**第一波（现在做，不依赖后端）**

1. A1 第三栏铺满/去 padding（+ 阴影余量下沉到滚动内层）。
2. A2 详情三 Tab 合并为单面板。
3. A3 资源+模型 合并为目录页两 Tab（?tab 单路由）。
4. B5 `ComboboxField` + `listSecrets` + `SecretSelect`；B1/B2 provider/model 改 Combobox、credentialRef 改「选现有 + 新建」。
5. 复测：双主题、键盘、空/错态、深链。

**第二波（后端计费 track 落地后，按 track 接入）** 6. C1 µUSD 重锚（替换 Page2 价格 UI、Page1 定价金额）。7. C2 官方价格表页（目录第三 Tab）。8. C3 分组页 + 分组↔渠道成员（priority/weight）；新建「计费/路由」导航组。9. C4 通道成本列；C5 模型 needs_pricing + 套官方价；C6 API Key 绑分组。

每页仍走：分析 → 设计 → 子 agent 构建 → 两段评审 → 实测。

---

## E. 待确认决策点

- **A-i**：目录页「单路由 + ?tab」(推荐) vs 「双路由 + 共享 Tab 条」。
- **A-ii**：详情合并后，通道/定价区是否要「可折叠」分区（长面板时更易扫读）。推荐：默认展开，加分区标题即可，暂不折叠。
- **B-i**：provider / model 用 **Combobox（可输入下拉，推荐）** 还是严格 Select（不允许自定义）。后端 `z.string()` 接受任意值，且会有新厂商/新模型 → 推荐 Combobox。
- **C-范围**：计费相关 UI 全部等后端对应 track 合并后再做（推荐），还是希望先用 mock/占位把页面骨架搭出来。推荐**等真实接口**，避免返工。
- **第一波是否现在开工**：A1/A2/A3/B 这批与后端解耦，可立即实施。
