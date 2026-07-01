# App-on-core engineering guidance — Phase 2 Implementation Plan (scenario-3 + migration + engineering guide)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Finish the guidance: scenario-3 (hybrid) playbook, the A→B migration playbook, and the human-readable `docs/ENGINEERING-GUIDE.md`; un-stub the Phase-2 references in the skill.

**Architecture:** Two more `building-on-actionow/reference/*.md` sub-skills (agent-readable) + one narrative `docs/ENGINEERING-GUIDE.md` (human-readable). Doc-only; content correctness gated by a fact-audit.

**Tech Stack:** Markdown. Verify: cross-links resolve; a source-aware fact-audit.

> **Load-bearing facts (verified against source — these shape the content):**
>
> - `external_id` is **immutable** (decision #6, `admin-requests.ts:39,54`); `updateSubjectSchema` omits it.
> - Model-A `register-member` creates a subject with **email+password only, no external_id** (`local-auth.service.ts:189-193`).
> - ⇒ **A→B migration = reference the EXISTING subject by its `id`** (store `subject_id`), mint a **subject-scoped `ak_`** (`POST /console/api-keys {subjectId}`), attribute via the key (NOT `end_user`, which needs external_id). You do NOT/cannot backfill external_id.
> - A **pure Model-B subject has no password** → cannot `login-member` → cannot get a member JWT. So scenario-3 "reuse `/member/*`" needs Model-A registration; the robust **default is backend proxy-reads `/console`**.
> - Read routes for scenario-3 backend proxy: `GET /console/subjects/:id/sub-account` (balance), `GET /console/usage-log` (tenant-scoped, filter by subject), `POST /console/payments/intents` (topup on the user's behalf). All confirmed in `console.controller.ts`.

> **Commit note:** gated on user go-ahead; branch off `main` first if given.

---

## File structure

| File                                                                      | Responsibility                                                                                                                                         |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `skills/building-on-actionow/reference/04-scenario-hybrid.md`             | Scenario 3 (Model-B + reuse core self-service) playbook                                                                                                |
| `skills/building-on-actionow/reference/05-migration-A-to-B.md`            | Upgrade path Model-A → Model-B                                                                                                                         |
| `docs/ENGINEERING-GUIDE.md`                                               | Human-readable narrative: positioning, 3-scenario comparison, reuse matrix, per-scenario, migration, tech-stack, coding conventions, own-API standards |
| `skills/building-on-actionow/SKILL.md` (edit)                             | un-stub 场景三/04 in the comparison table + add 04/05 to the sub-skill index                                                                           |
| `skills/building-on-actionow/reference/01-choose-your-scenario.md` (edit) | decision-tree link to 04; 升级路径 corrected + link to 05                                                                                              |

---

### Task 1: reference/04-scenario-hybrid.md

- [ ] **Step 1: Write the playbook** (same 8-part structure as 02/03):
  1. 一句话 + 何时选(自持用户 B,但想少写余额/用量/充值界面).
  2. 复用矩阵(复用 积分/充值/模型/文件 + core 的自助读;自建 用户/权限/业务库).
  3. 两种做法:
     - **3a 默认(稳):** 纯 Model-B。你的后端用**控制面 JWT** 代读 `GET /console/subjects/:id/sub-account`(余额)+ `GET /console/usage-log`(按 subject 过滤)并渲染进**你自己的** UI;充值时后端代调 `POST /console/payments/intents`。不需要 member token。
     - **3b 进阶:** 若想把自助界面整个交给 core:用 `POST /auth/register-member`(给该用户在 core 建密码,得 member JWT)让前端直接读 `/member/*`。代价:core 也持一份该用户凭据(Model-A),subject 靠 `id` 关联(它没有 external_id)。
  4. 凭证边界(3a:控制面 JWT 仅服务端;3b:member JWT 前端只读)。
  5. 逐步接入(端点 + 机制链接到 actionow-integration/01、04)。
     6-8. 示例/脚本(指向场景二脚手架,复用其 topup + 加 console 读)、反模式(别把控制面 JWT 下发浏览器;3b 别以为 member token 能打 /v1).
  - Link mechanics to `../../actionow-integration/reference/{01-authentication,04-billing-and-limits}.md`.

- [ ] **Step 2: Verify** no restated schemas; links resolve.

---

### Task 2: reference/05-migration-A-to-B.md

- [ ] **Step 1: Write the migration playbook**:
  - 现状(场景一/Model-A):core 认证端用户;subject 有 email+password,**无 external_id**(且 external_id 不可补设 —— 不可变)。
  - 目标(场景二/Model-B):你自持用户,数据面按用户的 subject-scoped `ak_` 归属。
  - 步骤:
    1. 在你侧建用户表,把每个 Model-A 用户的 core **`subject_id`(UUID)** 存到你的行(用 `GET /console/subjects` 列出、按 email 对上)。
    2. 给每个 subject 铸一把 **subject-scoped `ak_`**(`POST /console/api-keys {subjectId}`),存起来(加密)。
    3. 你的应用接管认证(停用 core 的 `login-member`);之后 AI 调用用该 `ak_`(归属靠 key,不靠 `end_user`)。
    4. core 侧 subject/钱包/用量/文件**不动**,零数据迁移。
  - 关键点:**不要**试图给旧 subject 补 external_id(不可变);用 `subject_id` 作联邦键即可。新用户则直接走场景二(建 subject 时带 externalId)。
  - 反模式:PATCH external_id(会被忽略/拒绝);为老用户新建重复 subject(email 冲突 + 丢余额)。

- [ ] **Step 2: Verify** against source (external_id immutable; register-member no external_id; api-keys by subjectId).

---

### Task 3: docs/ENGINEERING-GUIDE.md (human narrative)

- [ ] **Step 1: Write the guide** — the human/reviewer-facing narrative version of the skill, sections:
  1. 定位:core = 能力基座(复用矩阵 + 边界).
  2. 三种姿势对比表(托管快启 / 能力基座 / 混合)+ 决策指引.
  3. 每种姿势要点(复用/自建/凭证)+ 指向 `examples/app-starter/`(场景二脚手架)与 `skills/building-on-actionow/`(playbook).
  4. 迁移:一→二(external_id 不可变 → 按 subject_id 联邦).
  5. 技术栈推荐(TS 优先参考栈:薄后端 + @actionow/sdk + 自管 DB 只存 core ID + KMS + 队列 worker;其他语言用 OpenAI 兼容客户端 + 裸 HTTP 兜底).
  6. 编码约定(升级版铁律:双 client / 只存 ID / µcredit BigInt / retryable 重试 / webhook 原始字节 / end_user=external_id / SDK 类型面窄用裸 fetch / Express 异步错误中间件).
  7. 你自身对外 API 规范(contract-first zod→openapi、统一错误信封 `{error:{code,message,retryable}}`、keyset 分页、请求 camelCase/响应 snake_case、把 core/上游错误翻译成你面向用户的错误).
  8. 去哪儿看(skill / scaffold / integration skill / 本仓 docs).

- [ ] **Step 2: Verify** links resolve; consistent with the skill (single source).

---

### Task 4: Un-stub SKILL.md + 01

- [ ] **Step 1: SKILL.md** — in the 三场景对比 table change the 场景三 row link from "(Phase 2)" to `[04-scenario-hybrid.md](reference/04-scenario-hybrid.md)`; add rows for 04 (混合) and 05 (迁移 一→二) to the 子技能 index; add a pointer to `docs/ENGINEERING-GUIDE.md` (人读版).
- [ ] **Step 2: 01-choose-your-scenario.md** — decision-tree: change 场景三 "(Phase 2)" to a link to 04; 升级路径 paragraph: correct it (external_id immutable → federate by subject_id) and link to `05-migration-A-to-B.md`.

---

### Task 5: Fact-audit + fix

- [ ] **Step 1:** Dispatch a source-aware audit over 04/05/ENGINEERING-GUIDE + the edits, verifying: external_id immutability, register-member has no external_id, api-keys-by-subjectId, /console read routes (sub-account, usage-log, payments/intents), member-token-can't-hit-/v1, no restated schemas. Return findings.
- [ ] **Step 2:** Fix critical/major inline; re-check links (per-file resolver).

---

### Task 6: Wrap

- [ ] **Step 1:** Update memory (Phase 2 done → building-on-actionow fully shipped 3 phases).
- [ ] **Step 2:** Report; offer to commit Phases 0–2 (branch off main).

---

## Self-Review

**Spec coverage (Phase 2 = spec §7):** scenario-3 → Task 1 ✓; migration A→B → Task 2 ✓; ENGINEERING-GUIDE.md → Task 3 ✓; un-stub references → Task 4 ✓; audit → Task 5 ✓.

**Placeholder scan:** none; migration/scenario-3 content is pinned to the verified facts (external_id immutable, register-member no external_id, backend-proxy default).

**Consistency:** 05 migration mechanism (federate by `subject_id`, mint subject-scoped key, don't backfill external_id) is consistent with the corrected 01 升级路径 blurb and the reuse-matrix facts; scenario-3 3a/3b consistent with the member-token constraint in SKILL.md 关键约束.
