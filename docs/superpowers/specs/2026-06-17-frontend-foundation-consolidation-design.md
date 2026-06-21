# Actionow 前端地基整顿 — 设计文档

- 日期: 2026-06-17
- 分支: `feat/admin-frontend`（worktree `/Users/alienworm/actionow-web`）
- 状态: 待评审
- 来源: 5 个 Opus 4.8 agent 并行审计（架构/代码规范、设计系统/样式、组件体系、动效/GSAP、API 集成完整度）的综合结论

## 1. 背景与目标

前端的硬规则守得很好（无蓝色、无 emoji、深/浅双主题、按钮不换行、i18n、移动端底栏），分层也清晰。但在**功能扩张之前**，需要先把底层框架整顿稳，否则后续每个新页面都会复制现有的债务。本次只整顿地基，**不做新功能**。

整顿后要达到的状态：

- 一套**可被遵守**的规范：token、组件契约、缓存/状态、动效，均有单一真源与文档。
- API 客户端与后端**管理面**对齐（字段、枚举、缺失方法、HTTP 动词），消除"接了一半"的接口。
- **缓存正确**：切 tab/切页/刷新后页面数据、过滤选择不丢、不闪烁。
- 组件**无障碍达标**、契约一致，且补齐后续功能要用的基础件。
- 动效成体系（token 化 + 统一 reduced-motion），并补上登录页等明显缺失。

## 2. 范围

**本次包含**

- L0 规范与设计 token 基线
- L1 数据层：管理面 API 客户端补齐 + 缓存/状态规范
- L2 组件库与无障碍
- L3 动效系统
- 2 个紧急修复（见 §4）

**本次不包含（明确排除）**

- 任何新业务功能页（通道编辑器、用量看板、模型注册表、兑换码、Playground）—— 各自另开 spec。
- `console` 自助客户端、`/v1` 中转客户端 —— 等「租户自助台」「Playground」阶段再建。
- 后端任何改动（仅只读对齐）。

## 3. 工作线

### L0 — 规范与设计 token 基线

**新增 token（`src/styles/theme.css`，深/浅各给值）**

- 类型刻度补齐：`--fs-nano: 9px`、`--fs-micro: 10px`、`--fs-md: 16px`、`--fs-xl: 24px`、`--fs-2xl: 30px`（与现有 `--fs-caption..--fs-display` 衔接）。
- 暖色阴影：`--shadow-accent-sm`（Logo）、`--shadow-accent-md`（步骤徽标）、`--shadow-accent-card`（Pricing 强调卡）；强化光晕 `--glow-accent-strong`（RoseLoader）。
- 渐变/遮罩：`--grad-accent: linear-gradient(135deg, var(--accent), var(--accent-2))`；`--scrim`（Modal 背板，深/浅各值）。
- 动效：`--dur-instant:.12s` `--dur-fast:.18s` `--dur-base:.26s` `--dur-slow:.42s` `--dur-slower:.7s`；`--ease-out: cubic-bezier(.2,.8,.2,1)`（提升现有 `EASE` 常量）、`--ease-in`、并在 `lib/motion/tokens.ts` 做 TS 镜像（GSAP 用）。
- 圆角：`--r-xs: 8px`（小图标块）。

**规范落地**

- 断点集中到 `lib/breakpoints.ts`（`md: '(min-width:768px)'` 等），`useMediaQuery` 与落地页 880/960/1100 统一命名引用。
- 字号一律引用 `--fs-*`；标题禁止再内联 `clamp(...)`（用 `--fs-h1/--fs-h2`）。
- 阴影/渐变一律走 token。
- 选定**单一布局机制**：移除落地页里零散的 Tailwind 网格（3–4 处），统一为内联 + CSS var（与全站一致）。
- `↓` 滚动提示换 Phosphor 图标（无 emoji/无杂字符规则收尾）。
- 产出 `docs/CONVENTIONS.md`：记录上述规则 + 下面 L1/L2/L3 的约定，作为后续开发的单一参照。

### L1 — 数据层：API 客户端 + 缓存/状态规范

**HTTP 客户端（`lib/api/client.ts`）**

- 新增 `patch`、`delete` 动词（当前只有 `get`/`post`，导致通道编辑无法实现）。
- `request<T>` 暴露响应头（返回 `{ data, headers }` 或 `onResponse` 钩子），为后续读 `x-actionow-channel` 预留（本次不接中转，但客户端能力先就位）。
- `ApiError` 仅用于服务端错误信封；客户端态（如 token 解析失败）改用本地错误，不再伪造 `status:200`。

**管理面方法与类型补齐（`lib/api/admin.ts` + `types.ts`，仅 admin）**

