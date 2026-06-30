# Phase 1 — Liquid-Glass Material + Token Tightening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in, cross-browser liquid-glass material tier and exhaustively tighten the token layer, applied broadly across `apps/web` chrome/floating/showcase/entity-cards, fixing the `/app` material-hierarchy inversion — with zero visible regressions.

**Architecture:** Two new CSS classes (`.liquid-glass`, `.liquid-glass--subtle`) built on existing glass tokens in `glass.css`, fed by new tokens in `theme.css`. Surfaces opt in by swapping/adding a className. A parallel token sweep replaces hardcoded literals with tokens. No JS behavior changes; no displacement/refraction.

**Tech Stack:** React 19 + Vite 6 + TypeScript, Tailwind v4 + plain CSS custom properties. Tests: vitest. Verification: preview dev server + screenshots.

**Spec:** `docs/superpowers/specs/2026-06-30-liquid-glass-material-token-foundation-design.md`

**Verification note:** CSS/material changes are verified visually (preview screenshots in both themes) rather than by unit assertions. Every task ends with `pnpm -C apps/web typecheck` (or build) green + a visual check where the change is observable. Run the dev server once at the start (Task 0) and reuse it.

---

## File map

| File                                                                                                                    | Responsibility                                            | Tasks |
| ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ----- |
| `apps/web/src/styles/theme.css`                                                                                         | New tokens (control-h, fw-heading, s-0/s-1h, lg-backdrop) | 1     |
| `apps/web/src/styles/glass.css`                                                                                         | Material classes, a11y fallback, control-h on primitives  | 2, 3  |
| `components/console/chrome/Rail.tsx`, `SubNav.tsx`, `TopBar.tsx`                                                        | Chrome → `.liquid-glass`                                  | 4     |
| `components/ui/Modal.tsx`, `Drawer.tsx`                                                                                 | Floating panels → `.liquid-glass` (keep `--overlay-bg`)   | 5     |
| `features/app/AppOverview.tsx` (+ `BalanceCard`)                                                                        | `/app` hero → `.liquid-glass` (fix inversion)             | 6     |
| `components/landing/CTASection.tsx`, `Pricing.tsx` + heading sweep                                                      | Landing accents + `--fw-heading`                          | 7     |
| `components/data/EntityCard.tsx`                                                                                        | `.entity-card` → add `.liquid-glass--subtle`              | 8     |
| `Pill.tsx`, `SegmentedControl.tsx`, `FormField.tsx`, `ChipsField.tsx`, `KeyValueEditor.tsx`, `SubNav.tsx`, `card-glyph` | Sub-token spacing sweep                                   | 3, 9  |

---

## Task 0: Branch + dev server up

Branch `feat/liquid-glass-material-tokens` already exists (spec committed there). Confirm it's checked out and start the preview server for visual verification throughout.

- [ ] **Step 1:** Confirm branch
      Run: `git branch --show-current` → Expected: `feat/liquid-glass-material-tokens`
- [ ] **Step 2:** Start dev server via preview_start; navigate to `/console/overview` and `/app/overview` to baseline-screenshot the current (pre-change) look in dark mode for before/after comparison.

---

## Task 1: Foundation tokens (`theme.css`)

**Files:** Modify `apps/web/src/styles/theme.css`

- [ ] **Step 1:** In `:root`, add after the existing `--fw-display: 850;` line:

```css
/* editorial section-heading weight — tokenizes landing's raw 780/760. */
--fw-heading: 780;
```

- [ ] **Step 2:** In `:root` spacing block, add the two missing micro-steps (after `--s-1: 4px;`):

```css
--s-0: 2px;
--s-1h: 6px;
```

- [ ] **Step 3:** In `:root`, add a control-height token near the spacing block:

```css
/* canonical interactive control height (Select/field/button/icon-button). */
--control-h: 40px;
```

- [ ] **Step 4:** In `:root` (dark, near the glass tokens ~line 95), add the liquid-glass backdrop recipes:

```css
/* liquid-glass backdrop recipes (full = blurred; subtle = no blur for high-count grids). */
--lg-backdrop: blur(28px) saturate(190%) brightness(1.06);
--lg-backdrop-subtle: saturate(150%) brightness(1.03);
```

- [ ] **Step 5:** In the `[data-theme='light']` block, add the light overrides (light `--glass-bg` is far more opaque, so less saturate/brightness):

```css
--lg-backdrop: blur(28px) saturate(150%) brightness(1.02);
--lg-backdrop-subtle: saturate(135%) brightness(1.01);
```

- [ ] **Step 6:** Verify: `pnpm -C apps/web typecheck` (CSS-only; just ensure nothing else broke) and reload preview — no visual change expected yet (tokens unused).
- [ ] **Step 7:** Commit: `git commit -am "feat(web): add liquid-glass + control-h/fw-heading/s-0 tokens"`

---

## Task 2: Material classes + a11y fallback (`glass.css`)

**Files:** Modify `apps/web/src/styles/glass.css`

- [ ] **Step 1:** After the `.panel { … }` block (top of file), add the two material classes:

```css
/* Liquid glass — richer opt-in tier for chrome / floating / showcase surfaces.
   Sheen is in the background gradient (not a ::before) so the class stays composable.
   Surfaces that need legibility (Modal/Drawer) override `background` inline and still
   get the specular edges + ambient shadow below. */
.liquid-glass {
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--glass-hl) 28%, var(--glass-bg)),
    var(--glass-bg) 42%
  );
  backdrop-filter: var(--lg-backdrop);
  -webkit-backdrop-filter: var(--lg-backdrop);
  border: 1px solid var(--glass-bd);
  box-shadow:
    inset 0 1px 0 var(--glass-hl),
    inset 0 -1px 0 color-mix(in srgb, var(--glass-hl) 30%, transparent),
    var(--glass-shadow);
}
/* Subtle tier — high-count surfaces (entity-card grids): gradient sheen + specular
   edge + saturate, but NO backdrop blur (avoids dozens of stacked GPU blur layers). */
.liquid-glass--subtle {
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--glass-hl) 18%, var(--panel-bg)),
    var(--panel-bg) 50%
  );
  backdrop-filter: var(--lg-backdrop-subtle);
  -webkit-backdrop-filter: var(--lg-backdrop-subtle);
  box-shadow:
    inset 0 1px 0 var(--glass-hl),
    var(--shadow-lift);
}
```

- [ ] **Step 2:** Extend the existing `@media (prefers-reduced-transparency: reduce)` block (near end of file) to flatten the new classes. Change it to include:

```css
@media (prefers-reduced-transparency: reduce) {
  .glass {
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    background: var(--panel-bg);
  }
  .panel {
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
  .liquid-glass,
  .liquid-glass--subtle {
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    background: var(--panel-bg);
  }
}
```

- [ ] **Step 3:** Verify: reload preview — still no visual change (classes unused). `pnpm -C apps/web typecheck` green.
- [ ] **Step 4:** Commit: `git commit -am "feat(web): add .liquid-glass / .liquid-glass--subtle material classes"`

---

## Task 3: Control-height token on primitives (`glass.css` + field components)

**Files:** Modify `apps/web/src/styles/glass.css`; `components/ui/ChipsField.tsx`; `components/ui/KeyValueEditor.tsx`

