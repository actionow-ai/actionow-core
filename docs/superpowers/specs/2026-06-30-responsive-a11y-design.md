# Phase 4 — 响应式 + 无障碍 / 状态色

**Date:** 2026-06-30
**Status:** Design approved, pending spec review
**Scope:** `apps/web` (frontend only). Phase 4 of the 5-phase frontend-quality program.
**Branch:** `feat/console-responsive-a11y`, **stacked on Phase 3** (`feat/console-mutation-safety-dates`). Rebase to `main` after the upstream branches merge.

---

## 1. Background

The 2026-06-30 design audit's systemic themes #5 (tablet/responsive blind spots) and #6 (status
conveyed by colour alone + overloaded semantic tones). Two independent threads, both P1.

---

## 2. Goals / non-goals

### Goals

- Tablets (768–960px) get a usable full-width layout instead of ~460px content behind ~308px of
  fixed chrome.
- Route-based detail pages stop orphaning short values on wide screens.
- Status is never conveyed by colour alone (sparkline, plugin test result); the overloaded amber
  `run` tone stops meaning four different things; the caution band uses one consistent token.

### Non-goals

- A Rail-only middle tier with a SubNav flyout (considered, rejected — large/risky; the breakpoint
  bump achieves the goal simply).
- Any global change to the `--faint` token value (only targeted per-spot swaps).
- Phase 5.

---

## 3. Thread A — responsive

### 3.1 Tablet chrome — raise the desktop gate `BP.md` → `BP.lg`

`ConsoleLayout.tsx:36` gates the desktop chrome on `useMediaQuery(BP.md)` (768px), so the full Rail
(64px) + SubNav (200px) + gaps (~308px) appear at 768px, leaving ~460px of content on tablets.
Change the gate to `useMediaQuery(BP.lg)` (960px). 768–960px then uses the existing, proven **mobile
layout** (full-width content + `BottomTabs`); ≥960px keeps the two-column chrome. Apply the same bump
to `TopBar.tsx:37` (`const isDesktop = useMediaQuery(BP.md)` → `BP.lg`) so the top bar's
mobile/desktop branch matches the chrome. (Only these two chrome breakpoints change — other
`BP.md` uses, if any, are content-specific and stay.)

### 3.2 Detail reading column — `DetailScaffold` max-width

`DetailScaffold.tsx:121-126` renders its content full-bleed. Add a generous max-width so a short
id/date stops stretching across a very wide viewport, without crushing wide tables:

- Add `--content-detail: 960px;` to `theme.css`.
- In the scaffold's content wrapper, cap and centre the children:
  ```tsx
  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
    <DetailBackLink to={backTo} label={backLabel} />
    <div style={{ maxWidth: 'var(--content-detail)', width: '100%' }}>
      {notFound ? <NotFound message={notFoundMessage} /> : children}
    </div>
  </div>
  ```
  (960px is generous — detail pages are forms/metadata; a wide table still has room.)

### 3.3 Auth/landing breakpoint align

`AuthPage.tsx:153` switches to its two-column split at `BP.wide` (880px); the landing hero
(`glass.css` `.hero-grid`) splits at 960px. Align auth to the landing value: `useMediaQuery(BP.wide)`
→ `useMediaQuery(BP.lg)` (960). One line.

### 3.4 Settings rows wrap cleanly

`PlatformSettingsPage.tsx:124-217` SettingRow uses `flexWrap: 'wrap'` with a `minWidth: 220` left
panel + a `width: 260` right editor, which wraps mid-row at intermediate widths. Make the right
editor go full-width when it wraps: change the right panel from a fixed `width: 260` to
`flex: '1 1 260px'` (and keep the left `flex: 1, minWidth: 220`) so the two cleanly stack as a
single full-width column when there isn't room for both. Low-priority (the §3.1 bump already gives
tablets full width), but tidies the wrap.

---

## 4. Thread B — accessibility / status colour

### 4.1 Neutral `PillTone`

`Pill.tsx:3-11` defines `PillTone = 'ok' | 'run' | 'wait' | 'fail' | 'idle'` with no neutral/info
tone, so non-status labels borrow the amber `run`. Add a `neutral` tone:

```ts
export type PillTone = 'ok' | 'run' | 'wait' | 'fail' | 'idle' | 'neutral';
const TONE_COLOR: Record<PillTone, string> = {
  ok: 'var(--ok)',
  run: 'var(--run)',
  wait: 'var(--wait)',
  fail: 'var(--fail)',
  idle: 'var(--idle)',
  neutral: 'var(--muted)',
};
```

