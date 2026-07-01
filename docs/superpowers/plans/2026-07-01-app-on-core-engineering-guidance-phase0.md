# App-on-core engineering guidance — Phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `building-on-actionow` skill skeleton that answers "can I reuse core's user/credits/topup/model systems, and which integration posture do I pick?" — with a decision tree, a verified reuse matrix, scenario-1 (managed) and scenario-2 (capability-base, main line) playbooks, and one runnable end-to-end script.

**Architecture:** A new agent skill at `skills/building-on-actionow/` that sits ABOVE the existing `skills/actionow-integration/` (mechanics layer). It cross-references the integration skill for endpoint detail and never duplicates it. Content correctness is gated by a fact-audit against real source (writing-skills TDD), not by pre-written prose.

**Tech Stack:** Markdown skill files + one zero-dependency Node ESM script (global `fetch`, Node 18+). Verification via `node --check`, cross-reference checks, and a subagent fact-audit + GREEN usability test (same method used for `actionow-integration`).

> **Scope note:** This is Phase 0 of the spec `docs/superpowers/specs/2026-07-01-app-on-core-engineering-guidance-design.md`. Phase 1 (TS scaffold `examples/app-starter/`) and Phase 2 (scenario-3 + migration + `docs/ENGINEERING-GUIDE.md`) get their own plans after Phase 0 lands.

> **Commit note:** This session's norm is "no commit without the user asking." Each task ends with a commit step for completeness, but DO NOT run it unless the user has given the go-ahead; if they do, and the branch is `main`, create a feature branch first (`git switch -c feat/building-on-actionow`).

> **Doc-task convention:** For markdown files, "write the file" steps specify the exact sections, facts (with source), and cross-reference targets the file MUST contain — that IS the complete content spec. The prose is authored at execution and its factual claims are verified by the Task 7 fact-audit. Every factual claim must trace to the reuse matrix in the spec §1.1 or to a cited source file.

---

## File structure (Phase 0)

| File                                                                   | Responsibility                                                                                                |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `skills/building-on-actionow/SKILL.md`                                 | Entry: positioning (core=能力基座), decision tree, reuse-matrix summary, ironclad rules, sub-skill index, env |
| `skills/building-on-actionow/README.md`                                | Install + relationship to `actionow-integration`                                                              |
| `skills/building-on-actionow/reference/01-choose-your-scenario.md`     | Decision tree + full reuse matrix + 3-scenario comparison                                                     |
| `skills/building-on-actionow/reference/03-scenario-capability-base.md` | Scenario 2 (Model-B, main line) playbook                                                                      |
| `skills/building-on-actionow/reference/02-scenario-managed.md`         | Scenario 1 (Model-A managed) playbook                                                                         |
| `skills/building-on-actionow/scripts/onboard-and-call.mjs`             | Scenario 2 end-to-end: login → subject → key → topup → chat                                                   |

Facts are canonical in `01-choose-your-scenario.md` (reuse matrix); other files reference it. All "how to call endpoint X" detail links to `../../actionow-integration/reference/*` — never restated.

---

### Task 1: SKILL.md entry

**Files:**

- Create: `skills/building-on-actionow/SKILL.md`

