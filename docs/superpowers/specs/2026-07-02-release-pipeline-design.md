# Release pipeline design — actionow-core

Date: 2026-07-02
Status: approved

## Goal

Formalize the whole release path: commit conventions → PR conventions → CI gates →
versioning → release → **auto-trigger Zeabur deploy**. Trunk-based (`main` = prod),
one product version, SDK internal-only for now.

## Decisions (locked)

- **Zeabur trigger**: Zeabur has **no deploy-hook URL** — it deploys via native GitHub
  integration (auto-builds whatever lands on a watched branch). So each service watches a
  dedicated **`production`** branch; the release flow fast-forwards `production` to the
  released commit after the build gate. Token-free, reuses the existing git-deploy.
- **Versioning/release**: `release-please` (Conventional Commits → Release PR →
  version bump + `CHANGELOG.md` → tag `vX.Y.Z` + GitHub Release). Single root component.
- **SDK publish**: none yet (`@actionow/sdk` stays workspace-internal). Add a
  release-please component later if it goes to a registry.
- **Environments**: trunk-based, `main` = production. No staging.
- **Build gate**: **full** — build all three images (`api`/`worker`/`web`) before
  triggering Zeabur, so a broken Dockerfile fails CI instead of Zeabur mid-deploy.

## End-to-end flow

```
feature branch → Conventional commits (.gitmessage guide + husky commitlint local)
  → PR (PULL_REQUEST_TEMPLATE) → CI: pr-title (semantic) + quality + contract
  → SQUASH-merge to main (squash commit == PR title)
push:main
  ├─ quality.yml + contract.yml   (guards, unchanged)
  └─ release-please.yml → maintains a "Release PR" (bumps version, writes CHANGELOG)
Release PR merged
  → release-please tags vX.Y.Z + creates GitHub Release
  → (same run) release_created==true → CALLS deploy.yml
deploy.yml (environment: production)
  ├─ build-images gate: docker build api + worker + web (no push)
  └─ git push --force released-commit → `production` branch → Zeabur builds + deploys
```

## Why release-please CALLS deploy (not `on: release: published`)

A GitHub Release created with the default `GITHUB_TOKEN` does **not** emit events that
trigger other workflows (GitHub loop-prevention). A separate `deploy.yml` listening on
`release: published` would silently never fire unless release-please ran under a PAT.
To stay PAT-free and reliable, `release-please.yml` invokes `deploy.yml` as a
**reusable workflow** (`workflow_call`) in the same run, gated on the action's
`release_created` output. `deploy.yml` also exposes `workflow_dispatch` for manual
re-deploys / rollbacks (deploy an older tag).

## Components

### 1. Commit template — `.gitmessage`

Conventional-Commit scaffold (commented lines are stripped by git): the `type(scope):
subject` header, body, footer (`BREAKING CHANGE:`, `Refs #`), the allowed types, the
scope list (packages/apps), and how each type maps to a version bump. Auto-installed
per-clone by appending `git config commit.template .gitmessage` to the root `prepare`
script (already runs husky), so `pnpm install` wires it up — no manual step.

### 2. PR template — `.github/PULL_REQUEST_TEMPLATE.md`

Summary / type-of-change / how-tested / migrations & rollback / checklist. Top banner:
**the PR title MUST be a Conventional Commit** — under squash-merge it becomes the
`main` commit and the CHANGELOG entry.

### 3. CI additions

- `pr-title.yml` — `amannn/action-semantic-pull-request` validates the PR title against
  the `@commitlint/config-conventional` type set. This is the server-side, un-bypassable
  counterpart to the local `commit-msg` hook (which a `--no-verify` skips), and it is
  load-bearing because squash-merge derives the changelog from the PR title.
- `quality.yml` + `contract.yml` — unchanged (already gate typecheck/lint/format/tokens/
  test + OpenAPI/SDK drift).

### 4. Versioning + release — `release-please`

- `release-please-config.json`: `release-type: node`, single root component
  (`package-name: actionow-core`, `changelog-path: CHANGELOG.md`),
  `include-component-in-tag: false` (tags `vX.Y.Z`). Pre-1.0 bump policy:
  `bump-minor-pre-major: true` (BREAKING → minor while 0.x) +
  `bump-patch-for-minor-pre-major: true` (feat → patch while 0.x), so it never jumps to
  a spurious major before we choose 1.0.
- `.release-please-manifest.json`: seeded `{ ".": "0.0.1" }` to match the existing
  `v0.0.1` tag; root `package.json` version aligned `0.0.0 → 0.0.1` (one-time).
- `release-please.yml`: `on push:main`, `permissions: contents:write + pull-requests:write`,
  outputs `release_created`, and a dependent job that `uses: ./.github/workflows/deploy.yml`
  when a release was created (no secrets — `contents:write` is inherited for the branch push).

### 5. Deploy — `deploy.yml`

- Triggers: `workflow_call` (from release-please) + `workflow_dispatch` (manual).
- `concurrency: deploy-production` (no cancel) so deploys serialize.
- Job `build-images`: matrix over `{api: Dockerfile, worker: Dockerfile.worker,
web: Dockerfile.web}`, `docker/build-push-action` with `push: false` (gate only),
  buildx + gha cache.
- Job `deploy` (`needs: build-images`, `environment: production`, `permissions:
contents:write`): `git push --force origin HEAD:refs/heads/production` at the released
  commit. `production` is a managed deploy pointer advanced ONLY by this workflow (force
  supports rollback via `workflow_dispatch`; the concurrency group prevents races). Zeabur
  watches `production` and deploys on the push — no secrets. The `production` GitHub
  Environment is kept solely for the optional manual-approval gate.

### 6. Docs — `docs/RELEASING.md`

Operator runbook: the flow above, the one-time external setup (create the `production`
branch, point each Zeabur service at it, squash-merge repo setting), how to cut a release,
how to re-deploy / roll back, and how to add SDK publishing later. `docs/DEPLOYMENT.md`
links to it.

## Required external setup (cannot be done from the repo)

- Create the branch once: `git branch production main && git push origin production`.
- Zeabur → each service (api/worker/web) → set its **deploy branch to `production`**
  (not `main`, so only releases deploy). No tokens/secrets.
- GitHub → `Settings → Environments → production` (optional) → add a **required reviewer**
  to gate deploys with a manual approval.
- GitHub → `Settings → General` → enable **Squash merging**, set the squash commit
  message to **"Pull request title"**, and (recommended) disable merge commits.

## Non-goals / deferred

- SDK npm/GitHub-Packages publishing (add a release-please component + `NPM_TOKEN` when needed).
- Staging environment / PR preview deploys.
- Per-package independent versioning (all workspace packages stay `0.0.0` internal).

## File manifest

```
new  .gitmessage
new  .github/PULL_REQUEST_TEMPLATE.md
new  .github/workflows/pr-title.yml
new  .github/workflows/release-please.yml
new  .github/workflows/deploy.yml
new  release-please-config.json
new  .release-please-manifest.json
new  docs/RELEASING.md
edit package.json           (prepare → also set commit.template; version 0.0.0 → 0.0.1)
edit docs/DEPLOYMENT.md      (link to RELEASING.md)
```