- 通道：`listChannels(resourceId)`、`updateChannel(resourceId, channelId, body)`；`CreateChannelBody` 补 `endpoint/model/proxyRef/config/status`，新增 `UpdateChannelBody`，`ChannelView` 补 `endpoint/model/proxy_ref/config`。
- 凭证：`createSecret({value, label?})` → `SecretView`。
- 模型：`createModel`、`listModels`、`grantModel(name,{tenantId})` + `CreateModelBody`/`ModelView`。
- 兑换码：`generateCodes({count, creditsPerCode, expiresAt?})`。
- 用量/账：`listUsage`、`analyticsUsage({groupBy,tenantId?,from?,to?})`、`listLedger`（keyset）、`listPayments`；补 `UsageLogView`/`UsageRollupView`/`LedgerView`/`PaymentIntentView`。
- 类型收紧为后端枚举：`pricebook.method/timing`(+`fixedCredits`、`markup: unknown`)、`modifier.op`、`resource.modality`、`dify.pricingModel`。

> 说明：这些方法/类型是后续功能的**共享前置**，本轮只建客户端层与类型，不建页面 UI。

**缓存/状态规范（新增要求的核心）**

- **集中 query keys**：`lib/api/queryKeys.ts` 工厂（`qk.tenants()`/`qk.resources()`/`qk.channels(resourceId)`/`qk.apiKeys(tenantId)`/`qk.pricebook(resourceId)`/`qk.jobs(tenantId)`/`qk.usage(...)` 等）。禁止内联数组字面量。修掉 `['resources']` 与 `['admin','resources']` 的双缓存裂缝。
- **缓存策略分层**：约定两档 `staleTime`——目录/参考类（tenants/resources/models）较长（~60s），易变类（jobs/usage/ledger）较短（~10s）；`gcTime` 保持 5min，使离开再回到某页时缓存仍在（切 tab 即时显示）。`refetchOnWindowFocus:false`、`retry:1` 维持。
- **切换不闪烁**：所有随过滤/分页/租户/标签变化的列表查询使用 `placeholderData: keepPreviousData` —— 切租户、切 tab、翻页时保留上一份数据，后台静默刷新，无 spinner 闪烁。
- **统一失效**：每个 mutation 通过集中 key 失效相关查询（修掉"新增通道后不刷新""建资源后 Dashboard 计数不更新"）。
- **导航/UI 状态持久化**：约定**以 URL 为真源**——
  - 主从选择沿用路由参数（`/console/resources/:id`，已有，作为范式推广）。
  - 过滤器/子标签写入 URL search params（`?tenant=…&tab=…`），新增 `useUrlState(key, default)` hook；保证刷新、前进/后退、切走再回都保留视图。
  - 临时性、不值得进 URL 的状态用 sessionStorage（少量）。
- **错误处理助手**：`lib/api/mutationError.ts` → `mutationError(t)`，所有 `useMutation.onError` 复用，统一传 `e.message` 兜底（修掉未知错误码把 i18n key 当文案显示的 bug）。
- 清理死代码：`NotAdminError`、未用的 `EmptyState`、`useKeyset/Page`（决定接入分页或删除——本轮先保留 `Page`/keyset 并复用到 `listLedger`）。

### L2 — 组件库与无障碍

**契约统一**

- 所有受控字段统一 `onChange(value: T)`（重构 `TextField` 由 `onChange(event)` 改为 `onChange(value)`，移除任意 `InputHTMLAttributes` 透传的逃生口）。
- 新增 `FormField({label, error, hint, required, children})` 包裹层，`TextField/NumberField/SelectField/JsonField` 统一组合它（消除 3 种 label 写法、统一 error/hint/required 展示）。字段错误用 `--fail` token，不再用品牌橙 `--accent-2`。
- 变体/尺寸统一命名：`variant ∈ cta|ghost|link|danger`、`size ∈ sm|md|lg`。

**新增基础组件（后续功能要用）**

- `NumberField`（`onChange(number)`，min/max/step）——取代 `type="number"` 偷渡。
- `Checkbox` / `Toggle(Switch)`。
- `Tabs` / `SegmentedControl`（带滑动指示器；登录页分段切换是其原型）。
- `IconButton`（抽离重复的 `ico-btn`/`RailButton` 模式）。
- `ConfirmDialog`（破坏性操作确认，目前完全缺失）。
- `Tooltip`（字段提示）。
- `Pagination`（列表分页/加载更多）。
- `Badge`（中性变体；与 status-only 的 `StatusBadge` 区分）。
- `CodeBlock`（响应/报告展示，替代手搓 `<pre>`）。
- `Drawer`（侧滑面板，重于 Modal，后续通道/模型详情用）——可按需。

**无障碍**