- [ ] **Step 1: Write SKILL.md** with EXACTLY these sections and facts:
  - YAML frontmatter: `name: building-on-actionow`; `description:` starts with "Use when a team wants to build an AIGC application ON an Actionow / actionow-core gateway — deciding whether to reuse core's user/credits/topup/model systems, choosing an integration posture (managed vs capability-base vs hybrid), federating their own users, or scaffolding a thin backend." (triggering conditions only, no workflow summary).
  - `## Overview`: core = **能力基座**; this skill = engineering/architecture layer; `actionow-integration` = mechanics layer (link it). One line: "如果你要问的是『这一次调用怎么写对』,去 actionow-integration;这里回答『整个应用怎么建、复用什么、选哪种姿势』。"
  - `## 能直接复用什么` (summary table, 6 rows): 用户系统 ✅Model-A / 积分 ✅ / 充值 ✅ / 模型 ✅ / 文件 ✅ / 业务档案·权限·UX·Prompt·领域数据 ❌自建. One-line each. Link to `reference/01-choose-your-scenario.md` for the full matrix.
  - `## 关键约束`: 端用户 member JWT **不能**直连 `/v1`(member-token 直连已砍);AI 调用必须经持 `ak_` 的服务端(代理)或给端用户发 subject-scoped `ak_`. Source: memory baas-p0-p1-sprint (member-token /v1/run DROPPED).
  - `## 选哪种姿势`: a graphviz decision flowchart (dot) with the branch: "自己要不要管用户体系?" → 否 → 场景一 托管快启; 是 → "要不要复用 core 的余额/充值自助界面?" → 是 → 场景三 混合; 否 → 场景二 能力基座(推荐). Keep boxes ≤5 words.
  - `## 铁律` (numbered, the engineering rules): (1) 双 client 隔离:控制面 JWT 仅服务端,数据面 `ak_` 按端用户; (2) 只存 core 的 ID(subject_id/file_id/job_id),不镜像数据; (3) 钱是 µcredit 字符串,BigInt 解析; (4) 按 `retryable` 标志重试,绝不重试 402/400,billed 重试带 `idempotency_key`; (5) webhook 原始字节验签→快速 ack→回拉 `GET /v1/jobs/:id`; (6) `end_user = <external_id>` 不是 subject UUID. Each rule links to the relevant `actionow-integration/reference/*` for mechanics.
  - `## 子技能` index table: 01-choose-your-scenario, 02-scenario-managed, 03-scenario-capability-base (mark 主线).
  - `## 脚本`: onboard-and-call.mjs (场景二端到端).
  - `## 环境变量`: `ACTIONOW_BASE_URL`, `ACTIONOW_API_KEY`, `ACTIONOW_CONSOLE_EMAIL/PASSWORD` (reuse the integration skill's env contract; link it).

- [ ] **Step 2: Verify no endpoint detail is restated** — grep the file for request/response body shapes; each "how to call" must be a link to `actionow-integration`, not an inline schema.

Run: `grep -nE 'POST /|GET /|curl|Bearer' skills/building-on-actionow/SKILL.md`
Expected: matches are decision-level references or links, NOT full request/response schemas (those live in the integration skill).

- [ ] **Step 3: Commit** (only if user approved commits; branch first if on main)

```bash
git add skills/building-on-actionow/SKILL.md
git commit -m "docs(skill): building-on-actionow SKILL.md entry (Phase 0)"
```

---

### Task 2: reference/01-choose-your-scenario.md (canonical reuse matrix)

**Files:**

- Create: `skills/building-on-actionow/reference/01-choose-your-scenario.md`

- [ ] **Step 1: Write the file** with:
  - `## 复用矩阵` — the full table from spec §1.1, VERBATIM facts (each row: 系统 / 能否直接复用 / 边界+代码依据). Include the exact facts: Model-A `register-member`/`login-member` require `tenantId`; member JWT → read-only `/member/{me,usage,balance,api-keys,limits}`; credits = 租户池 `account` + 子钱包 `sub_account`, hold→settle, µcredit (1 credit = 1e6 µcredit); topup `/console/payments/intents {provider,amount_minor,currency}` (no purpose) · `/console/redeem {code}`→`{credited,balance}` · `/v1/payments/intents` (has purpose) · `/sub-account/{topup(非守恒),transfer(守恒 to_subject|to_tenant)}`; models = OpenAI/Anthropic/Gemini 兼容 + `GET /v1/models`; files = presign.
  - `## 关键约束` — member JWT 不能直连 `/v1` (repeat with source).
  - `## 三场景对比` — the comparison table from spec §2 (身份/自助/充值UI/你要建的/适合).
  - `## 决策树` — prose version of the SKILL.md flowchart, with "选完之后去" links to 02/03/(04 in Phase 2).
  - `## 升级路径` — one paragraph: 场景一→二 迁移概要 (Model-A subject 已有 external*id → 你侧建用户表回填 → 改由你认证+发 ak*;core 侧数据不动). Full playbook deferred to Phase 2 `05-migration-A-to-B.md` (note it).

- [ ] **Step 2: Verify every fact traces to source** — for each matrix cell, confirm against the integration skill (which was already source-audited) or note the source file.

Run: `grep -nE 'tenantId|purpose|守恒|to_subject|1e6|member' skills/building-on-actionow/reference/01-choose-your-scenario.md`
Expected: presence of each critical fact; cross-check values against `skills/actionow-integration/reference/{01-authentication,04-billing-and-limits}.md`.

- [ ] **Step 3: Commit** (gated, branch-first)

```bash
git add skills/building-on-actionow/reference/01-choose-your-scenario.md
git commit -m "docs(skill): reuse matrix + scenario chooser (Phase 0)"
```

---

### Task 3: reference/03-scenario-capability-base.md (scenario 2, main line)

**Files:**

- Create: `skills/building-on-actionow/reference/03-scenario-capability-base.md`

- [ ] **Step 1: Write the playbook** with the fixed structure from spec §3:
  1. 一句话 + 何时选(自持用户/权限/业务库、长期演进的正式产品).
  2. 复用矩阵(本场景:复用 积分/充值/模型/文件;自建 用户/权限/业务库/联邦层).
  3. 架构 + 时序(你的后端持 控制面 JWT + 每用户 `ak_`;调用序列 onboard→topup→chat/run→webhook).
  4. 凭证与信任边界(JWT 仅服务端;`ak_` 后端持或下发受信客户端).
  5. 逐步接入(编号步骤,每步 curl + `@actionow/sdk` 双写,端点细节链到 integration skill):
     - Step A onboard: `POST /console/subjects {externalId=你的用户id}` → `POST /console/api-keys {subjectId}` → 存 `subject_id`+`ak_`(加密). Link `actionow-integration/reference/01-authentication.md`.
     - Step B topup: `/console/payments/intents` or `/console/redeem` or `/sub-account/*`. Link `.../04-billing-and-limits.md`.
     - Step C chat: 后端用该用户 `ak_` 打 `/v1/chat/completions`. Link `.../02-chat-and-relay.md`.
     - Step D media: `/v1/run` + 轮询/webhook. Link `.../03-media-jobs-and-files.md` + `.../06-webhooks.md`.
     - Step E files: presign. Link `.../03-media-jobs-and-files.md`.
  6. 示例代码 → 指向 `scripts/onboard-and-call.mjs`.
  7. 脚本 → `onboard-and-call.mjs`.
  8. 反模式(场景二特有):把控制面 JWT 下发浏览器;把 subject UUID 当 `end_user`;镜像 core 数据进你的库(应只存 ID).

- [ ] **Step 2: Verify all endpoint references are links, not restated schemas**

Run: `grep -nE '\]\(\.\./\.\./actionow-integration' skills/building-on-actionow/reference/03-scenario-capability-base.md`
Expected: ≥5 cross-reference links (one per接入 step) into the integration skill.

- [ ] **Step 3: Commit** (gated, branch-first)

```bash
git add skills/building-on-actionow/reference/03-scenario-capability-base.md
git commit -m "docs(skill): scenario-2 capability-base playbook (Phase 0)"
```

---

### Task 4: reference/02-scenario-managed.md (scenario 1)

**Files:**

- Create: `skills/building-on-actionow/reference/02-scenario-managed.md`

- [ ] **Step 1: Write the playbook** (same 8-part structure):
  1. 一句话 + 何时选(内部工具/DEMO/轻产品,最少自建).
  2. 复用矩阵(复用 core 用户 Model-A/积分/充值/模型/文件;自建 前端 + 极薄代理).
  3. 架构 + 时序(端用户在 core 登录拿 member JWT;你的极薄代理持一把服务端 `ak_`;前端带 member JWT→你的代理→用 `ak_` 代打 `/v1`,带 `end_user`).
  4. 凭证边界:member JWT 前端持(只读 `/member/*`);`ak_` **只在你的代理服务端**,绝不下发浏览器;控制面 JWT 仅用于建号.
  5. 逐步接入:
     - 端用户注册/登录 `POST /auth/register-member|login-member {…, tenantId}` → member JWT. Link `.../01-authentication.md`.
     - 端用户自助:`/member/{balance,usage,limits}`. Link `.../01-authentication.md`.
     - 充值:端用户 `POST /v1/payments/intents`. Link `.../04-billing-and-limits.md`.
     - AI 调用:前端 → 你的 `/api/chat` 代理(校验 member JWT)→ `ak_` 打 `/v1/chat/completions`(`end_user=member 的 external_id`). Link `.../02-chat-and-relay.md`.
  6. 示例代码 → 指向 Phase 1 的 `scenario-managed/`(note: 极简代理最小实现 Phase 1 落地;Phase 0 给时序 + 关键片段).
  7. 脚本 → note managed-proxy.mjs 在 Phase 1.
  8. 反模式:把 `ak_` 下发浏览器;以为 member JWT 能直连 `/v1`(不能).

- [ ] **Step 2: Verify the member-can't-call-/v1 constraint is stated prominently**

Run: `grep -n 'member' skills/building-on-actionow/reference/02-scenario-managed.md`
Expected: an explicit statement that member JWT cannot call `/v1` and must go through the `ak_` proxy.

- [ ] **Step 3: Commit** (gated, branch-first)

```bash
git add skills/building-on-actionow/reference/02-scenario-managed.md
git commit -m "docs(skill): scenario-1 managed-fast-launch playbook (Phase 0)"
```

---

### Task 5: scripts/onboard-and-call.mjs (scenario 2 end-to-end)

**Files:**

- Create: `skills/building-on-actionow/scripts/onboard-and-call.mjs`

- [ ] **Step 1: Write the script.** Zero-dependency Node ESM (global `fetch`). It composes the scenario-2 golden path end to end. Reuse the exact contracts verified for the integration skill:

```js
#!/usr/bin/env node
// onboard-and-call.mjs — scenario 2 (capability base) end to end:
// login → create subject (Model-B) → mint ak_ → (optional redeem topup) → chat.
// Zero deps (global fetch, Node 18+). Env: ACTIONOW_BASE_URL, ACTIONOW_CONSOLE_EMAIL,
// ACTIONOW_CONSOLE_PASSWORD.  Usage: node onboard-and-call.mjs <yourUserId> [redeemCode]
const BASE = (process.env.ACTIONOW_BASE_URL ?? '').replace(/\/$/, '');
const EMAIL = process.env.ACTIONOW_CONSOLE_EMAIL;
const PASSWORD = process.env.ACTIONOW_CONSOLE_PASSWORD;
if (!BASE || !EMAIL || !PASSWORD) {
  console.error('set ACTIONOW_BASE_URL, ACTIONOW_CONSOLE_EMAIL, ACTIONOW_CONSOLE_PASSWORD');
  process.exit(2);
}
const [externalId, redeemCode] = process.argv.slice(2);
if (!externalId) {
  console.error('usage: node onboard-and-call.mjs <yourUserId> [redeemCode]');
  process.exit(2);
}

async function jpost(path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(`${path} → HTTP ${res.status} ${JSON.stringify(json.error ?? json)}`);
  return json;
}

// 1. control-plane login → USER JWT (full token pair; token === accessToken)
const { token } = await jpost('/auth/login', { email: EMAIL, password: PASSWORD });
// 2. Model-B subject (externalId = YOUR user id) — /console/subjects not in OpenAPI → fetch
const subject = await jpost('/console/subjects', { externalId, displayName: externalId }, token);
// 3. mint subject-scoped ak_ (plaintext once)
const key = await jpost('/console/api-keys', { subjectId: subject.id }, token);
console.error(`subject ${subject.id} · key minted`);
// 4. optional: top up the tenant pool via redemption code
if (redeemCode) {
  const r = await jpost('/console/redeem', { code: redeemCode }, token);
  console.error(`redeemed → pool balance ${r.balance} µcredit`);
}
// 5. call /v1 as that end-user with their ak_ (end_user tag = external_id)
const chat = await fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${key.plaintext}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    model: process.env.ACTIONOW_MODEL ?? 'gpt-4o',
    messages: [{ role: 'user', content: 'Reply with: pong' }],
  }),
});
const cj = await chat.json().catch(() => ({}));
if (!chat.ok) throw new Error(`chat → HTTP ${chat.status} ${JSON.stringify(cj.error ?? cj)}`);
console.log(
  JSON.stringify(
    {
      subject_id: subject.id,
      api_key: key.plaintext,
      reply: cj.choices?.[0]?.message?.content,
      usage: cj.usage,
    },
    null,
    2,
  ),
);
```

- [ ] **Step 2: Syntax-check the script**

Run: `node --check skills/building-on-actionow/scripts/onboard-and-call.mjs`
Expected: no output, exit 0.

- [ ] **Step 3: Make executable + verify env-guard path**

Run: `chmod +x skills/building-on-actionow/scripts/onboard-and-call.mjs && node skills/building-on-actionow/scripts/onboard-and-call.mjs 2>&1 | head -1`
Expected: prints the env-var usage error (no network attempted without env) — confirms guards work.

- [ ] **Step 4: Commit** (gated, branch-first)

```bash
git add skills/building-on-actionow/scripts/onboard-and-call.mjs
git commit -m "feat(skill): scenario-2 onboard-and-call e2e script (Phase 0)"
```

---

### Task 6: README.md (install + relationship)

**Files:**

- Create: `skills/building-on-actionow/README.md`

- [ ] **Step 1: Write README.md** with: what it is (engineering/architecture layer for building AIGC apps on core); the file tree; install into `~/.claude/skills/` (mirror the `actionow-integration/README.md` install instructions for CC/Codex/Cursor); the explicit relationship — "机制层看 `actionow-integration`,工程层看这里;二者一起装"; and "内容以 gateway 的 `/docs` 为准,版本可能不同".

- [ ] **Step 2: Verify cross-links resolve** — every relative link in the skill points to an existing file.

Run: `cd skills/building-on-actionow && grep -rhoE '\]\([^)]+\)' . | sed -E 's/.*\(([^)]+)\)/\1/' | grep -vE '^https?:' | while read p; do [ -e "${p%%#*}" ] || [ -e "../actionow-integration/${p#../../actionow-integration/}" ] || echo "BROKEN: $p"; done`
Expected: no `BROKEN:` lines (all internal + integration-skill cross-links resolve).

- [ ] **Step 3: Commit** (gated, branch-first)

```bash
git add skills/building-on-actionow/README.md
git commit -m "docs(skill): building-on-actionow README (Phase 0)"
```

---

### Task 7: Fact-audit + GREEN usability verification (writing-skills TDD)

This is the RED/GREEN gate — the same method that caught real errors in `actionow-integration`. No new files; fix findings in the Phase-0 files.

- [ ] **Step 1: Run the audit + usability workflow.** Dispatch a Workflow (or parallel subagents) that:
  - AUDIT (with full repo access): verify every checkable claim in `SKILL.md` + `reference/01/02/03` against real source — especially the reuse matrix (Model-A `tenantId` required; member JWT can't call `/v1`; topup `/console/payments/intents` has no `purpose`; `/sub-account/topup` non-conserving vs `transfer` conserving `to_subject|to_tenant`; `end_user`=external_id). Sources: `apps/api/src/{auth,console,payments,member}/*.controller.ts`, `packages/contracts/src/{console-requests,console-views,admin-requests}.ts`, `packages/db/src/schema/accounts.ts`, and cross-check against the already-audited `skills/actionow-integration/`.
  - GREEN usability: give an agent ONLY the `building-on-actionow` skill + a task ("我要基于 core 建一个自持用户的 AIGC 应用后端,给我 onboarding+计费+调用的骨架"); a source-aware reviewer flags any wrong/misleading guidance or gap.
  - Return structured findings (claim, verdict, severity, evidence, fix).

Expected: a findings list. Treat any `incorrect`/`misleading` at `critical`/`major` as must-fix.

- [ ] **Step 2: Fix every critical/major finding inline** in the affected Phase-0 files. Re-verify the specific claims against the cited source.

- [ ] **Step 3: Re-run `node --check` on the script and the broken-link check from Task 6 Step 2.**

Run: `node --check skills/building-on-actionow/scripts/onboard-and-call.mjs`
Expected: exit 0; link check prints no `BROKEN:`.

- [ ] **Step 4: Commit** (gated, branch-first)

```bash
git add skills/building-on-actionow/
git commit -m "fix(skill): apply Phase-0 fact-audit findings"
```

---

### Task 8: Phase-0 wrap + memory pointer

- [ ] **Step 1: Update the project memory** at `~/.claude/.../memory/` — append to `actionow-integration-skill.md` (or a new `building-on-actionow-skill.md`) a one-line note that the companion engineering skill Phase 0 landed, its location, and that Phases 1–2 (scaffold, doc, scenario-3, migration) remain. Add the MEMORY.md pointer.

- [ ] **Step 2: Report to the user** — Phase-0 file tree, what the fact-audit found/fixed, and offer to proceed to Phase 1 (scaffold) plan.

---

## Self-Review

**Spec coverage (Phase 0 slice of spec §7):**

- Skill skeleton → Task 1, 6 ✓
- Reuse matrix → Task 2 ✓
- Scenario-1 (managed) playbook → Task 4 ✓
- Scenario-2 (capability-base, main) playbook → Task 3 ✓
- `onboard-and-call.mjs` → Task 5 ✓
- Verification (writing-skills TDD) → Task 7 ✓
- (Deferred to Phase 1/2, explicitly noted: full scaffold, `managed-proxy.mjs`/`topup-demo.mjs`, scenario-3, migration playbook, `ENGINEERING-GUIDE.md`.)

**Placeholder scan:** No "TBD/TODO"; deferred items are explicitly labeled as Phase 1/2 with the reason. Script code is complete. Doc tasks enumerate exact sections + facts + cross-ref targets.

**Type/name consistency:** Script uses `subject.id`, `key.plaintext`, `token`, `cj.choices[0].message.content`, `r.balance` — consistent with the verified `console` contracts (ApiKeyCreatedView `{id,plaintext}`, SubjectView `{id,external_id}`, login `{token,...}`, redeem `{credited,balance}`). Reuse-matrix facts are identical to those in the already-audited `actionow-integration` skill.

**Cross-reference integrity:** Task 6 Step 2 adds an automated broken-link check covering both intra-skill and integration-skill links.