- [ ] **Step 1:** In `glass.css`, `.field`: change `min-height: 42px;` → `min-height: var(--control-h);`
- [ ] **Step 2:** In `glass.css`, `.btn` (md base): change `min-height: 40px;` → `min-height: var(--control-h);` (leave `.btn-sm` 32px and `.btn-lg` 48px).
- [ ] **Step 3:** In `glass.css`, `.ico-btn`: change `height: 40px;` → `height: var(--control-h);` (width stays 40px or also → `var(--control-h)` for a square; set both width and height to `var(--control-h)`).
- [ ] **Step 4:** In `ChipsField.tsx`, replace the `minHeight: 40` literal with `minHeight: 'var(--control-h)'`.
- [ ] **Step 5:** In `KeyValueEditor.tsx`, replace the `minHeight: 40` literal with `minHeight: 'var(--control-h)'`.
- [ ] **Step 6:** Verify: in preview, open a console CRUD page with a filter toolbar (e.g. `/console/api-keys`) and confirm the Select/field now aligns with the refresh icon-button and CTA on the same row (no 2px step). Screenshot. `pnpm -C apps/web typecheck` green.
- [ ] **Step 7:** Commit: `git commit -am "fix(web): unify control height via --control-h (field 42→40)"`

---

## Task 4: Apply `.liquid-glass` to chrome (Rail, SubNav, TopBar)

**Files:** `components/console/chrome/Rail.tsx`, `SubNav.tsx`, `TopBar.tsx`

- [ ] **Step 1:** `Rail.tsx` line ~31: change `className="glass"` → `className="liquid-glass"`.
- [ ] **Step 2:** `SubNav.tsx` line ~24: change `className="glass"` → `className="liquid-glass"`.
- [ ] **Step 3:** `TopBar.tsx`: read it first. If the top bar has no glass surface, wrap its container with `className="liquid-glass"` and an appropriate `border-radius`/padding consistent with Rail/SubNav. If adding a surface changes layout undesirably, instead apply only the specular treatment (keep it subtle) — verify visually before committing.
- [ ] **Step 4:** Verify: preview `/console/overview` and `/app/overview` in dark AND light mode. The rail + subnav should now read richer (stronger sheen/blur, specular edge) without harming legibility. Screenshot both themes. Compare to Task 0 baseline.
- [ ] **Step 5:** Commit: `git commit -am "feat(web): liquid-glass chrome (rail, subnav, topbar)"`

---

## Task 5: Apply `.liquid-glass` to floating panels (Modal, Drawer)

**Files:** `components/ui/Modal.tsx`, `components/ui/Drawer.tsx`

Both panels use `className="glass"` with an inline `background: 'var(--overlay-bg)'` override (kept for form legibility). Swapping the class keeps them opaque while the specular edges + ambient shadow upgrade apply.

- [ ] **Step 1:** `Modal.tsx` line ~132 (the dialog `div`): change `className="glass"` → `className="liquid-glass"`. Leave the inline `background: 'var(--overlay-bg)'` (Modal stays legible; only the edge/shadow upgrades).
- [ ] **Step 2:** `Drawer.tsx` line ~128 (the panel `div`): change `className="glass"` → `className="liquid-glass"`. Leave inline `background: 'var(--overlay-bg)'`.
- [ ] **Step 3:** Verify: preview — open a Modal (e.g. a delete confirm on `/console/api-keys`) and a Drawer (e.g. a route-group editor on `/console/groups`). Confirm the panel still reads near-opaque/legible, now with a crisper specular top edge + deeper ambient shadow. Screenshot.
- [ ] **Step 4:** Commit: `git commit -am "feat(web): liquid-glass specular edge on modal/drawer panels"`

---

## Task 6: `/app` hero → `.liquid-glass` (fix material-hierarchy inversion)

**Files:** `features/app/AppOverview.tsx`, and `BalanceCard` (locate via its import in AppOverview)

- [ ] **Step 1:** Read `AppOverview.tsx` and find where the balance card + KPI band are rendered and what surface class they use (`.panel` per audit).
- [ ] **Step 2:** Locate `BalanceCard` (likely `components/data/BalanceCard.tsx` or similar). Check whether it's used on `/console` too.
  - If used ONLY on `/app`: change its surface from `.panel` → `.liquid-glass`.
  - If shared with `/console`: add an opt-in prop (e.g. `material?: 'panel' | 'liquid-glass'`, default `'panel'`) and pass `material="liquid-glass"` from the `/app` call-site only — do NOT change the default.
