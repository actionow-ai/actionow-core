<!--
  ⚠️  The PR TITLE must be a Conventional Commit, e.g.  feat(api): add rerank endpoint
  We squash-merge, so the PR title becomes the commit on `main` AND the CHANGELOG
  entry that release-please reads. CI (`pr-title`) enforces this.
-->

## Summary

<!-- What does this change and why? Link the issue if any (Closes #123). -->

## Type of change

- [ ] `feat` / `fix` / `perf` — user-facing, lands in the CHANGELOG + a version bump
- [ ] `docs` / `refactor` / `test` / `build` / `ci` / `chore` — no release
- [ ] **BREAKING CHANGE** — note it via a `type!:` title or a `BREAKING CHANGE:` footer

## How tested

<!-- Commands run + evidence (test output, screenshots, curl). "Verified locally" is not enough. -->

## Migrations & rollback

<!-- New DB migration? Is it additive/backward-compatible? How would you roll this back? "N/A" if none. -->

## Checklist

- [ ] `pnpm typecheck && pnpm lint && pnpm format:check && pnpm check:tokens` pass
- [ ] `pnpm test` passes (or I've explained why it can't run here)
- [ ] Docs updated (`DEPLOYMENT.md` / `RELEASING.md` / README) if behavior or env changed
- [ ] PR title is a valid Conventional Commit
