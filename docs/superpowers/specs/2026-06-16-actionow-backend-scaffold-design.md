# Actionow 统一 AI 能力平台 — 后端脚手架设计 (Design Spec)

> 状态：待 user 评审
> 日期：2026-06-16
> 范围：后端脚手架 + 数据库 + 基础设施。**不含前端**（仅产出 OpenAPI 供日后建台）。
> 上游设计文档：`/.actionow_review_spec.md`（含多智能体评审结论）。

---

## 0. 决策记录 (Decisions Log)

| #   | 决策                         | 选择                                                                | 备注                                               |
| --- | ---------------------------- | ------------------------------------------------------------------- | -------------------------------------------------- |
| D1  | 技术路线                     | TypeScript 单体仓库（greenfield）                                   | 不基于 New API，避免 AGPL 耦合与阻抗失配           |
| D2  | 数据库                       | PostgreSQL                                                          |                                                    |
| D3  | 金额表示                     | credits = 整数最小单位（bigint，微 credit）                         | 禁二进制浮点做账（评审 #6）                        |
| D4  | 后端框架                     | NestJS                                                              | 多子域模块边界 + DI + guards                       |
| D5  | ORM                          | Drizzle（SQL-first）                                                | 利于账本原子条件更新 / 精确 decimal / 版本快照     |
| D6  | 消息队列                     | BullMQ（Redis 支撑）                                                | 统一承载 job 执行 / webhook outbox / reaper / poll |
| D7  | 缓存/锁/限流/幂等            | Redis                                                               | 与 BullMQ 共用实例                                 |
| D8  | Dify 深度                    | DSL 解析 + BYO 注册管线（不含托管 provision）                       | 仅 `workflow` 模式                                 |
| D9  | 前端                         | 本期不做                                                            | API 出 OpenAPI                                     |
| D10 | 安全/合规层                  | 排除（user 明确不需要）                                             | 仅保留 SecretRef 抽象与不落日志纪律                |
| D11 | 首批适配器                   | `openai` · `anthropic` · `gemini` · `async-media-mock` · `dify-byo` | gemini 为独立映射，非 openai 别名                  |
| D12 | OpenAI 兼容端点              | 本期做（薄视图，复用同一管线）                                      | 仅 `modality=text`                                 |
| D13 | 代码组织                     | 模块化单体 @ pnpm monorepo（api 应用 + worker 应用共享 packages）   | 可后续拆服务                                       |
| D14 | 脚手架将内建评审的结构性修复 | 是                                                                  | 见 §10 映射表                                      |
| D15 | 代码风格                     | Profile 1：ESLint+Prettier · 严格类型 · 架构边界                    | 详见 §14                                           |

---

## 1. 目标与非目标

**目标**：交付一个可运行的、结构完整的后端脚手架，把统一调用面（§4 of 上游文档）、Job 状态机（§5）、Provider Adapter 抽象（§6）、Dify BYO 接入（§7）、多租户/鉴权/账户（§8）、计价与预扣结算账本（§9）、核心数据模型（§10）落地为 TypeScript 代码骨架与基础设施，并让一条 LLM 调用链与一条异步调用链端到端跑通。

**非目标**（本期不做）：任何前端 UI；托管 Dify provision / 装插件 / 重绑 provider；`advanced-chat`（chatflow）模式；内容安全 / 备案 / 实名 / 数据出境等合规层；publisher 分成结算与提现；生产级多上游健康度量与自动调度的精细化。

---

## 2. Monorepo 布局

```
actionow-core/
├─ apps/
│  ├─ api/                # NestJS HTTP：公共 /v1 + /admin REST
│  └─ worker/             # NestJS standalone（无 HTTP）：BullMQ 处理器
├─ packages/
│  ├─ contracts/          # DTO + zod schema + io_schema 类型；OpenAPI 唯一真相源
│  ├─ domain/             # 纯领域逻辑（无 IO）：pricing 引擎、ledger、job 状态机、io_schema→zod 校验器
│  ├─ db/                 # Drizzle schema + 迁移 + repository 封装
│  ├─ adapters/           # ProviderAdapter 接口 + 5 个实现
│  ├─ dify/               # DSL 解析→io_schema、兼容/成本报告、BYO 注册
│  └─ infra/              # redis/bullmq/锁/限流/secret-ref/logger/tracing/config
├─ docker-compose.yml     # postgres + redis
├─ drizzle.config.ts
├─ pnpm-workspace.yaml
├─ turbo.json
├─ tsconfig.base.json
└─ docs/
```