- [ ] **Step 3:** Apply `.liquid-glass` to the AppOverview KPI band/cards similarly (only the `/app` hero region; not dense lists).
- [ ] **Step 4:** Verify: preview `/app/overview` in dark AND light. The tenant home should now read _richer_ than `/console/overview` (the intended divergence). Screenshot side-by-side with `/console/overview`.
- [ ] **Step 5:** Commit: `git commit -am "feat(web): /app overview hero on liquid-glass (fix material hierarchy)"`

---

## Task 7: Landing accents + heading-weight token sweep

**Files:** `components/landing/CTASection.tsx`, `Pricing.tsx`, `LiveConsole.tsx`, `Scenarios.tsx`, `HowItWorks.tsx`, `FeaturePan.tsx`

- [ ] **Step 1:** Heading sweep — in each landing component, replace raw `fontWeight: 780` and `760` with `fontWeight: 'var(--fw-heading)'`, and `fontWeight: 680` with `fontWeight: 'var(--fw-semibold)'`. (Grep each file for `fontWeight: 7` and `fontWeight: 68` to find them.)
- [ ] **Step 2:** Apply `.liquid-glass` to the landing accent cards: the CTASection card (`CTASection.tsx`) and the featured/recommended pricing card (`Pricing.tsx`). Add `liquid-glass` to the existing className (or replace `.glass`/`.panel`).
- [ ] **Step 3:** Verify: preview `/` (landing) in dark AND light. Confirm H2 weights are now uniform down the page and the CTA/featured-pricing cards read premium. Screenshot.
- [ ] **Step 4:** Commit: `git commit -am "feat(web): landing accent cards on liquid-glass + --fw-heading sweep"`

---

## Task 8: `.entity-card` → `.liquid-glass--subtle`

**Files:** `components/data/EntityCard.tsx`

- [ ] **Step 1:** Read `EntityCard.tsx`. The root element uses `className="entity-card"` (which sets `--panel-bg` + border in `glass.css:381`). Add `liquid-glass--subtle` to its className list so the card gets the sheen + specular edge (no backdrop blur).
- [ ] **Step 2:** In `glass.css`, ensure `.entity-card` and `.liquid-glass--subtle` compose cleanly — `.entity-card` already sets `background: var(--panel-bg)`, which would override the subtle gradient. Resolve by removing the `background`/`box-shadow` from `.entity-card` (let `.liquid-glass--subtle` own them) OR by applying `--subtle` styles directly within `.entity-card`. Prefer: keep `.entity-card` for layout (padding/radius/transition/hover) and let `.liquid-glass--subtle` own background + base shadow; delete the now-duplicated `background`/inset from `.entity-card`. Verify `.is-selected`/`.is-clickable:hover` still win (they set border/box-shadow with higher specificity or later source order — keep them after).
- [ ] **Step 3:** Verify: preview a card grid (`/console/platforms` or `/app/media`) in dark AND light. Cards should read as soft glass tiles with a top sheen; scroll a long grid and confirm no jank (perf smoke). Screenshot. If the saturate/brightness backdrop pass shows cost on long grids, drop `backdrop-filter` from `.liquid-glass--subtle` (spec §10 contingency) and re-verify.
- [ ] **Step 4:** Commit: `git commit -am "feat(web): entity cards on liquid-glass subtle tier"`

---

## Task 9: Sub-token spacing sweep (exhaustive)

**Files:** `Pill.tsx`, `SegmentedControl.tsx`, `FormField.tsx`, `EntityCard.tsx`, `SubNav.tsx`, `glass.css` (`.card-glyph`, `.chip`), landing glyph radii

