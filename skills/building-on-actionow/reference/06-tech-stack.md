# 06 · 技术栈选型(建在 core 上的 app)

**推荐照抄 core 自身的栈** —— 端到端 TypeScript、与 `@actionow/sdk` 对齐、团队已有共识与工具链,最省心。下表是各层的首选 + 备选 + 依据。非 TS 团队:用各自的 OpenAI 兼容客户端打中继 + 裸 HTTP 打 `/console`,`@actionow/sdk` 仅作类型参考(失去 `/console` 类型,按 gateway 的 `/docs` 对齐)。

## 选型表

| 层                     | 首选(与 core 一致)                                                                                                                                       | 备选                                                         | 依据 / 注意                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| **语言**               | TypeScript(strict)                                                                                                                                       | Python / Go(用 OpenAI 兼容 SDK + 裸 HTTP)                    | 薄后端 + 前端都 TS,`@actionow/sdk` 给端到端类型                                                          |
| **前端**               | React + Vite · TanStack Query · React Router · Tailwind(v4)+ 设计 token(CSS vars)· Phosphor 图标 · i18next · GSAP 动效                                   | Next.js(要 SSR / 全栈)                                       | 与 `apps/web` 一致;`ak_` 若下发前端要评估泄露风险(见铁律 1)                                              |
| **薄后端**             | NestJS(Express 平台,DI / 模块化)· jose(JWT)· Swagger                                                                                                     | Fastify · Hono · Next route handlers                         | 与 `apps/api` 一致;持 控制面 JWT + 每用户 `ak_`;用 `core-kit` 封装两 client                              |
| **契约 / 校验**        | Zod(contract-first:zod → openapi → 类型)                                                                                                                 | —                                                            | 照抄 core;你自身对外 API 也这样出类型(标准见 [ENGINEERING-GUIDE §6](../../../docs/ENGINEERING-GUIDE.md)) |
| **数据库**             | PostgreSQL + Drizzle ORM + postgres.js(`drizzle-kit` 迁移)                                                                                               | Prisma                                                       | **只存 core 的 ID**(subject_id / file_id / task_id)+ 你的业务数据,别镜像 core(见铁律 2)                  |
| **队列 / 异步**        | BullMQ + Redis(ioredis)                                                                                                                                  | 云厂商队列                                                   | 收 webhook、跑异步任务、重试 / 退避                                                                      |
| **缓存 / 限流 / 会话** | Redis(ioredis)                                                                                                                                           | —                                                            | JWT 刷新缓存、限流桶                                                                                     |
| **对象存储**           | **直接用 core 的文件能力**(presign)                                                                                                                      | 自建 S3 / R2 + `@aws-sdk/client-s3` + `s3-request-presigner` | 能复用就别自建(见 [01 复用矩阵](01-choose-your-scenario.md))                                             |
| **密钥**               | 环境加密 / KMS / Vault                                                                                                                                   | —                                                            | 控制面 JWT + `ak_` 绝不进浏览器 / 仓库                                                                   |
| **日志 / 可观测**      | pino(结构化)                                                                                                                                             | OpenTelemetry                                                | —                                                                                                        |
| **工具链 / 质量**      | pnpm + turbo(monorepo)· typescript-eslint(strict type-checked)+ Prettier · husky + lint-staged + commitlint · Vitest(+ testcontainers 起真实 PG / Redis) | —                                                            | 与 core 同一套门禁                                                                                       |

## 最小起步

[`examples/app-starter/`](../../../examples/app-starter/) 已是这套栈的**薄后端切片**:框架无关 `core-kit`(client / auth / money / retry / webhook / jobs)+ Express 示例 + Vitest。

- 换 **NestJS / Hono** 只改 `routes/`(`core-kit` 与框架无关,可直接搬进 Nest 的 provider)。
- 要真库,把内存 `store/users.ts` 换成 **Drizzle + PostgreSQL**(只存 `subject_id` + 加密的 `ak_`)。

> 注:脚手架用 Express(示例求极简),**推荐主力后端用 NestJS**(与 core 一致、DI / 模块化)。

## 与铁律一致

选型不改变 [SKILL.md](../SKILL.md) 的铁律:双 client 隔离 · 只存 ID · µcredit BigInt · 按 `retryable` 重试(任务创建带 `Idempotency-Key`)· webhook 时间戳验签 + `evt_id` 幂等 · SDK 类型面窄用裸 `fetch` · 按用户归因 = subject 级 `ak_`。
