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

- **B1(完成)**:view 类型单一真相源。已迁 8 个:tenants/accounts(`admin-views.ts`)+ resources/channels/models/modelGrants/pricebook/modifiers(`catalog-views.ts`)。
- **B2(完成)**:zod 契约 → `openapi.json`,脚本化可复现。
- **B3(完成)**:`openapi.json` → 独立 `packages/sdk`(生成类型 + typed `openapi-fetch` 客户端,`publishConfig.access=public`)。场景①「`npm install @actionow/sdk` 开箱即用」的雏形已就绪。
- **下一步**:把其余控制面/租户 view 逐个迁到 `*-views.ts`(同配方),并加进 `openapi.ts` 的 registry——每迁一个就自动进 OpenAPI + SDK;再统一**请求体**(后端已有 `createXxxSchema` zod,搬进 contracts 共享);把前端 `lib/api` 改为消费 `@actionow/sdk`(内外一致);出 Python 客户端。

### 端到端管线(怎么跑)

真相源是 `packages/contracts` 的 zod schema;**构建期**工具(`@asteasolutions/zod-to-openapi` 在 contracts、`openapi-typescript` 在 sdk,均为 devDep,绝不入前端/后端运行时)派生制品:

```
packages/contracts/src/*-views.ts        ← zod 真相源(后端 .parse() · 前端 import type)
        │  src/openapi.ts(build-time only,不在 index 导出)
        │  pnpm --filter @actionow/contracts gen:openapi
        ▼
packages/contracts/openapi.json          ← OpenAPI v3(已提交,可审 · 可喂任意 codegen)
        │  pnpm --filter @actionow/sdk gen   (openapi-typescript)
        ▼
packages/sdk/src/generated/openapi.ts    ← 生成类型(已提交,eslint/prettier 忽略,可复现)
        │  src/index.ts:createActionowClient() + 具名 view 类型导出
        ▼
@actionow/sdk                            ← 外部 `import { createActionowClient } from '@actionow/sdk'`
```

用法:

```ts
import { createActionowClient } from '@actionow/sdk';
const api = createActionowClient({ baseUrl: 'https://gw.acme.com', token });
const { data } = await api.GET('/admin/models'); // data.data: ModelView[]
data?.data.forEach((m) => console.log(m.name, m.input_price)); // input_price: string(µcredit)
```

已验证端到端:8 component schema + 7 list 路径;**关键不变量**——µcredit 金额在「zod → OpenAPI → SDK 类型 → 客户端返回」全链路保持 `string`(没退化成 number),`capabilities` → `object{additionalProperties:boolean}`,分页响应 `data.items` 正确 `$ref` 组件。openapi.json + 生成类型 + sdk 客户端均 typecheck/lint/test 通过;前端零影响(无 zod/openapi 工具入包);制品可复现(fresh gen 零 diff)。

## ⚠️ 分支收敛(重要)

当前是**一个 monorepo、两个 worktree、两条分支**:`apps/web` 只存在于 `feat/admin-frontend`,而最新后端(含 `GET /admin/accounts`)在 `feat/console-usage-endpoints`。**契约共享要求两个 app 在同一分支**——所以 B1 做在 `feat/admin-frontend`(唯一同时有 `apps/api`+`apps/web`+`packages/*` 的地方)。

要让 contract-first 长期成立,**这两条分支需要收敛**(合并回 `main`),否则共享包会再次分叉。建议尽快把后端分支并入,统一在一条线上推进契约。
