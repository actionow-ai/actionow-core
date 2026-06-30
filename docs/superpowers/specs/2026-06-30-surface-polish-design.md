# Phase 5 — 次要面打磨 (secondary-surface polish)

**Date:** 2026-06-30
**Status:** Design approved, pending spec review
**Scope:** `apps/web` (frontend only). **Final** phase of the 5-phase frontend-quality program.
**Branch:** `feat/console-surface-polish`, **stacked on Phase 4** (`feat/console-responsive-a11y`). Rebase to `main` after the upstream branches merge.

---

## 1. Background

The 2026-06-30 design audit's P2 "secondary-surface polish": four lower-traffic surfaces that read as
less finished than the rest. All low-risk, no new features.

---

## 2. Goals / non-goals

### Goals

- The playground "coming soon" placeholder matches the polish of its `ChatWelcome` sibling.
- The media gallery shows non-square media in full, has a uniform audio tile, and never claims
  "no media" when only the filtered modality is empty.
- The Dify import result is impossible to miss.
- The long fault-policy / limit-plan editors read as grouped sections, not a flat field wall.

### Non-goals

- A multi-step Dify wizard (keep the single modal).
- A masonry / natural-height media gallery (keep the uniform grid).
- Any new feature or backend change. Phase boundary: this completes the program.

---

## 3. Item 1 — PlaygroundComingSoon → ChatWelcome language

`ChatWelcome.tsx` defines `Badge` (56px icon badge, lines 124-144) and `Center` (lines 105-122)
**locally**. `PlaygroundComingSoon.tsx` (lines 14-42) is a bare faint icon on flat `--bg`.

- **Extract** `Badge` + `Center` into a shared `features/app/playground/welcome-chrome.tsx`
  (named exports, identical implementations). `ChatWelcome.tsx` imports them (deletes its local
  copies — dedup, consistent with Phase 2).
- **Rewrite** `PlaygroundComingSoon` to use them:
  ```tsx
  <Center>
    <Badge icon={<Icon size={26} weight="fill" />} accent />
    <h2
      style={{
        margin: 0,
        fontSize: 'var(--fs-lg)',
        fontWeight: 'var(--fw-semibold)',
        color: 'var(--text)',
      }}
    >
      {t(`playground.tool.${modality}`)}
    </h2>
    <p
      style={{
        margin: 0,
        fontSize: 'var(--fs-sm)',
        color: 'var(--faint)',
        maxWidth: '42ch',
        lineHeight: 1.6,
      }}
    >
      {t('playground.comingSoonBody')}
    </p>
  </Center>
  ```
  (`Icon`/`modality`/i18n keys are already in the file.)

`Badge` and `Center` stay playground-local (not promoted to `components/ui`) since only the
playground uses them — avoids over-generalising.

---

## 4. Item 2 — AppMedia gallery (`features/app/AppMedia.tsx`)

### 4.1 Aspect-ratio: stop cropping non-square media

The card preview is a fixed `aspectRatio: '1 / 1'` glass-bg frame (≈ line 184); image + video use
`objectFit: 'cover'` (≈ lines 204, 237), cropping non-square media. Change both to
`objectFit: 'contain'` — the full asset shows, letterboxed on the glass-bg, and the grid stays
uniform.

### 4.2 Audio tile fits the frame

The audio branch (≈ lines 206-231) is a padded flex column that breaks the 1:1 rhythm. Make it fill
the same square: a centered `MusicNotesIcon` badge with a compact `<audio controls>` pinned at the
bottom of the square (absolute / flex-end), so the tile footprint matches image/video cards.

### 4.3 Empty state stops lying + clear-filter

`CardCollection`'s `empty` is `t('app.media.empty')` unconditionally (≈ line 168), even when a `kind`
filter (image/video/audio) is active. Make it kind-aware:

```tsx
empty={filter ? t('app.media.emptyKind', { kind: t(`app.media.kind.${filter}`) }) : t('app.media.empty')}
```

Add the `app.media.emptyKind` i18n key (`"没有{{kind}}素材"` / `"No {{kind}} media yet"`). Also add a
small **clear-filter** affordance next to the kind `SelectField` (a ghost "全部"/clear button or an
`✕` that calls `setKind('')`) shown only when `filter` is set.

---

## 5. Item 3 — Dify import result prominence (`features/console/DifyImportPage.tsx`)

The compat report renders inline below a tall modal of form fields (≈ lines 240-257), easy to miss.
Keep the single modal; make the result un-missable:

- When `report` is present, render a success header above the report panel:
  `<StatusBadge tone="ok" label={t('dify.imported')} />` (add `dify.imported`).
- Scroll the report into view on appearance (a `ref` + `useEffect(() => ref.current?.scrollIntoView({ block: 'nearest' }), [report])`).
- Once a `report` exists, swap the footer CTA from submit to a Close action (`t('common.done')` →
  `onClose`), so the user isn't tempted to re-submit.

---

## 6. Item 4 — Editor section grouping

Insert the existing `SectionHeader` (`components/ui/SectionHeader.tsx`, `{title, action?}`) between
the logical field groups — **layout only, no field changes**.

### 6.1 `FaultPoliciesPage.tsx` `FaultPolicyEditor` (≈ lines 250-612)

Group with `SectionHeader`s: **基本** (name, mode) · **重试** (retryCount/backoff…, shown for retry
mode) · **超时** (connect/ttft/total/idle) · **触发条件** (retryCodes, retryMessages) · **熔断**
(the existing collapsible breaker block) · **元数据** (status, description). Add the section-title
i18n keys under `faultPolicies.section.*`.

### 6.2 `LimitPlansPage.tsx` `LimitPlanEditor` (≈ lines 271-485)

A **基本** `SectionHeader` over name/description/status, and formalise the existing rules header into
a `SectionHeader title={t('limitPlans.form.rules')} action={<add-rule button>}`. Add
`limitPlans.section.basic` (reuse `limitPlans.form.rules` for the rules title).

---

## 7. i18n keys to add (both `zh-CN` + `en` console locale)

`app.media.emptyKind`, `app.media.clearFilter`; `dify.imported`; `faultPolicies.section.{basic,retry,timeouts,triggers,breaker,meta}`; `limitPlans.section.basic`.

## 8. Testing

- **Unit:** the extracted `Badge` renders its icon (accent + non-accent); `AppMedia` empty copy is
  kind-aware when a filter is set (render with `?kind=video` → "no video media").
- **Visual:** ComingSoon matches ChatWelcome (badge + centered hierarchy); a non-square image shows
  in full (no crop); the audio tile matches the image/video footprint; the Dify result shows a
  success badge + scrolls into view; the two editors read as grouped sections; both themes.
- **Acceptance:** typecheck + lint + full vitest + `vite build` green. Behaviour-preserving except
  the intended polish.

## 9. Risks & mitigations

| Risk                                                    | Mitigation                                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `object-fit: contain` letterboxes images (visible bars) | Acceptable — the glass-bg frame already implies a "card"; full media > cropped. |
| Extracting Badge/Center changes ChatWelcome             | Identical implementations moved verbatim; ChatWelcome unit/visual unchanged.    |
| Section-header insertion reflows the editors            | Layout-only; no field/logic change; visual check both editors.                  |
| Stacked on unmerged Phase 1–4                           | Branch off Phase 4; rebase after they merge.                                    |

## 10. Out of scope (restated)

Dify wizard; media masonry; promoting Badge/Center to `components/ui`; any new feature.
