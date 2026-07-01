# building-on-actionow skill

The **engineering / architecture layer** for building an AIGC application on an **Actionow / actionow-core** gateway: what to reuse (core's user / credits / top-up / model / file systems), which integration posture to pick, how to federate your own users, and how to scaffold a thin backend.

It sits **above** the [`actionow-integration`](../actionow-integration/) skill (the call-mechanics layer) and cross-references it for endpoint detail — never restating it. Install both together.

## What's inside (Phase 0)

```
building-on-actionow/
  SKILL.md                          entry: 能力基座定位 · 复用摘要 · 决策树 · 铁律 · 索引
  reference/
    01-choose-your-scenario.md      canonical 复用矩阵 + 三场景对比 + 决策树
    03-scenario-capability-base.md  场景二 · 能力基座(Model-B,主线)playbook
    02-scenario-managed.md          场景一 · 托管快启(Model-A)playbook
  scripts/
    onboard-and-call.mjs            场景二端到端(zero-dep, Node 18+)
```

(Phase 1 adds a TS starter scaffold `examples/app-starter/`; Phase 2 adds 场景三 混合、迁移 playbook、and `docs/ENGINEERING-GUIDE.md`.)

## Install it into your agent

Copy the folder next to `actionow-integration` — the harness reads `SKILL.md`'s frontmatter and surfaces it by description:

```sh
cp -r building-on-actionow ~/.claude/skills/       # Claude Code / Copilot CLI (personal)
# or per-project:  cp -r building-on-actionow .claude/skills/
# Codex:  cp -r building-on-actionow ~/.agents/skills/
# Cursor / others without a skills loader: point the agent at SKILL.md
```

Install **both** skills: 机制层看 `actionow-integration`,工程层看这里。

## Keeping it accurate

事实以你的 gateway 的 `GET /docs`(Swagger UI over the live OpenAPI spec)为准 —— 版本可能不同。The canonical source for this skill lives in the actionow-core repo under `skills/building-on-actionow/`.