**设计原则**：`domain` 是纯函数核心（不触 DB/网络），计价与账本状态转移可被单测穷尽；`db` 与 `infra` 是其 IO 边界；`api`/`worker` 仅为薄装配层。每个 package/模块：单一职责、对外暴露明确接口、可独立理解与测试。

---

## 3. API 层（apps/api，NestJS 模块）

### 3.1 公共面 `/v1`（需 API Key 鉴权，以租户上下文执行）

| 端点                                           | 说明                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------- |
| `POST /v1/run/{resource_id}`                   | 通用调用；按 io_schema 校验；exec_mode auto/blocking/stream/async |
| `GET /v1/jobs/{id}`                            | Job 轮询                                                          |
| `POST /v1/jobs/{id}/cancel`                    | 取消（仅 queued/running；终态幂等）（补评审 #13）                 |
| `GET /v1/jobs`                                 | 列表 + 游标分页（运维/恢复枚举 in-flight）                        |
| `GET /v1/resources` / `GET /v1/resources/{id}` | 资源目录发现                                                      |
| `POST /v1/chat/completions`                    | OpenAI 兼容薄视图，仅 `modality=text`（D12）                      |
| `POST /v1/callbacks/{provider}`                | 上游异步回调入口（async-callback）                                |

SSE：`POST /v1/run/{id}` 带 `Accept: text/event-stream` → `delta`/`usage`/`done`/`error` 事件。

### 3.2 管理面 `/admin`（账号体系 + RBAC）

纯 REST + OpenAPI（前端日后照建）：catalog（resource、upstream_channel）、pricing（pricebook_entry、modifier）、tenants/accounts、api_keys、dify 导入（上传 DSL→报告→注册）、jobs 查询、ledger 查询。

### 3.3 NestJS 模块清单

`TenancyModule · AuthModule · AccountsModule · LedgerModule · PricingModule · CatalogModule · ExecutionModule · JobsModule · WebhooksModule · AdaptersModule · DifyModule · AdminModule · HealthModule · ObservabilityModule · ConfigModule`。

---

## 4. 运行时主轴（核心）

### 4.1 `POST /v1/run/{id}` 链路

1. **Guard**：ApiKey 校验（hash 查表 + `resource_allowlist`）→ 解析 tenant 上下文 → 两级限流（Redis 令牌桶：tenant + resource）→ 失败返回 `429 rate_limited` + `retry_after_ms`。
2. **幂等**：`idempotency_key` 命中（Redis 短 TTL + DB `unique(tenant_id, idempotency_key)`）→ 重放返回原 job，不重复执行。
3. **校验**：载入 resource（含 version 快照）；按 io_schema 编译出的 zod 校验 inputs → 不符返回 `invalid_input`。
4. **exec_mode 解析**：`auto` 依据 resource.exec_modes/modality 决策（长任务转 async）。
5. **quote**：→ P（事前 pre）或上限估值 M（事后 post）。
6. **hold**：原子条件更新
   `UPDATE account SET credit_held = credit_held + :amt WHERE id=:id AND credit_balance - credit_held >= :amt`
   影响行数 0 → `insufficient_credits`（评审 #10）。写 ledger `hold` 交易。**创建 job 时冻结一组版本快照**：`resource_version`、`pricebook_entry_id+version`、`dsl_hash`、命中 `modifier_id + 当时取值`、`quoted_credits`、`hold_id`、`hold_expires_at`（评审 #4/#7）。
7. **分支执行**：
   - `blocking`：同步 `adapter.submit` → 结果 → `settle`。
   - `stream`：SSE 推 `delta`；终态拿 usage → `settle`。
   - `async`：入 BullMQ `job-exec` 队列，返回 `{job_id, status:queued}`；worker 取出 `submit`（得上游句柄）→ `poll-upstream`（延时重复任务，async-poll）或等 `/v1/callbacks`（async-callback）→ 终态 → `settle`。
