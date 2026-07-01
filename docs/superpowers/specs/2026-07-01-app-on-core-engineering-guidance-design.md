# 基于 core 快速构建 AIGC 应用 — 接入指南 + 脚手架设计规格

- **日期**: 2026-07-01
- **状态**: Draft / 待评审
- **作者**: Actionow team (with Claude)
- **前置**:
  - `skills/actionow-integration/`（机制层：怎么正确调用 `/v1`，本设计的下层）
  - `docs/INTEGRATION.md` · `examples/quickstart/` · `@actionow/sdk`
  - 产品定位记忆：数据存储 OUT（apps own DB）、apps own users（Model-B）、member-token `/v1/run` 已砍、core = 能力基座

---

## 1. 背景与问题

`actionow-integration` skill 回答了「一次调用对不对」（机制层）。它**没有**回答团队内部用户真正问的问题：

> 「我要基于 core **快速上线**一个 AIGC 应用。能直接用你们的**用户 / 积分 / 充值 / 模型**系统吗？如果我想有自己的用户体系,怎么把 core 当**能力基座**快速适配?给点**分场景**的接入说明、示例代码、脚本。」

这是**工程/架构层**的问题:选哪种接入姿势、复用什么、自建什么、按什么顺序搭、怎么写不踩坑。本设计交付这一层。

### 1.1 复用矩阵(基于当前代码实测,权威结论)

| core 的系统                                       | 能否直接复用 | 边界 / 关键事实(代码依据)                                                                                                                                                                                                                                                    |
| ------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **用户系统**                                      | ✅(Model-A)  | `subject` = 计费/归属身份 + **只读**自助。`POST /auth/register-member`·`login-member`(**body 必带 `tenantId`**)→ member JWT → 只读 `/member/{me,usage,balance,api-keys,limits}`。**不是**完整业务用户体系(无业务档案/你的权限模型)。                                         |
| **积分系统**                                      | ✅ 直接用    | 信用账本:租户池 `account` + 每用户子钱包 `sub_account`;hold→settle;治理额度 `limit_plan`。µcredit 整数(`1 credit = 1e6 µcredit`)。                                                                                                                                           |
| **充值系统**                                      | ✅ 直接用    | `POST /console/payments/intents {provider,amount_minor,currency}`(**无 `purpose`**)、`POST /console/redeem {code}` → `{credited,balance}`;端用户自助 `POST /v1/payments/intents`(**有 `purpose`**);子钱包 `/sub-account/{topup,transfer}`(`transfer` 守恒、`topup` 不守恒)。 |
| **模型系统**                                      | ✅ 核心能力  | OpenAI/Anthropic/Gemini 兼容中继 + 路由/容错/计费 + `GET /v1/models`。                                                                                                                                                                                                       |
| **文件/存储**                                     | ✅ 直接用    | presign 上传→confirm→下载 URL + 配额。                                                                                                                                                                                                                                       |
| 业务用户档案/权限、产品 UX、Prompt 编排、领域数据 | ❌ 自建      | core 不存业务数据、不做产品逻辑。                                                                                                                                                                                                                                            |

**必须知道的约束**:端用户的 **member JWT 不能直接打 `/v1`**(member-token 直连已砍)。真正的 AI 调用要么**你后端用 `ak_` 代理**(并带 `end_user=<external_id>` 归属),要么**给端用户发 subject-scoped `ak_`**。这条约束决定了三种场景都需要一个(哪怕极薄的)持 `ak_` 的服务端。

### 1.2 目标

- 让接入方**按场景**照着搭,最快上线;能力能复用的绝不让它重造。
- 明确「core 当能力基座」的标准姿势(Model-B)与「托管快启」的捷径(Model-A),并给**升级路径**。
- 交付 **skill(agent 可读)+ 工程规范文档(人读)+ TS 脚手架(可 clone)** 三件套,单一事实源。
- 不与 `actionow-integration` 重复端点细节 —— 交叉引用它。

---

## 2. 定位:core = 能力基座,三种接入姿势

「自建多少」的三档,`ak_` 服务端在三档里都存在(见 §1.1 约束):

|                       | 场景一 · 托管快启                 | 场景二 · 能力基座(**主线**)                | 场景三 · 混合                |
| --------------------- | --------------------------------- | ------------------------------------------ | ---------------------------- |
| 端用户身份            | **core**(Model-A,member 登录)     | **你**(Model-B,`external_id` 联邦 subject) | 你(Model-B)                  |
| 端用户自助(余额/用量) | core `/member/*`                  | 你自建(读 `/console/subjects/:id/*`)       | **core `/member/*`**         |
| 充值 UI               | core 托管(`/v1/payments/intents`) | 你自建 or 复用 core                        | **复用 core**                |
| 你要建的              | 前端 + 极薄 `ak_` 代理            | 用户/权限/业务库 + 联邦层 + 薄后端         | 用户库 + 复用 core 自助/充值 |
| 适合                  | 内部工具 / DEMO / 轻产品          | 长期演进的正式产品                         | 想少写计费界面的正式产品     |

