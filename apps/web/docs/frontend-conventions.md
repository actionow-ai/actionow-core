# apps/web 前端实现约定（graphite 设计体系）

本文件是页面实现者（人或 agent）的单源约定。视觉/组件/骨架规范的完整声明在
`~/frontend-design-templates/templates/graphite/declarations/{design,craft,components,templates}.md`，
本文只记录本项目落地的接线与业务约定。

## 架构

- 双控制台：`/console/*` = 平台管理台（调 `/admin/*` API，需 JWT `role=admin`）；
  `/app/*` = 租户台（调 `/console/*` API）。壳层在 `src/components/layout/{console,tenant}-shell.tsx`。
- 每页三段式：`PageTransition` 包裹 → `PageHeader`（title + description 必填）→ 内容区。
- 路由已在 `src/App.tsx` 全部注册（lazy），页面文件与导出名不可改。

## API 调用

- `apiFetch<T>(path, { method, body, query })`（`@/api/client`）：自动带 Bearer、401 刷新重试、
  统一错误信封 → `ApiError { status, code, message, retryable, requestId }`。
- 列表一律游标分页信封 `PageOf<T> = { data, next_cursor, has_more }`，query 参数 `cursor` + `limit`。
  用 `useCursorQuery<T>({ key, path, query, limit })`（`@/api/hooks`），返回 `rows`（拍平窗口）
  - react-query infinite 查询字段；表尾放 `<LoadMore count hasMore loading onLoadMore/>`。
- 少量端点返回裸数组（如 `/admin/breakers`）或单对象，用 `useQuery` + `apiFetch` 直接取。
- 写操作用 `useMutation`，成功后 `queryClient.invalidateQueries({ queryKey: [...] })`。
- 错误展示：`<ApiErrorNotice error={toApiStateError(query.error)} onRetry={() => void query.refetch()} />`；
  加载骨架 `<ResourceLoading rows={n} />`（均自 `@/components/shell/api-state`）。
- 钱：响应里全是 µ积分十进制字符串（1 积分 = 1_000_000 µ），显示用
  `<MoneyText value={x} />`；请求体里金额是人类数字（看各端点契约）。
- 时间戳：`<DateTimeText value={iso} />`。

## 共享组件（`@/components/common/*`）

- `MoneyText` / `DateTimeText` / `CopyButton value label?`
- `ConfirmDialog open onOpenChange title description? confirmLabel? destructive? pending? onConfirm`
- `FormField label hint? error? children={(id) => <Input id={id} … />}`（label 关联自动生成 id）
- `DetailList items=[{label, value}]`（详情卡）
- `LoadMore count hasMore loading onLoadMore`

## graphite 组件速查（导入路径逐字）

```tsx
import { Button } from '@/components/ui/components/buttons/button'; // variant×7 size×6, asChild 支持
import {
  Badge,
  Card,
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTablePagination,
  DataTableRow,
  DataTableSortHead,
  DataTableToolbar,
  Skeleton,
} from '@/components/ui/data-display';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/components/radix/dialog';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/components/radix/sheet';
import {
  Tabs,
  TabsContent,
  TabsContents,
  TabsList,
  TabsTrigger,
} from '@/components/ui/components/animate/tabs';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/components/animate/tooltip';
import { Input, Textarea } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { EmptyState, PageHeader, PageTransition, StatCard } from '@/components/shell/page';
import { useDataTable } from '@/hooks/use-data-table';
```

- `StatCard`：`title/value/detail/icon` 全必填，`icon` 传**组件**（`icon={Wallet}`）不是元素。
  `EmptyState` 的 `icon` 同理。
- 列表页骨架：`DataTableToolbar`（搜索/刷新）+ `DataTable` + `DataTableSortHead`（客户端排序用
  `useDataTable({ sortValues, pageSize })`）+ 表尾（服务端游标列表用 `LoadMore`；纯客户端小列表用
  `DataTablePagination`）。
- 表格行内操作：`variant="ghost" size="icon-sm"` + `aria-label`；删除确认用 `Dialog`（ConfirmDialog）。
- 语义色只在结果/风险 Badge：`success`=健康/成功，`warning`=排队/降级/半开，`danger`=失败/熔断；
  分类用 `neutral`，主实体强调用 `primary`。
- 状态枚举 → Badge 映射写成模块级 `const xxxVariant = { ... } as const`。

## 硬性护栏（CI 会拦）

- 业务层禁原生 `button/input/select/textarea/dialog`（用 ui 封装；`label/form/table` 原生可用）。
- 全源码禁 emoji；禁裸色值/px 阴影/ms 时长字面量（用 token 与 motion.ts 常量）。
- `<DataTable loading>` 必须同时传 `error`（eslint 规则强制，配 `onRetry`）。
- eslint: simple-import-sort、consistent-type-imports（类型导入加 `type`）、
  no-floating-promises（`void promise` 或 await）。Prettier printWidth 100 singleQuote。
- i18n：所有文案走 `t('ns.key')`，本区键写进本目录 `locale.ts`（`zhCN`/`en` 两份都给全）。
  导出形如 `export const locale = { zhCN: { myNs: {...} }, en: { myNs: {...} } }`，
  命名空间已在 `src/locales/index.ts` 注册，不要改注册表或他人 locale。

## 布局速记

- 统计行：`grid gap-4 sm:grid-cols-2 xl:grid-cols-4`；详情页 `lg:grid-cols-2` 双栏 Card；
  设置/表单页单列 `max-w-2xl`，每组一张 Card（`p-5`）。
- Card 无默认内距，自己加 `p-5`。分隔线 `divide-y divide-border/60`。
- ID/模型名/金额/数字用 `font-mono tabular-nums`。