Migrate the **non-status** `run` chips to `neutral`:

- `RelayTracesPage.tsx` route-tag chip (`<Pill tone="run">{r.route_tag}</Pill>`) → `neutral`.
- `AuditLogPage.tsx` target-id filter chip → `neutral`.
- `PlatformSettingsPage.tsx:149` override marker (`tone={isOverride ? 'run' : 'idle'}`) → `neutral`
  for the override case.
- **Keep `run`** for genuine in-progress: `StatusBadge` `running`, and `TraceViewer.tsx` live-stream
  indicator (it really is "live/in-progress").

### 4.2 Sparkline a11y

`StatusPage.tsx:240-271` `Sparkline` encodes green/amber/red per day with only a native `title`.
Wrap the bar container in `role="img"` + an `aria-label` summarising the window (reuse the
`TimeSeriesChart.tsx:69-71` `role="img"`/`aria-label` pattern), keeping the per-bar `title` for
sighted hover:

```tsx
<div role="img" aria-label={t('status.sparkAria', { days: history.length, ok: okDays, err: errDays })}
     style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height: 28 }}>
```

(`okDays`/`errDays` computed from `history`; add the `status.sparkAria` i18n key.)

### 4.3 Plugin test result label

`PluginsPage.tsx:382-394` shows the sandbox test result as green-vs-red text with no label. Prepend a
`StatusBadge` (`tone='ok'`/`'fail'`) + an OK/Error label above the `<pre>`:

```tsx
<StatusBadge
  tone={testOut.ok ? 'ok' : 'fail'}
  label={t(testOut.ok ? 'plugins.testOk' : 'plugins.testError')}
/>
```

(add the `plugins.testOk` / `plugins.testError` i18n keys.) The colour-coded `<pre>` stays as a
secondary cue.

### 4.4 Caution colour reconcile

The 95–99% success "caution" band renders `var(--wait)` (orange) in `StatusPage.tsx:13-17` but
`var(--warn, var(--accent))` in `OverviewPage.tsx:220-221`. Standardise on `--wait` (orange — visibly
distinct from the amber `run`): change `OverviewPage` to `var(--wait)`. (`--warn` is aliased to
`--run`/amber and is now unused by the caution band; leave the token.)

### 4.5 `--faint` contrast spot-fix

`--faint` (#a39c8b dark / #9b927f light) at caption/micro sizes on a glass/translucent surface sits
near the WCAG-AA floor. Spot-check the flagged spots and switch the ones that fail AA to `--muted`
(a clearly-passing neutral): `AuthPage.tsx:120-124` micro eyebrow on `.glass`, `StatusPage.tsx:244`
no-history caption. **No change to the `--faint` token itself** (it's fine on opaque surfaces).

---

## 5. i18n keys to add

`status.sparkAria` (with `{days, ok, err}`), `plugins.testOk`, `plugins.testError` — in both
`zh-CN` and `en` console locale files.

## 6. Testing

- **Unit:** `Pill` renders the `neutral` tone (a `var(--muted)` chip); the sparkline container has
  `role="img"` + a non-empty `aria-label`; the plugin test panel renders a `StatusBadge` with the
  OK/Error label.
- **Visual:** at ~860px width the console shows the mobile layout (BottomTabs, full-width content),
  at ≥960px the Rail+SubNav; a detail page caps its content at ~960px and centres; both themes.
- **Acceptance:** typecheck + lint + full vitest + `vite build` green. Behaviour changes are the
  intended responsive + a11y improvements only.

## 7. Risks & mitigations

| Risk                                                           | Mitigation                                                                                |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Bumping the chrome breakpoint changes layout for 768–960 users | They get the proven mobile layout (already shipped for <768); verify nav works at ~860px. |
| `DetailScaffold` max-width crushes a wide table                | 960px is generous; spot-check the widest detail page.                                     |
| Neutral tone migration mis-categorises a chip                  | Only the 3 clearly-non-status chips migrate; in-progress/live stay `run`.                 |
| Stacked on unmerged Phase 1–3                                  | Branch off Phase 3; rebase after they merge.                                              |

## 8. Out of scope (restated)

Rail-flyout middle tier; global `--faint` change; Phase 5.