**升级路径 一→二**:Model-A 的 subject 已有 `external_id`(可在建号时写你的用户 id),迁移 = 在你侧建用户表并回填 `external_id`,后续改由你认证 + 发 `ak_`;core 侧数据(subject/钱包/用量)不动。单独成节。

---

## 3. 场景 playbook(统一结构)

每个场景一节,固定小结构,便于对照:

1. **一句话** + 何时选它。
2. **复用矩阵**(本场景复用/自建的勾选)。
3. **架构 + 时序**(谁持什么凭证、调用序列)。
4. **凭证与信任边界**(JWT 仅服务端、`ak_` 谁持、是否下发到端)。
5. **逐步接入**(编号步骤,curl + TS 双写,引用 integration skill 的端点)。
6. **示例代码**(指向脚手架里的可跑文件)。
7. **脚本**(可跑验证)。
8. **反模式**(该场景特有的坑)。

### 3.1 场景一 · 托管快启(Model-A)

- 端用户在 core 注册/登录(`register-member`/`login-member`,带 `tenantId`)→ member JWT。
- 端用户自助(余额/用量/额度)直接用 `/member/*`;充值用 `/v1/payments/intents`。
- AI 调用:你的**极薄代理**持一把服务端 `ak_`,收到前端请求→校验 member JWT→用 `ak_` 代打 `/v1/chat/completions`,带 `end_user=<该 member 的 external_id 或 id>` 归属。**不把 `ak_` 下发浏览器**。
- 交付:最小可跑代理(一条 `/api/chat` 路由 + 一个 `Model-A 建号` 脚本)。

### 3.2 场景二 · 能力基座(Model-B,主线)

- 你自持用户/权限/业务库。新用户 onboard 一次:`POST /console/subjects {externalId=你的用户id}` → `POST /console/api-keys {subjectId}` → 存 `subject_id` + `ak_`(加密)到你的用户行。
- 充值:你的后端用控制面 JWT 调 `/console/payments/intents` 或 `/console/redeem`,或给 subject 开子钱包 `/sub-account/*`。
- AI 调用:后端用该用户的 `ak_` 打 `/v1/*`(或把 `ak_` 交给受信客户端)。
- 媒体:`/v1/run` + 轮询/webhook。文件:presign。
- 交付:**完整脚手架**(§4.3)。

### 3.3 场景三 · 混合(Model-B + 复用 core 自助/充值)

- 用户体系同场景二(你自持)。
- 但把「余额/用量/充值」界面直接托管给 core:给端用户签发 member JWT(需 Model-A 侧也建号,或 core 支持 B 用户拿只读 member token —— **开放问题 §8.1**),端用户直接读 `/member/*` + 走 `/v1/payments/intents` 自助充值。
- 交付:在场景二脚手架上,加一节「如何把 `/member/*` 自助嵌进你的前端」。

---

## 4. 三个交付物 + 单一事实源

内容单一事实源在 **skill**;工程文档是其叙述版;脚手架是其可跑体现。

### 4.1 配套 skill `skills/building-on-actionow/`（agent 可读/可执行）

```
building-on-actionow/
  SKILL.md                     选场景决策树 + 复用矩阵 + 主线黄金路径 + 铁律 + 索引
  README.md                    安装/定位(与 actionow-integration 的关系)
  reference/
    01-choose-your-scenario.md 决策树 + 三场景对比 + 复用矩阵
    02-scenario-managed.md     场景一 托管快启 playbook
    03-scenario-capability-base.md  场景二 能力基座 playbook(主线)
    04-scenario-hybrid.md      场景三 混合 playbook
    05-migration-A-to-B.md     升级路径 一→二
    06-tech-stack.md           TS 优先参考栈 + 其他语言兜底
    07-code-style.md           编码约定(双 client/µcredit/幂等/错误/webhook)→ 规则化
    08-your-own-api.md         你自身对外 API 的规范(contract-first/错误信封/分页/命名)
  scripts/                     可跑,复用 integration skill 的脚本 + 新增
    onboard-and-call.mjs       场景二端到端:登录→建 subject→发 key→充值→chat
    managed-proxy.mjs          场景一:极薄 ak_ 代理最小实现
    topup-demo.mjs             充值:intent + redeem + 子钱包
```

- **铁律**(SKILL.md,与 integration skill 一致但升级为工程规则):双 client 隔离(控制面 JWT 仅服务端 / 数据面 `ak_`)、只存 core 的 ID 不镜像数据(federation)、钱用 BigInt、按 `retryable` 重试(绝不重试 402/400)、billed 重试带幂等键、webhook 原始字节验签 + 快速 ack + 回拉 job、`end_user=external_id` 非 UUID。
- **不复制** integration skill 的端点细节;每处「怎么调」都链到 `actionow-integration/reference/*`。