8. **路由与容灾**（adapter 内）：加权随机选 channel；**区分 pre-submit 失败（TCP/401/400/429-before-accept，可安全切渠道）与 post-submit 不确定失败（已发出但超时/5xx/中断 → 非幂等 resource 默认不盲切）**；每个 attempt 落记录；`settle` 只认一个被确认的终态句柄（评审 #3）。adapter/resource 标 `idempotent_submit` 能力位，仅当可向上游传幂等键或声明可安全重放时才允许跨渠道重试。

### 4.2 `settle()`（全链路唯一、幂等）

```
原子状态转移：UPDATE job SET status=:terminal WHERE id=:id AND status IN ('queued','running')
  rows=1 → 继续；rows=0 → no-op 去重返回（评审 #11）
单 DB 事务内：
  过修饰栈算终价 F（post 按真实 usage；pre 确认 P）
  → 取整到整数最小单位（唯一取整时机）
  → 释放 hold（credit_held -= hold_amt）+ 扣 F（credit_balance -= F）
  → 写 ledger `settle` 交易（含版本快照、usage_vector、balance_after）
  → 若有 callback_url：写 webhook_outbox 行
唯一约束 unique(job_id) WHERE type='settle' 兜底
```

`webhook-outbox` dispatcher（worker）：发 HMAC 签名 webhook、指数退避重试、按 `job_id` 去重、死信归档。webhook 成败**绝不影响资金正确性**（评审 #11）。

### 4.3 失败 / 取消 / 回收

- `failed`/`canceled`：释放 hold；退款按 pricing_model 分叉策略（见 §6.3）。
- **hold-reaper**（worker 定时）：扫 `hold_expires_at < now` 且 job 未终态 → 置 `canceled` + 释放 hold（写 release/refund）；与上游迟到回调互为幂等 no-op（评审 #12）。

---

## 5. 数据模型（packages/db，Drizzle / Postgres）

§10 全部实体 + 评审修复字段。所有业务实体带 `tenant_id`。`credits` 全程 `bigint`（最小单位）。

```
tenant(id, name, isolation_mode, created_at)
account(id, tenant_id, credit_balance, credit_held, ...)        -- CHECK(credit_balance >= credit_held)
api_key(id, tenant_id, hash, resource_allowlist[], rate_limit, status)
admin_user(id, email, password_hash, role, status)
resource(id, tenant_id, kind, modality, provider_type, exec_modes[], status, current_version, created_at)
resource_version(resource_id, version, io_schema(jsonb), created_at)  -- unique(resource_id, version)
upstream_channel(id, resource_id, provider_type, credential_ref, weight, status)
dify_binding(resource_id, resource_version, mode, dify_app_endpoint, dify_service_key_ref,
             dsl_hash, pricing_model, required_secrets[], compat_report(jsonb), provision_mode)
job(id, tenant_id, resource_id, resource_version, status, exec_mode,
    inputs(jsonb), output(jsonb), usage(jsonb), upstream_job_handle,
    pricebook_entry_id, pricebook_version, modifiers_snapshot(jsonb), quoted_credits,
    cost_credits, hold_id, hold_expires_at, callback_url, idempotency_key, end_user,
    error(jsonb), created_at, updated_at)
pricebook_entry(id, resource_id, resource_version, version, method, timing,
                dimensions|table|amount|formula(jsonb), markup(jsonb), active)
modifier(id, scope, when_expr, op, value, stackable, priority, version, active)  -- 版本化（评审 #7）
ledger_txn(id, tenant_id, account_id, type, credits_delta, balance_after,
           resource_id, job_id, pricebook_version, modifiers_applied(jsonb),
           usage_vector(jsonb), created_at)                       -- append-only
gift_code(code, tenant_scope, credits, kind, status, expires_at)
idempotency_key(tenant_id, key, job_id, created_at)               -- unique(tenant_id, key)
webhook_outbox(id, job_id, url, payload(jsonb), status, attempts, next_attempt_at, created_at)
secret_ref(id, provider, locator, created_at)                    -- vault 指针，明文不入库
```

