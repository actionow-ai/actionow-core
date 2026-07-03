# Releasing Actionow

Trunk-based, one product version, `main` = production. This is the automated path:
Conventional Commits → **release-please** cuts a version + `CHANGELOG.md` → the release
builds all three service images (gate) and advances the **`production`** branch →
**Zeabur** auto-deploys from `production`.

Design rationale: [`docs/superpowers/specs/2026-07-02-release-pipeline-design.md`](superpowers/specs/2026-07-02-release-pipeline-design.md).

## How deploy actually reaches Zeabur

Zeabur has **no per-service deploy-hook URL**; it deploys via its native GitHub
integration — it auto-builds and rolls out whatever lands on the branch each service
watches. So the pipeline points every Zeabur service at a dedicated **`production`**
branch, and the release flow fast-forwards `production` to the released commit. Zeabur
sees the push (GitHub's push webhook fires regardless of who pushed) and deploys. No
tokens or secrets required.

## The flow

```
feature branch → Conventional commits → PR (title MUST be Conventional)
  → CI: pr-title + quality + contract → SQUASH-merge to main
push:main → release-please maintains a "Release PR" (version bump + CHANGELOG)
merge the Release PR → tag vX.Y.Z + GitHub Release → deploy.yml:
  build api+worker+web images (gate) → git push --force main-commit → production
  → Zeabur builds + rolls out from `production`
```

## Day-to-day: how to ship

1. Branch off `main`, commit with Conventional Commits (the `.gitmessage` template is
   auto-installed by `pnpm install`; `commitlint` checks messages locally).
2. Open a PR. **Its title must be a Conventional Commit** — under squash-merge the title
   becomes the `main` commit and the CHANGELOG line. CI (`pr-title`) enforces it.
3. Get CI green (`pr-title` + `quality` + `contract`) and **squash-merge**.
4. release-please opens/updates a **"chore(main): release X.Y.Z"** PR accumulating every
   unreleased change. Review its CHANGELOG.
5. **Merge the Release PR** when you want to ship. That tags `vX.Y.Z`, publishes a GitHub
   Release, builds the three images as a gate, and fast-forwards `production` to the
   released commit — Zeabur then builds + rolls out api/worker/web.

Version bumps (pre-1.0 policy, in `release-please-config.json`): `fix`/`perf` → patch,
`feat` → patch, `feat!` / `BREAKING CHANGE:` → minor. Flip `bump-*-pre-major` off (or go
to `1.0.0`) when the API stabilizes so `feat` → minor and breaking → major.

## Re-deploy or roll back without a release

`Actions → deploy → Run workflow` (`workflow_dispatch`). Leave `ref` empty to re-deploy
the latest, or set it to an **older tag** (e.g. `v0.3.1`) to roll back — the job
force-advances `production` to that ref and Zeabur redeploys it.

## One-time setup (external — not in the repo)

1. **Create the `production` branch once** (it tracks the last released commit thereafter):

   ```bash
   git branch production main && git push origin production
   ```

2. **Zeabur** — for each service (api, worker, web): open the service → its Git/branch
   setting → set the **deploy branch to `production`**. (Leaving them on `main` would
   deploy every merge; `production` only moves on a release.)

3. **GitHub** → `Settings → Environments → New environment` named **`production`**
   (optional but recommended): add a **required reviewer** to gate each deploy behind a
   manual approval. No secrets are needed for this deploy path.

4. **GitHub** → `Settings → General → Pull Requests`: enable **Allow squash merging**, set
   **Default commit message → "Pull request title"**, and disable "Allow merge commits"
   (keeps `main` history one-conventional-commit-per-PR so the CHANGELOG stays clean).

## Adding SDK publishing later

`@actionow/sdk` is currently workspace-internal (not published). To publish it on release,
add it as a second release-please component in `release-please-config.json` (its own
`package-name` + `changelog-path`), give it `include-component-in-tag: true` so its tags
are namespaced (`sdk-vX.Y.Z`), and add a publish step (npm: `NPM_TOKEN`; or GitHub
Packages via `GITHUB_TOKEN`) gated on that component's `release_created` output.

## Files

| File                                                           | Role                                                                   |
| -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `.gitmessage`                                                  | Conventional-Commit template (auto-installed via `prepare`).           |
| `.github/PULL_REQUEST_TEMPLATE.md`                             | PR checklist + the "title must be Conventional" banner.                |
| `.github/workflows/pr-title.yml`                               | Server-side Conventional PR-title check.                               |
| `.github/workflows/quality.yml`                                | typecheck + lint + format + tokens + test (unchanged).                 |
| `.github/workflows/contract.yml`                               | OpenAPI + SDK drift gate (unchanged).                                  |
| `.github/workflows/release-please.yml`                         | Maintains the Release PR; on release, calls deploy.                    |
| `.github/workflows/deploy.yml`                                 | Build-image gate → fast-forward `production` (Zeabur deploys from it). |
| `release-please-config.json` / `.release-please-manifest.json` | Version + changelog config/state.                                      |