Rounding rule (spec §6c): **zero visible regression is the hard constraint.** Map `2→--s-0`, `6→--s-1h`; snap rare oddballs `3→--s-0`, `5→--s-1`, `7→--s-2`, `9→--s-2`, `11→--s-3`, `12→--s-3` **only where review confirms no visible change**; otherwise keep the exact value via a token comment.

- [ ] **Step 1:** Grep the inventory: `rg "gap: ?[2357]\b|gap: ?'?[2357]|padding: ?'[0-9]|marginTop: ?[23]|borderRadius: ?1[012]\b" apps/web/src/components apps/web/src/features` to enumerate remaining literals beyond the audit's list.
- [ ] **Step 2:** Replace per the rounding rule, file by file. Known from audit: `Pill.tsx` `gap:5`→`var(--s-1)`, `padding:'3px 9px'`→`'var(--s-0) var(--s-2)'` (verify proportions); `SegmentedControl.tsx` `gap:2`→`var(--s-0)`, `padding:'7px 14px'`→keep or `'var(--s-2) 14px'` (14 has no clean token; keep exact if rounding to 16 widens visibly); `EntityCard.tsx` `gap:6`→`var(--s-1h)`, `marginTop:3`→`var(--s-0)`; `FormField.tsx` `gap:6`→`var(--s-1h)`; `SubNav.tsx` `padding:'0 12px'`→`'0 var(--s-3)'`, `marginBottom:4`→`var(--s-1)`; `glass.css` `.card-glyph` `border-radius:10px`→`var(--r-xs)` (8) only if visually fine else keep, `.chip` `gap:6`→`var(--s-1h)`/`padding:4px 11px`→`var(--s-1) var(--s-3)` (verify).
- [ ] **Step 3:** Verify: preview each touched primitive (a Pill in a table, a SegmentedControl on `/app/usage`, an EntityCard, a form) in both themes; confirm no proportion shift vs baseline. Screenshot the ones that changed.
- [ ] **Step 4:** Commit: `git commit -am "refactor(web): sweep hardcoded sub-token spacing to scale tokens"`

---

## Task 10: Full verification + final pass

- [ ] **Step 1:** `pnpm -C apps/web typecheck` → green.
- [ ] **Step 2:** `pnpm -C apps/web lint` → green (or only pre-existing warnings).
- [ ] **Step 3:** `pnpm -C apps/web test` → green. If EntityCard/chrome snapshot tests fail on the className/style change, review the diff; update snapshots only where the change is intended.
- [ ] **Step 4:** `pnpm -C apps/web build` → succeeds (catches CSS/`vite build` issues; see the known SDK/build CI gap).
- [ ] **Step 5:** Visual matrix via preview — screenshot `/`, `/console/overview`, `/app/overview`, a Modal, a Drawer, a card grid in: **dark**, **light** (`[data-theme='light']`), and **reduced-transparency** (emulate `prefers-reduced-transparency: reduce`) confirming the fallback flattens to solid. Cross-browser sanity if available.
- [ ] **Step 6:** Final commit if anything outstanding; summarize the before/after with screenshots.

---

## Self-review notes (filled during writing)

- **Spec coverage:** §4 tokens → Task 1; §5 classes+fallback → Task 2; §6a control-h → Task 3; §6b headings → Task 7; §6c spacing → Tasks 3/9; §7 application map → Tasks 4/5/6/7/8; §8 /app fix → Task 6; §9 verification → Task 10. All covered.
- **Type consistency:** `--control-h`, `--fw-heading`, `--s-0`, `--s-1h`, `--lg-backdrop`, `--lg-backdrop-subtle`, `.liquid-glass`, `.liquid-glass--subtle` used identically across tasks.
- **Open resolve-at-execution items (not placeholders — explicit decisions gated on reading current code):** TopBar surface treatment (Task 4.3), BalanceCard shared-vs-app prop (Task 6.2), EntityCard `.entity-card` background de-dup (Task 8.2), per-literal rounding keep-or-snap (Task 9.2). Each has an explicit decision rule.