关键约束：`unique(tenant_id, idempotency_key)`；`unique(job_id) WHERE type='settle'`；`CHECK(credit_balance >= credit_held)`；`unique(resource_id, version)`；pricebook/binding 外键指向 `(resource_id, resource_version)`（三套版本以 resource_version 为对齐锚，评审 #4）。

---

## 6. 计价与账本（packages/domain）

### 6.1 价目表 method

`unit | matrix | fixed | formula | passthrough`；`timing`：`pre | post`。`formula` 用受限表达式求值器（白名单运算、无 IO、确定性）。`matrix` key 未命中→明确兜底错误而非静默 0。

### 6.2 修饰栈（有序，固定求值顺序）

基价 → 租户协议覆盖 → 阶梯量折 → 促销/优惠券 → publisher 加价 → **取整** → 入账。默认折扣策略：同类取最优、跨类按序叠（§14 待定项 1 默认值，代码内可配置）。modifier 命中时把 `(modifier_id, version, 当时 value)` 固化进 job 快照与 ledger，保证历史账单 100% 可重放。

### 6.3 quote → hold → settle

统一覆盖事前/事后/同步/异步/流式（见 §4）。失败退款**按 pricing_model 分叉**（评审 #2/#8 焊入骨架接口，策略可配）：

- 透传/post 类工作流：工作流层不独立 settle，只对已完成子调用计量求和 + 加价；部分失败 = 未发生子调用不计（依赖 Dify node 事件，本期 BYO 不支持 metered，故此分支为接口预留）。
- fixed/matrix 类：工作流层独立 hold/settle，失败按固定价退款策略。

> 注：评审根因「Dify 节点级子调用事件源」在本期 **BYO** 下不可得，故 passthrough/metered 仅作接口与表结构预留，运行不启用（见 §7）。

---

## 7. Dify 接入（packages/dify）

**DSL 解析**：解析 YAML → 校验 `kind: app` / `version`（兼容判断）/ `app.mode`（首期仅 `workflow`）→ 从 Start 抽 inputs（Dify 类型→统一类型+UI 控件）→ 从 End 抽 outputs（`value_selector` 回溯被引用节点推类型，render 标「需人确认」）→ 清点图产「兼容&成本报告」（未知模型 / 知识库引用 / 需补凭证工具 / 外部 http / code 节点 / 缺失插件 全部标红）。

**BYO 注册管线**：用户给已发布 app 的 `endpoint + key` → 存 `dify_binding`（`provision_mode=byo`）→ 组 resource（io_schema + `provider_type=dify-workflow` + 计价声明）→ 人确认 → 注册，`version = DSL 内容 hash`。运行期走 Dify Service API（`POST /v1/workflows/run`），与视频模型同构（共用 §4 调用面 / 状态机 / 账本）。

**焊死约束（评审 #2）**：`provision_mode=byo ⇒ pricing_model ∈ {fixed, matrix}`，**禁 `metered`**（BYO 拿不到网关侧子调用，metered/passthrough 仅托管场景，本期不启用）。binding 写入时校验。

---

## 8. 适配器（packages/adapters）

接口：`validate · submit · poll · parse_callback · extract_usage · map_error` + 能力位 `idempotent_submit`。

| adapter            | modality       | exec_modes                 | 落地深度                                                                                        |
| ------------------ | -------------- | -------------------------- | ----------------------------------------------------------------------------------------------- |
| `openai`           | text           | blocking, stream           | 真实；复用给 `/chat/completions`                                                                |
| `anthropic`        | text           | blocking, stream           | 真实；messages 映射                                                                             |
| `gemini`           | text           | blocking, stream           | 真实；**独立映射**（`contents[]`/`generateContent` 或 Google OpenAI-compat 层），非 openai 别名 |
| `async-media-mock` | image/video    | async-poll, async-callback | 上游可 mock（假延迟），让异步状态机/poll/webhook 全链路无需付费 key 即可跑通                    |
| `dify-workflow`    | composite/text | async-poll                 | 真实 BYO（见 §7）                                                                               |

