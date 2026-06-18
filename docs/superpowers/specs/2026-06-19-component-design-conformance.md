# Component Design Conformance — `Components.dc.html`

**Date:** 2026-06-19 · **Branch:** `feat/admin-frontend`
**Source of truth:** `docs/design/project/Components.dc.html` (Claude Design handoff)
**Decisions:** Visuals/tokens/geometry follow the design; **live behavior & a11y are preserved** where they exceed the spec (keyboard models, focus traps, portaled tooltip, count-up, tri-state sort, light-theme shadow tuning). **Components only** — no in-app gallery page. Approach **C (hybrid)**: add shared infra only where there's a real reuse gap (field focus/error ring, `--demo-*` tokens, generic `Pill`); fix everything else in place in the existing inline-style + `glass.css` idiom. No prop/signature removals.

Derived from a full per-section audit (42 components: 28 drifting, 1 token gap, 5 low-risk watch items). Live class names differ from the spec in places (`.row-action` ≈ spec `.rowact`); reconcile to live names, match spec values.

## Wave 0 — Foundations

- **theme.css**: add `--demo-bg`/`--demo-bd` to dark `:root` (`rgba(255,255,255,.025)` / `rgba(255,255,255,.07)`) and `[data-theme='light']` (`rgba(120,90,20,.04)` / `rgba(0,0,0,.05)`).
- **glass.css**: add a shared `.field` surface — `background:var(--glass-bg)`, `border:1px solid var(--panel-bd)`, `border-radius:var(--r-sm)`, `min-height:42px`, `padding:10px 12px`, `transition:border-color/box-shadow .15s`; `:focus` → `border-color:var(--hover-bd)` + `box-shadow:0 0 0 2px color-mix(accent 30%)`; `.field--err`/`[aria-invalid]` → `fail` border + `0 0 0 2px color-mix(fail 25%)`. Replaces the auth-only focus rule for all fields.

## Wave 1 — Button + Forms + Badges/Pill

- **Button** (`ui/Button.tsx`): `min-height` 40 (md) / 32 (sm) / 48 (lg); paddings 10·16 / 7·12 / 13·22; gap 7; transition `.15s` incl. opacity; **danger** → `color-mix(fail 14%)` bg + `color-mix(fail 40%)` border + hover `fail 22%`; disabled `opacity:.45` + `not-allowed` + no shadow/transform. Keep `link` variant + `to`/`href`.
- **Fields** (`TextField`, `NumberField`, `Select` trigger, `ComboboxField`, `JsonField`, `fieldStyles.ts`): adopt `.field` (glass-bg, min-height 42, focus/error rings, transition) replacing `className="panel"` + inline border; NumberField adds `tabular`.
- **StatusBadge** (`data/StatusBadge.tsx`): add 6px `.pdot` (currentColor), `inline-flex`/`gap:5`/`nowrap`; reference named tone token in bg mix. Extract generic **`Pill`** (`ui/Pill.tsx`); StatusBadge + MockBadge compose it.
- **`.chip`** (glass.css): padding `4px 11px` + `display:inline-flex`/`align-items:center`/`gap:6px`. **`.card-glyph`** 36→38px.

## Wave 2 — Controls & geometry

- **Toggle** 38×22 → **46×26**, knob 18→20 always white (`#fff`). **Checkbox** 18→**22**, border `1.5px`, empty state `background:var(--glass-bg)`, check icon 13→14.
- **SegmentedControl** → `border-radius:var(--r-sm)`, `display:inline-flex`, `glass-bg`, padding 3 / gap 2, buttons `padding:7px 14px`/`min-height:34`/`r 8px`, **static per-button `grad-accent` fill** (drop sliding indicator + shadow). Keep radiogroup roles + arrow-key nav.
- **IconButton** (`.ico-btn` glass.css + `ui/IconButton.tsx`): default rest → filled glass (`border:1px solid transparent`, `background:var(--glass-bg)`), hover adds `border-color:var(--hover-bd)`, transition incl. border-color `.15s`. Add **`bare`** prop/class (current transparent rest); migrate close/rail/topbar call-sites to `bare`.
- **RowAction** (`.row-action` glass.css): 30→**34**.
- **ChipsField**: add-chip `border:1px dashed var(--hover-bd)` + `color:var(--accent-2)`; remove-button 24×24. **KeyValueEditor**: mono inputs, `=` separator (`--faint`), delete via `.row-action` (34) not IconButton, min-height 40.

## Wave 3 — Data & Nav

- **StatCard** (`console/StatCard.tsx`): value `--fs-xl`→**`--fs-2xl`**, weight 700→**800**; add optional `delta` prop (inline-flex, gap 4, mt 6, `--fs-caption`, up=`--ok`/down=`--fail`, arrow icon). Wrap value in own span so count-up doesn't clobber delta.
- **DataTable** (`data/DataTable.tsx`): header padding 10→**11px**; active sort caret tint → `--accent-2`. Keep tri-state sort, sticky/pinned cols, search, pagination, selection, mobile cards.
- **Tabs** (`ui/Tabs.tsx`): `min-height:44`, padding 11·4, tablist gap `--s-5`, `overflowX:auto`. **SubNav** (`console/chrome/SubNav.tsx`): item height 34→38, stride 38→42, padding `0 12px`, `font-weight:var(--fw-medium)`. **BottomTabs**: `min-height` 44→**56**, sides 14px.

## Wave 4 — Overlays

- **Modal/Drawer/ConfirmDialog**: padding `s-5`→**`s-6`**, title `fs-md`→**`fs-lg`**, footer gap `s-2`→**`s-3`**, scrim `backdrop-filter:blur(2px)`. **Drawer**: footer top divider (`padding-top:s-4` + `border-top:1px var(--row-bd)`), enter anim full `translateX(100%)` (not x:40 nudge). **ConfirmDialog**: message → demo-block callout (`--demo-bg`/`--demo-bd`/`--r-sm`/`s-4`/lh 1.6), entity id in `--accent-2`. **Modal**: optional subtitle slot.
- **Tooltip** (`ui/Tooltip.tsx`/`Floating.tsx`): restore `:after` caret, `box-shadow:var(--shadow-lift)`, `ano-fade` rise, padding `8px 11px`. **Keep portaling + flip + clamp.**
- **Toaster** (`ui/Toaster.tsx`): re-anchor bottom-**center** (`left:50%;bottom:28px;translateX(-50%)`), `.glass`→`.panel`, `r-md`→**`r-pill`**, padding `12px 18px`, `font-weight:600`, leading ✓ for `ok` tone, `box-shadow:var(--shadow-lift)`. Keep aria-live/tones/reduced-motion.
- **CopyField** (`data/CopyField.tsx`): unified `.copyf` inline-flex pill (glass-bg, panel-bd border, r-sm, padding `8px 8px 8px 14px`, mono, min-height 42), copy via icon `.row-action` with icon→✓ swap. Keep clipboard-failure guard, unmount timer clear, aria-live.

## Verification

Per wave: `pnpm --filter @actionow/web typecheck` + `pnpm --filter @actionow/web test`. Final: preview dark/light spot-check of refactored components; commit on `feat/admin-frontend`.

## Breaking-change ledger (all low-risk, no API removals)

`link` Button variant kept · danger fill is a visual change to all danger buttons · IconButton default rest changes (mitigated by migrating existing call-sites to `bare`) · CopyField affordance text→icon (1 consumer) · Toaster moves bottom-center (16 consumers, API unchanged).