### 4.2 工程规范文档 `docs/ENGINEERING-GUIDE.md`（人读）

skill 同源内容的叙述版:定位、三场景对比表、复用矩阵、逐场景要点、迁移路径、编码/自身 API 规范清单。面向人读与评审,进 repo `docs/`。

### 4.3 Starter 脚手架 `examples/app-starter/`（TS,场景二为准,升级 quickstart）

```
app-starter/
  packages/core-kit/           框架无关核心(可 npm 化)
    client.ts                  两 client 工厂(console JWT / data-plane ak_)
    auth.ts                    控制面登录 + JWT 刷新管理(token pair/refresh)
    money.ts                   µcredit BigInt 工具(parse/format/兑换)
    webhook.ts                 原始字节验签(转 @actionow/sdk/webhook)
    jobs.ts                    submit + 轮询/超时(转 submitAndWait)
    retry.ts                   按 retryable 的重试 + 幂等键
  apps/example-backend/        薄后端示例(默认 Express)
    routes/onboard.ts          Model-B onboard(建 subject + 发 key)
    routes/chat.ts             代打 /v1/chat/completions(阻塞+流式)
    routes/media.ts            /v1/run + 轮询/回调
    routes/topup.ts            充值 intent/redeem/子钱包
    routes/webhook.ts          job 回调接收(验签→回拉 job)
    routes/files.ts            presign 上传/下载
    db/                        你自持用户表(存 subject_id/ak_ 加密)—示意
    server.ts
  scenario-managed/            场景一极简变体(README 说明差异)
  .env.example  tsconfig(strict)  eslint  prettier  Dockerfile  ci.yml
  test/                        最小集成测试(mock fetch)
  README.md                    跑起来 + 场景切换 + 升级路径
```

- 框架切换:核心 `core-kit` 与框架无关;`example-backend` 默认 **Express**,README 注明如何换 Hono/Nest/Next。
- **在 `examples/quickstart` 基础上升级**,不从零(quickstart 的 client/onboard/chat/media/files/webhook 直接演进)。

### 4.4 与 `actionow-integration` 的关系

integration = 机制层(怎么调);building-on = 工程层(怎么建 + 选姿势)。后者**交叉引用**前者,零端点细节重复。安装说明并列两者。

---

## 5. 验证

- **skill**:照 `writing-skills` 的 TDD —— subagent 对**真实代码**审计每条事实(复用矩阵、充值/子钱包语义、Model-A 约束),再 GREEN 测可用性(给 agent 只读 skill、产出接入代码、源码侧核对),照 `actionow-integration` 的方式跑一遍。
- **脚手架**:`pnpm -C examples/app-starter typecheck && lint && build` 通过;脚本 `node --check`;最小测试(mock fetch)绿。
- **文档**:与 skill 同源,评审一致性。

---

## 6. 放置与命名

- `skills/building-on-actionow/`
- `docs/ENGINEERING-GUIDE.md`
- `examples/app-starter/`(与现有 `examples/quickstart` 并存;README 说明二者关系:quickstart=最小 API 演示,app-starter=可扩展项目起点)

---

## 7. 分期落地(每期独立可上线)

- **Phase 0 · skill 骨架 + 场景一/二 playbook + 复用矩阵**:最快给出「能不能直接用 + 怎么选」的答案。含 `onboard-and-call.mjs`。
- **Phase 1 · 完整脚手架(场景二)+ core-kit + Express 示例 + 场景一极简变体**。
- **Phase 2 · 场景三 + 迁移 A→B + 工程文档 `ENGINEERING-GUIDE.md` + 脚本补全**。

---

## 8. 非目标 / 开放问题

**非目标**:不改 core 后端;不做多语言脚手架(TS-first,其他语言只在 `06-tech-stack.md` 给兜底说明);不替接入方做产品 UX/Prompt。

**开放问题**:

1. 场景三需要「Model-B 自持用户 + 只读 member token」。今天 member JWT 来自 Model-A 登录;B 用户是否能拿只读 member token(不走密码登录)?若不能,场景三的自助界面改为「你后端代拉 `/console/subjects/:id/*` 再渲染」。**默认按后者写,member 直嵌作为 core 支持后的增强**。
2. 脚手架是否 npm 发布 `@actionow/app-kit`,还是仅 `examples/` 内示例?**默认仅 examples**,发布留后。
3. 是否把 `examples/quickstart` 直接并入 app-starter,还是并存?**默认并存**(quickstart 教学、app-starter 起步)。

---

## 9. 参考

- `skills/actionow-integration/`(机制层,被本设计交叉引用)
- `docs/INTEGRATION.md` · `examples/quickstart/` · `packages/sdk/`
- 相关端点/契约:`apps/api/src/{auth,console,payments,member}` · `packages/contracts/src/{console-requests,console-views,admin-requests}` · `packages/db/src/schema/accounts.ts`