新增上游 = 新增一个 adapter，不改调用面。多上游路由复用 §4.1 的加权随机 + 故障转移。

---

## 9. 横切关注与基础设施

- **Config**：`@nestjs/config` + zod 校验 env。**SecretRef 抽象**（env provider 现用、vault provider 后插）；密钥不入库、不入日志。
- **错误**：全局 exception filter → §4.7 统一码集合（`invalid_input`/`insufficient_credits`/`resource_not_found`/`rate_limited`/`upstream_error`/`upstream_timeout`/`content_filtered`/`job_failed`/`unauthorized`/`internal_error`）；脱敏后透传上游原始信息。
- **可观测**：pino 结构化日志 + `trace_id`（AsyncLocalStorage）；OpenTelemetry 钩子；`/health`、`/ready`；`/metrics`（prometheus）。（补评审遗漏角度）
- **队列**（BullMQ）：`job-exec`（异步执行）、`webhook-outbox`（回调派发）、`hold-reaper`（定时回收孤儿 hold）、`poll-upstream`（async-poll 延时轮询）。
- **Redis**：缓存（resource/pricebook）、分布式锁（account/settle 串行化）、两级限流令牌桶、幂等短 TTL。
- **docker-compose**：postgres + redis，一键起本地依赖。

---

## 10. 评审修复 → 骨架映射

| 评审项                        | 骨架内建做法                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------ |
| #3 故障转移盲目重试非幂等任务 | pre/post-submit 失败区分 + `idempotent_submit` 能力位 + attempt 记录（§4.1.8） |
| #4 job 不冻结版本快照         | job 建时冻结 resource_version/pricebook/modifier 快照（§4.1.6, §5）            |
| #6 浮点积分                   | credits = bigint 最小单位，唯一取整时机（§4.2, D3）                            |
| #7 modifier 无版本            | modifier 版本化 + 命中值固化进 job/ledger（§5, §6.2）                          |
| #10 account 并发超卖          | 原子条件更新 + `CHECK(balance>=held)`（§4.1.6, §5）                            |
| #11 settle 去重 + 跨表原子性  | 原子状态转移 + `unique(job_id) where type=settle` + 事务性 outbox（§4.2）      |
| #12 孤儿 hold                 | `hold_expires_at` + hold-reaper（§4.3, §9）                                    |
| #13 缺生命周期端点            | `/jobs/{id}/cancel` + `GET /jobs` 分页（§3.1）                                 |
| #2 BYO 下 metered 不成立      | `provision_mode=byo ⇒ pricing_model≠metered` 焊死（§7）                        |
| 契约空洞（幂等）              | `idempotency_key` 全链路语义（§4.1.2, §5）                                     |
| 可观测缺位                    | trace_id/metrics/health（§9）                                                  |

---

## 11. 测试与种子

- **框架**：vitest。
- **domain 单测（TDD）**：计价四象限（unit/matrix/fixed/passthrough）、修饰栈求值顺序、ledger 状态转移（hold/settle/refund/去重）、io_schema→zod 校验。
- **集成（testcontainers：pg + redis）**：账本原子性（并发 hold 不超卖）、幂等重放、执行管线（blocking + async→poll→settle）。
- **e2e**：`/run` happy-path、`insufficient_credits`、幂等重放、async 全链路、cancel。
- **seed 脚本**：1 tenant + 1 admin + 1 api_key + 1 `openai` resource + pricebook + 一笔 topup → 开箱即可 `/run`。

---

## 12. 验收标准（脚手架"完成"的定义）

1. `docker-compose up` + 迁移 + seed 后，用 seed 的 api_key 对 `openai` resource 发 `POST /v1/run` blocking 调用，返回 output + usage + cost，且 ledger 出现一笔 settle、account 余额正确扣减。
2. 对 `async-media-mock` resource 发 async 调用，返回 job_id；轮询 `GET /v1/jobs/{id}` 经历 queued→running→succeeded；带 callback_url 时收到 HMAC 签名 webhook。
3. 余额不足时 `hold` 失败返回 `insufficient_credits`，不入队、不写 settle。
4. 同一 `idempotency_key` 重放返回同一 job，不重复扣费。
5. 上传一个 BYO `workflow` 模式 Dify DSL，产出兼容报告并注册成一个 resource，`GET /v1/resources/{id}` 可见其 io_schema。
6. `domain` 包单测、关键集成测通过；`/health` `/ready` `/metrics` 可用。