- 可点击的 `EntityCard`、`DataTable` 行改为可聚焦可键盘操作（`role="button"` + `tabIndex` + Enter/Space），恢复全局 focus ring。
- `Modal` 加焦点陷阱：开启时聚焦首个可聚焦元素、Tab 循环、关闭归位触发元素（抽 `useFocusTrap`，供 Drawer/ConfirmDialog 复用）。
- `Select` 补方向键/Home/End/Enter/type-ahead 与列表内 roving focus。
- `StatusBadge` 改为 `{tone, label}`，由页面传入已翻译文案（停止渲染原始英文枚举）。
- `Button` 加 `loading`（置 `aria-busy` 并禁用），mutation 进行中防重复提交。
- `toast` 容器加 `aria-live`（error 用 assertive）。

**结构**

- 拆分 `ConsoleLayout.tsx`（333 行）为 `components/console/chrome/{Rail,SubNav,TopBar,BottomTabs}.tsx`，`ConsoleLayout` 仅作组合根。
- `useSetConsoleAction/Filters/Back` 改为 `(render, deps)` 签名，内部 memo，消除"必须调用方 useMemo 否则死循环"的暗坑。

### L3 — 动效系统

- 套用 L0 的 `--dur-*`/`--ease-*` token；`lib/motion/gsap.ts` 设 `gsap.defaults({ease:'power3.out', duration:.42})`。
- **统一 reduced-motion**：用 `gsap.matchMedia()` 让 full / reduced 变体并存，取代散落的 `if(reduced) return`；补上背景 blob 指针视差、全局 `scroll-behavior:smooth` 的 reduced-motion 处理；加一个 CSS 安全网兜底。
- `gsap.from` 在可重跑的 effect 中改用 `gsap.fromTo`（避免重渲染卡在中间态）。
- **登录页动效全套**（点名缺失）：分段 tab 滑动指示器 + 切换时表单体交叉淡入；提交失败错误抖动（`elastic.out`）+ 边框红脉冲；提交 loading（行内 spinner）/成功微动；字段聚焦的标签上浮/描边。
- `Modal`/`Toaster` 进出场（背板淡入 + 对话框缩放进、退出后再卸载；toast 滑入/滑出）。
- 路由转场：`<Outlet/>` 按 `pathname` 做 keyed 淡入/上滑。
- `CardCollection` stagger 揭示；`StatCard`/Dashboard 数字 count-up（复用 LiveConsole 已有技法）。

## 4. 两个紧急修复（不依赖排期，优先做）

1. **删除全局 ScrollTrigger 杀除**：`components/landing/FeaturePan.tsx` 与 `LiveConsole.tsx` 的 `return () => ScrollTrigger.getAll().forEach(s => s.kill())` —— 会杀掉全页所有 trigger，`useGSAP` 本就自动清理。删掉（或只杀自身 `self.scrollTrigger`）。
2. **客户端 `patch`/`delete` + 通道字段修复**：解锁通道编辑、消除"seed-only"过时假设（i18n `channels.note` 删除）。

## 5. 实施顺序与检查点

自底向上，每层一个检查点（typecheck + lint + build 绿 + 浏览器验证关键页）：

1. **L0**（含紧急修复 #1）：token + 规范 + 删 ScrollTrigger bug + `CONVENTIONS.md`。
2. **L1**（含紧急修复 #2）：client 动词 + query keys + 缓存策略 + `useUrlState` + `mutationError` + admin 方法/类型补齐 + 字段修复。把现有页面迁到集中 key + keepPreviousData + URL 过滤状态（验证：切租户/切页/刷新不丢不闪）。
3. **L2**：字段契约统一 + FormField + 无障碍 + 新基础组件 + 拆 chrome。把现有表单/卡片迁到新契约。
4. **L3**：motion token + matchMedia + 登录页动效 + Modal/Toaster/路由转场 + 列表揭示。

## 6. 验证策略

- 每层：`pnpm --filter @actionow/web typecheck && lint && build` 全绿。
- 关键交互用浏览器预览验证（`:4173`）：
  - 缓存：切租户过滤 → 列表不闪、URL 带 `?tenant=`；刷新后保留；切 nav tab 再回来即时显示。
  - 无障碍：键盘 Tab 能聚焦卡片/行并 Enter 打开；Modal 内 Tab 不逃逸、关闭焦点归位；Select 方向键可用。
  - 动效：登录页 tab 切换/错误抖动/提交 loading 可见；reduced-motion 下退化为静态/仅透明度。
  - 深/浅双主题、移动端底栏不回归。
- 现有单测（`lib/api/admin.test.ts` 等）保持绿；为 `queryKeys`、`useUrlState`、`mutationError`、新基础组件补轻量单测。

## 7. 附：审计来源

5 份 agent 报告（架构/样式/组件/动效/API）的合并结论。完整发现见会话记录；高杠杆项已并入上面各层。
