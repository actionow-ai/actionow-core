# Contract-first 规范：API view 类型的单一真相源

> 这是底座「规范的 SDK」的地基（B1）。**对外的 HTTP view 类型只定义一次**——在 `packages/contracts` 里用 zod schema——后端与前端都从它派生,杜绝手抄漂移。配套战略分析见 [product-form-fit](./product-form-fit-2026-06-19.md)。

## 原则

```
packages/contracts/src/admin-views.ts   ← 唯一真相源(zod schema)
   ├─ 后端 apps/api：toView(...) 用 schema.parse() 校验响应   ← 漂移即报错
   └─ 前端 apps/web：import type 派生类型(类型擦除,零 zod 入浏览器包)
```

- **真相源 = zod schema**(不是 SDK,也不是手写 interface)。SDK 是它的派生物(后续 B3)。
- **后端**在 `toView` 边界 `.parse()`——映射一旦和契约不符,运行时立刻抛错,而不是把坏 JSON 发出去。
- **前端**只 `import type`——`z.infer` 出的类型在构建期被擦除,**zod 不会进浏览器 bundle**。
- 加/改一个字段,**只改 `packages/contracts` 一处**,前后端同步。

## 参考实现(B1 pilot:tenants / accounts)

- 契约:[`packages/contracts/src/admin-views.ts`](../packages/contracts/src/admin-views.ts) —— `tenantViewSchema` / `accountViewSchema` + `z.infer` 出的 `TenantView` / `AccountView`,并有 [契约测试](../packages/contracts/src/admin-views.test.ts)。
- 后端:`apps/api/src/admin/admin.controller.ts` 删掉本地 `interface TenantView/AccountView`,`toTenantView/toAccountView` 改为 `schema.parse({...})`。
- 前端:`apps/web/src/lib/api/types.ts` 删掉手写 interface,改 `export type { AccountView, TenantView } from '@actionow/contracts'`;`apps/web/package.json` 加 `"@actionow/contracts": "workspace:*"`。

验证(全绿):契约测试 2/2 · 后端 `admin-crud` e2e 6/6(tenant/account 视图经 parse 校验)· 前端 typecheck + lint + 269 测试 + `vite build`(确认 zod 未入包)。

## 迁移一个资源的配方(以此为后续规范)

1. **定义 schema**:在 `packages/contracts/src/admin-views.ts`(或新建按域分文件,如 `catalog-views.ts`)加 `xxxViewSchema = z.object({...})` + `export type Xxx = z.infer<...>`,并在 `index.ts` 导出。配一条契约测试(合法通过 / 缺字段或错类型抛错)。money 一律 `z.string()`(µcredit 十进制串,**绝不是 number**)。
2. **后端接线**:控制器删本地 `interface XxxView`,从 `@actionow/contracts` 导入;`toXxxView` 返回 `xxxViewSchema.parse({...})`。
3. **前端接线**:`lib/api/types.ts` 删手写 interface,改 `export type { Xxx } from '@actionow/contracts'`(**type-only**)。
4. **跑通**:契约测试 + 后端相关 e2e + 前端 `typecheck` & `build`。

> 命名约定:schema 用 `xxxViewSchema`(camelCase 值),类型用 `XxxView`(PascalCase),与既有 `*View` 命名一致。

## 路线(B1 → B2 → B3)

- **B1（本次,完成）**:view 类型单一真相源,先 tenants/accounts 立范式。
- **下一步**:把其余控制面 view(resources/channels/models/modifiers/pricebook/official-prices/route-groups/api-keys/relay-traces…)逐个迁到 `*-views.ts`;再统一**请求体**(后端已有 `createXxxSchema` zod,可直接搬进 contracts 与前端共享)。
- **B2**:`zod-to-openapi` 让 `/docs` 的响应 schema 变完整,并落地可构建的 `openapi.json`。
- **B3**:从契约**生成/封装** `packages/sdk`(TS 先行),前端 `lib/api` 改为消费它;再出 Python。这才是场景①「开箱即用 SDK」。

## ⚠️ 分支收敛(重要)

当前是**一个 monorepo、两个 worktree、两条分支**:`apps/web` 只存在于 `feat/admin-frontend`,而最新后端(含 `GET /admin/accounts`)在 `feat/console-usage-endpoints`。**契约共享要求两个 app 在同一分支**——所以 B1 做在 `feat/admin-frontend`(唯一同时有 `apps/api`+`apps/web`+`packages/*` 的地方)。

要让 contract-first 长期成立,**这两条分支需要收敛**(合并回 `main`),否则共享包会再次分叉。建议尽快把后端分支并入,统一在一条线上推进契约。