---

## 13. 本期不做 / 已知预留

- 前端（仅 OpenAPI）；托管 Dify provision；advanced-chat；内容安全/合规层；publisher 分成。
- passthrough/metered 计量为接口与表结构预留，运行不启用（依赖 Dify node 事件，托管期再做）。
- 多上游健康度量驱动的智能调度（本期仅加权随机 + 故障转移）。

---

## 14. 代码风格与工程规范 (Code Style — Profile 1)

### 14.1 工具链

- **ESLint flat config**（`eslint.config.js`）+ `typescript-eslint`：`strict-type-checked` + `stylistic-type-checked`。
- **Prettier**（仅格式化）+ `eslint-config-prettier`（关闭与 Prettier 冲突的规则）。
- 插件：`eslint-plugin-import-x`、`eslint-plugin-simple-import-sort`、`eslint-plugin-boundaries`、`@typescript-eslint`、`eslint-plugin-vitest`（测试）。
- 提交钩子：`husky` + `lint-staged`（pre-commit 对 staged 文件跑 `eslint --fix` + `prettier --write`）+ `commitlint`（Conventional Commits）。
- monorepo 编排：`turbo`（lint/test/build 缓存）。

### 14.2 Prettier 格式

`singleQuote: true · semi: true · printWidth: 100 · tabWidth: 2 · trailingComma: 'all' · arrowParens: 'always'`。

### 14.3 TypeScript 严格度（`tsconfig.base.json`）

`strict: true · noUncheckedIndexedAccess · exactOptionalPropertyTypes · noImplicitOverride · useUnknownInCatchVariables · verbatimModuleSyntax · isolatedModules`。
ESLint 强制：`no-explicit-any`(error)、`explicit-module-boundary-types`、`consistent-type-imports`（`import type`）、**`no-floating-promises` / `no-misused-promises`**（异步资金正确性关键）。

### 14.4 导入排序（simple-import-sort）

`node 内置 → 外部依赖 → 内部包(@actionow/*) → 相对路径`；`import type` 与值导入分组。

### 14.5 架构边界（eslint-plugin-boundaries，守住设计底线）

按 package 定义 element 类型，强制依赖方向（违反即 lint 报错）：

| package                    | 允许导入                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| `contracts`                | （叶子，不依赖任何内部包）                                                                |
| `domain`                   | `contracts` **only** — 禁 db/infra/adapters/nestjs/drizzle/redis/bullmq（保持纯函数核心） |
| `db`                       | `contracts` · `domain`                                                                    |
| `adapters`                 | `contracts` · `domain` · `infra`                                                          |
| `dify`                     | `contracts` · `domain` · `infra`                                                          |
| `infra`                    | `contracts`                                                                               |
| `apps/api` · `apps/worker` | 任意 package                                                                              |

`domain` 额外用 `no-restricted-imports` 黑名单 `nestjs/drizzle/ioredis/bullmq` 二次兜底。

### 14.6 命名（@typescript-eslint/naming-convention）

类型/接口/类 `PascalCase`（接口**不**加 `I` 前缀）；变量/函数 `camelCase`；枚举成员 `PascalCase`；文件名 `kebab-case`。DB 表/列 `snake_case`（Drizzle 定义），TS 侧映射为 `camelCase`。优先**具名导出**（除框架要求处）。

### 14.7 错误处理与契约

- `domain` 抛**带 `code` 的类型化领域错误**（自定义 Error 子类）；`api` 全局 exception filter 统一映射到 §4.7 错误码集合。
- 禁静默 catch；值对象/DTO 默认 `readonly`。
- **zod 为运行期校验唯一真相源**，TS 类型由 zod `infer`（`contracts` 包）。

### 14.8 注释

导出 API 写 TSDoc；注释密度与上下文一致；不写复述代码的冗余注释。
