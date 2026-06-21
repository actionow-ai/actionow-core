# Actionow Web — Component Library Audit

> 12-agent audit (5 buckets × review→adversarial-verify + reference + synthesis). 48 confirmed findings (1 P0 / 16 P1 / 31 P2), 0 rejected on re-read. **Analysis only — no code changed.** Generated 2026-06-18.

---

# Actionow Web — Component-Library Audit

**Audience:** design-system owner · **Scope:** `apps/web/src` · **Status:** analysis only, no code changed. Every problem below traces to an adversarially-confirmed finding. All paths absolute under `/Users/alienworm/actionow-web/apps/web/src`.

---

## 1. SYSTEMIC PATTERNS — the root issues that explain most findings

Five root causes generate ~80% of the findings. Fix these and the per-component list mostly collapses.

### S1 — Inline-absolute floating elements that aren't portaled (the "seed clipping" class)

**Pattern:** A floating panel is rendered as an inline `position:absolute` child of its trigger instead of `createPortal(document.body)` + `position:fixed` from `getBoundingClientRect()`. Its containing block is a tiny inline wrapper, so any ancestor with `overflow:auto/hidden/clip` clips it — and the app's primary surfaces are exactly those ancestors: `Modal.tsx:134` (`overflowY:auto`), `Drawer.tsx:144` (`overflowY:auto`), `ConsoleLayout.tsx:52` (`overflow:auto`).

**Components it touches:**

- `Tooltip.tsx:50` — `position:absolute`, never portaled (the seed). [P0]
- `FormField.tsx:55` — renders that Tooltip as the shared `tooltip` slot, so the defect propagates to **every field that passes `tooltip`** (TextField, NumberField, SelectField, KeyValueEditor, ChipsField, SecretSelect, CapabilitiesField, all `data/*` forms). [P1]
- `IoSchemaField.tsx:86` — renders a bare `<Tooltip>` directly in a section header inside the resource Modal. [P1]
- `IconButton.tsx:40` + `glass.css:101` — `.ico-tip` span, same `position:absolute` class; uncliped today only because its sole consumer is the Rail (no overflow ancestor). [P2, latent]
- `Rail.tsx` `.ico-tip` tooltips — same family, `z-index:60` (below overlay 80). [P2, latent]

**ONE cross-cutting fix:** Build a shared `Floating` primitive (or `usePortalRect` hook) that **reuses the already-correct Select pattern**: `createPortal(panel, document.body)`, `position:fixed` with coords from the trigger's `getBoundingClientRect()`, reposition on resize. Migrate `Tooltip` and `.ico-tip` to consume it. `FormField` and `IoSchemaField` then inherit the fix with no per-call change. This single primitive resolves the P0, two P1s, and two latent P2s at once.

### S2 — Untokenized z-index scale (raw magic numbers, no source of truth)

**Pattern:** `theme.css` defines spacing/radius/type/motion/color tokens but **zero `--z-*` tokens**. Every layer is a bare literal, so collisions can't be reasoned about centrally.

**Components it touches:** Modal/Drawer backdrop `80` (`Modal.tsx:95`, `Drawer.tsx:105`); Select/Combobox/DataTable-menu/Toaster all `90` (`Select.tsx:194`, `ComboboxField.tsx:212`, `DataTable.tsx:674`, `Toaster.tsx:45`); Tooltip `95`; `.ico-tip` `60`. The live collision: **Toaster shares `90` with dropdowns and renders _above_ the modal backdrop (`80`)** — toasts paint over open modals (`Toaster.tsx:45`). The latent one: `.ico-tip` at `60` would paint _under_ any overlay.

**ONE cross-cutting fix:** Add a `--z-*` token scale to `theme.css` (e.g. `--z-base / --z-nav / --z-overlay-scrim:80 / --z-popover:90 / --z-toast / --z-tooltip`), give toasts a dedicated slot **above** modals and popovers, and replace every literal. One token file becomes the single source of truth for the ladder.

### S3 — Index-keyed mutable row lists (focus/value drift on remove)

**Pattern:** Editable add/remove lists of **controlled inputs** keyed by array index (`key={i}`). Removing a non-last row re-indexes everything below it; React reconciles by position, so inputs below the removal surface the wrong row's value and keyboard focus/caret is stranded.

**Components it touches:** `KeyValueEditor.tsx:76-77`; `IoSchemaField.tsx:88` (`key={i}` at :92, `removeRow` filters by index); `PricebookSpecForm.tsx:45` (dimensions) and `:86` (matrix table). All four hold controlled `TextField`/`NumberField` inputs. All P1.

**ONE cross-cutting fix:** Mint a stable per-row `id` at creation time in each shape factory (`kvRows.ts`, `emptyIoField()` in `ioSchemaShape`, `SpecFormState`) and key on it. Establish "key editable lists by stable id, never index" as a house rule so future row editors inherit it.

### S4 — Field-contract drift (control-level cues and width not standardized)

**Pattern:** `FormField` owns label/error/hint _text_ only; each field owns its control's border/ring/width. That responsibility split has drifted inconsistently across the bucket.

- **Error border:** `TextField.tsx:47` and `NumberField.tsx:48` set only `aria-invalid` — **no red border** — while `JsonField.tsx:55` paints `borderColor:var(--fail)`. Sighted users get only the caption text on Text/Number. [P1]
- **Width:** `TextField.tsx:49-56` and `NumberField.tsx:53-60` have **no `width:100%`**, so they render at intrinsic ~20-char width while `JsonField` (`:19`) and `ChipsField` span full width. Visibly narrower in Modals. [P1]
- **Prop parity:** `JsonField.tsx:32-44` omits `hint`/`tooltip`/`required` and makes `label` non-optional, so it can't expose the contract its peers do. [P2]

**ONE cross-cutting fix:** Tighten the field contract into a shared input-style helper (or extend `FormField`) that standardizes `width:100%`, the `error → borderColor:var(--fail)` branch, and a uniform optional prop surface (`hint`/`tooltip`/`required`) — so Text/Number/Json/Select compose from one source and can't drift again.

### S5 — Touch-target & coarse-pointer affordance gaps

**Pattern:** Interactive controls sized for mouse precision, with no minimum hit area and several hover/focus-only reveals that have **no touch path** at all.

- Sub-24px/sub-44px targets: `ChipsField` chip-remove + suggestion-add `padding:3px 9px` (~22px, `:83`/`:122`); icon-only `Checkbox.tsx:43` `padding:0` (~18px box); label-less `Toggle.tsx:32` (38×22 track); Tooltip trigger `Tooltip.tsx:36` `padding:0` (~15px); `RowAction` 30×30 (`glass.css:141`); mobile `DataTable` rows (no `minHeight`, `:306-316`); `BottomTabs.tsx:35/37` (~44px floor, off-grid `gap:3`/`padding:6px 12px`).
- Hover/focus-only with no touch fallback: `Tooltip` (no `onClick`/touch, bubble `pointerEvents:none`, `:21-22/67`); `IconButton` `.ico-tip` reveals only on `:hover`/`:focus-visible` (`glass.css:120`), unlike `RowAction` which also sets `title` (`RowAction.tsx:32`).

**ONE cross-cutting fix:** Define a `--min-touch` token (24px AA / 44px comfortable) and a shared "icon-control hit-slop" utility (padding or pseudo-element that grows the hit area without enlarging the visible box), applied on coarse pointers. Pair with a touch-reveal path baked into the same `Floating` primitive from S1 (tap-to-toggle + outside-tap dismiss), and add `title={label}` to `IconButton` to match `RowAction`.

---

## 2. PRIORITIZED PROBLEM LIST (P0 → P1 → P2)

| P      | Component               | File:line                                   | Dimension   | Issue                                                                                                                                                                                | Fix direction                                                                           |
| ------ | ----------------------- | ------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| **P0** | Tooltip                 | `Tooltip.tsx:50-51,54`                      | rendering   | Bubble is inline `position:absolute`, never portaled → clipped by Modal/Drawer/Console scrollports. The seed defect.                                                                 | Migrate to Select portal+fixed+`getBoundingClientRect` pattern (S1).                    |
| P1     | FormField               | `FormField.tsx:55`                          | rendering   | Tooltip slot routes the seed clipping defect to the **entire field library**.                                                                                                        | Inherits S1 fix; no per-call change.                                                    |
| P1     | IoSchemaField           | `IoSchemaField.tsx:86`                      | rendering   | Bare `<Tooltip>` in section header inside resource Modal → clipped.                                                                                                                  | Inherits S1 fix.                                                                        |
| P1     | Tooltip                 | `Tooltip.tsx:51`                            | rendering   | Hard-anchored above (`bottom:calc(100%+--s-2)`), no flip → off-screen at viewport top.                                                                                               | Add top/bottom flip from rect after portaling (S1).                                     |
| P1     | Tooltip                 | `Tooltip.tsx:24-44` + `FormField.tsx:55`    | a11y        | Focusable `<button>` nested inside `<label>` — invalid/ambiguous interactive-in-label.                                                                                               | Make trigger `<span tabIndex=0 role="img" aria-label>` or render outside `<label>`.     |
| P1     | Select                  | `Select.tsx:73,76,80`                       | usability   | Capture-phase `scroll` listener **closes** popover; inner Modal/Drawer scroll dismisses it; position recomputes on resize only.                                                      | Reposition on scroll (re-run `place`) instead of closing.                               |
| P1     | ComboboxField           | `ComboboxField.tsx:82,85,89`                | usability   | Same scroll-closes defect as Select.                                                                                                                                                 | Mirror Select's fix to stay consistent.                                                 |
| P1     | ChipsField              | `ChipsField.tsx:83,122`                     | a11y        | Chip remove/add buttons ~22px hit target (`padding:3px 9px`, `--fs-caption`).                                                                                                        | Min ~44px hit area via `--s-*` on coarse pointers (S5).                                 |
| P1     | KeyValueEditor          | `KeyValueEditor.tsx:76-77`                  | ergonomics  | Index-keyed mutable rows → wrong values / stranded focus on remove.                                                                                                                  | Stable per-row id (S3).                                                                 |
| P1     | IoSchemaField           | `IoSchemaField.tsx:88`                      | ergonomics  | Index-keyed mutable field-row cards → same reconciliation/focus loss.                                                                                                                | Stable id via `emptyIoField()` (S3).                                                    |
| P1     | PricebookSpecForm       | `PricebookSpecForm.tsx:45,86`               | ergonomics  | Both dimensions and matrix lists index-keyed → wrong values / focus loss.                                                                                                            | Stable ids in `SpecFormState` (S3).                                                     |
| P1     | TextField               | `TextField.tsx:49-56`                       | rendering   | No `width:100%` → intrinsic-width input, narrower than siblings.                                                                                                                     | Add `width:100%` (S4).                                                                  |
| P1     | NumberField             | `NumberField.tsx:53-60`                     | rendering   | Same missing-width as TextField.                                                                                                                                                     | Add `width:100%` (S4).                                                                  |
| P1     | TextField/NumberField   | `TextField.tsx:47-49`, `NumberField.tsx:48` | consistency | On error sets only `aria-invalid`, no red border; JsonField paints one.                                                                                                              | On error override border to `var(--fail)` (S4).                                         |
| P1     | Toaster                 | `Toaster.tsx:45`                            | consistency | `zIndex:90` = popover layer, above modal backdrop (80) → toasts paint over modals.                                                                                                   | Dedicated z-slot above modals/popovers (S2).                                            |
| P1     | DataTable / ColumnsMenu | `DataTable.tsx:656,660-693`                 | a11y        | Trigger has no `aria-haspopup`/`aria-expanded`/`aria-controls`; portaled panel `id` unreferenced → AT never told menu exists/opens.                                                  | Add disclosure attrs (reuse Select trigger's).                                          |
| P2     | Tooltip                 | `Tooltip.tsx:21-22,28-29,67`                | ergonomics  | Hover/focus-only, bubble `pointerEvents:none`, no touch path → unreachable on touch.                                                                                                 | Tap-to-toggle + outside-tap dismiss (S5).                                               |
| P2     | Tooltip                 | `Tooltip.tsx:45-71`                         | rendering   | No horizontal clamp either (`left:50%`/`translateX(-50%)`) → edge overflow.                                                                                                          | Clamp horizontally during S1 migration.                                                 |
| P2     | Tooltip                 | `Tooltip.tsx:21-44`                         | a11y        | `cursor:help` button `padding:0` ~15px target, hover/focus-only.                                                                                                                     | ≥24px hit area + tap toggle (S5).                                                       |
| P2     | Toaster                 | `Toaster.tsx:12,16,22,40-54`                | usability   | Fixed 3500ms auto-dismiss, no pause-on-hover/focus, no stack cap.                                                                                                                    | Pause timer on pointer-enter/focus-within; cap visible stack.                           |
| P2     | Modal                   | `Modal.tsx:35,106`                          | a11y        | `aria-modal=true` but background not `inert`/`aria-hidden`; reachable by SR virtual cursor & mouse (same gap on Drawer `:113`).                                                      | Apply `inert` to app-root siblings while `open && mounted`.                             |
| P2     | Modal                   | `Modal.tsx:120-145`                         | ergonomics  | No visible close (X) button; Drawer ships one (`Drawer.tsx:130`).                                                                                                                    | Add header close `IconButton` mirroring Drawer.                                         |
| P2     | JsonField               | `JsonField.tsx:32-44`                       | consistency | Omits `hint`/`tooltip`/`required`; `label` non-optional → incomplete contract.                                                                                                       | Forward the three props to FormField (S4).                                              |
| P2     | DataTable / ColumnsMenu | `DataTable.tsx:638-640,656`                 | ergonomics  | Escape closes menu but no focus return to trigger; never focused on open → keyboard user stranded.                                                                                   | Capture trigger ref, `focus()` on Escape (mirror Select).                               |
| P2     | DataTable (mobile rows) | `DataTable.tsx:303-354`                     | a11y        | Clickable mobile card has no `minHeight`; short rows fall below 44px.                                                                                                                | Set `minHeight≥44px` on clickable region (S5).                                          |
| P2     | Checkbox                | `Checkbox.tsx:30-67`                        | a11y        | Icon-only checkbox ~18px (`padding:0`), below WCAG 2.5.8 24px.                                                                                                                       | ~24px hit area without enlarging 18px box (S5).                                         |
| P2     | Toggle                  | `Toggle.tsx:19-50`                          | a11y        | Label-less toggle 38×22, 22px under 24px min.                                                                                                                                        | ≥24px interactive area, keep 22px track (S5).                                           |
| P2     | IconButton              | `IconButton.tsx:40`                         | rendering   | `.ico-tip` inline `position:absolute`, no flip; uncliped only by rail-only usage.                                                                                                    | Document rail-only OR migrate to S1 primitive.                                          |
| P2     | IconButton              | `IconButton.tsx:40`                         | ergonomics  | `.ico-tip` hover/`focus-visible`-only; no `title` (RowAction has one).                                                                                                               | Add `title={label}` to match RowAction (S5).                                            |
| P2     | Button                  | `Button.tsx:65-78`                          | usability   | `to`/`href` branches ignore `disabled`/`loading` → fully interactive un-styled link.                                                                                                 | Honor on link branches OR narrow the type.                                              |
| P2     | Button                  | `Button.tsx:9-11,19,20`                     | consistency | `fontWeight:650` (undefined), `gap:8` raw, off-grid paddings.                                                                                                                        | Map to `--fw-*`/`--s-*`.                                                                |
| P2     | RowAction               | `glass.css:140-142`                         | a11y        | 30×30 destructive target, dense rows → mis-tap.                                                                                                                                      | Hit-slop to ≥44px without growing box (S5); else document tradeoff.                     |
| P2     | CopyField               | `CopyField.tsx:15-21`                       | usability   | `await writeText` no try/catch, called via `void copy()` → silent failure on insecure origin / denied permission.                                                                    | try/catch + surface error (toast/failed label).                                         |
| P2     | CopyField               | `CopyField.tsx:18-21`                       | rendering   | 2000ms reset `setTimeout` never cleared → setState on unmounted component.                                                                                                           | Store id in ref, clear on unmount/re-arm.                                               |
| P2     | CopyField               | `CopyField.tsx:14-39`                       | a11y        | No `aria-live` on copied state → SR users get no announcement.                                                                                                                       | Add visually-hidden `aria-live=polite` status.                                          |
| P2     | CopyField               | `CopyField.tsx:29`                          | consistency | `padding:8px 10px` — 10px off the 8px grid.                                                                                                                                          | Use `--s-*` tokens.                                                                     |
| P2     | EntityCard              | `EntityCard.tsx:48-54,98-100`               | a11y        | `role="button"` card renders interactive `actions` descendants, no `stopPropagation` → invalid ARIA + double-activation (latent; `actions` not passed at any of 5 call sites today). | Don't promote to button when `actions` present, or guard with DataTable's stop/stopKey. |
| P2     | StatusBadge / MockBadge | `StatusBadge.tsx:38`, `MockBadge.tsx:21`    | aesthetics  | `fontWeight:600` literal == `--fw-medium`.                                                                                                                                           | Replace with `var(--fw-medium)`.                                                        |
| P2     | StatusBadge / MockBadge | `StatusBadge.tsx:39`, `MockBadge.tsx:20`    | aesthetics  | `padding:3px 9px` off-grid (chip is `2px 9px`).                                                                                                                                      | Tokenize or document the pill micro-padding.                                            |
| P2     | ProviderIcon            | `ProviderIcon.tsx:110,112`                  | consistency | `gap:10` (off-grid) and `fontWeight:500` (no matching `--fw-*`); brand-plate hex is intentional.                                                                                     | Tokenize gap/weight (note: not a lossless swap); keep plate hex.                        |
| P2     | SectionHeader           | `SectionHeader.tsx:6`                       | consistency | `fontWeight:700` + `letterSpacing:-0.01em` (no token) literals; `whiteSpace:nowrap` with no `min-width:0`/ellipsis → long titles push action off-row.                                | Use `--fw-semibold`/nearest `--track-*`; add `min-width:0`+ellipsis.                    |
| P2     | Rail                    | `Rail.tsx:12,70`                            | consistency | `EASE` literal == `--ease-out`; `0.32s` off-token duration.                                                                                                                          | Reference `var(--ease-out)` + `var(--dur-*)`.                                           |
| P2     | SubNav                  | `SubNav.tsx:8,37`                           | consistency | `EASE` literal == `--ease-out`; `0.26s` == `--dur-base`, both inlined.                                                                                                               | Use `var(--dur-base) var(--ease-out)`.                                                  |
| P2     | SubNav                  | `SubNav.tsx:15,56`                          | a11y        | Active state computed via `pathname.startsWith` (`activeIdx`) separate from NavLink's own `aria-current` → can disagree on prefix/overlap routes.                                    | Drive color + indicator from NavLink `isActive` render-prop.                            |
| P2     | Rail (`.ico-tip`)       | `Rail.tsx`, `glass.css:101-118`             | rendering   | Non-portaled tooltips at `z-index:60` (below overlay 80); no clip ancestor today but same seed class.                                                                                | Note as house behavior; migrate via S1 if rail gains overflow ancestor.                 |
| P2     | BottomTabs              | `BottomTabs.tsx:35,37`                      | ergonomics  | `gap:3`/`padding:6px 12px` off-grid; effective height ~44px floor, no `min-height`.                                                                                                  | `--s-*` tokens + `min-height≥44px`.                                                     |
| P2     | AppBackground           | `AppBackground.tsx:10-11,33-59`             | motion      | Docstring claims pointer parallax "stays on" under reduced-motion, but the whole branch is inside `no-preference` → parallax is off (impl correct, doc wrong).                       | Fix the docstring (or move only the listener out if persistence intended).              |

---

## 3. PER-LENS ROLLUP (where the library is weakest)

**好用 / Usability** — Select & Combobox scroll-closes-popover inside modals (`Select.tsx:76`, `ComboboxField.tsx:85`); Toaster auto-dismiss with no pause / unbounded stack (`Toaster.tsx:12,40-54`); CopyField silent failure on copy (`CopyField.tsx:15-21`); Button link branches ignore disabled/loading (`Button.tsx:65-78`).

**好看 / Aesthetics & consistency** — Heaviest count, all P2 token drift: Button (`:9-11,19,20`), SectionHeader (`:6`), Rail (`:12,70`), SubNav (`:8,37`), StatusBadge/MockBadge, ProviderIcon, ComboboxField padding (`:177`), CopyField padding (`:29`). All resolve by replacing literals with `--s-*`/`--fw-*`/`--track-*`/`--ease-*`/`--dur-*` tokens — and by **S2** for z-index.

**动效 / Motion** — Smallest lens, which is a good sign: only `AppBackground.tsx:10-11` (doc/impl mismatch, no functional bug). No unguarded GSAP tween was found; reduced-motion gating holds (see §4). SubNav/Rail motion issues are token-naming, not behavior.

**渲染 / Rendering** — The deepest weakness, all rooted in **S1**: Tooltip seed clip + no flip/clamp (`Tooltip.tsx:50-71`), FormField propagation (`:55`), IoSchemaField (`:86`), IconButton `.ico-tip` (`:40`), Rail `.ico-tip`. Plus field-width drift (TextField/NumberField, **S4**) and CopyField stale timer (`:18-21`).

**操作 / Ergonomics & interaction** — Index-keyed row editors lose focus/values (**S3**: KeyValueEditor, IoSchemaField, PricebookSpecForm); ColumnsMenu strands keyboard focus on Escape (`DataTable.tsx:638-640`); Modal has no visible close (`:120-145`); Tooltip/IconButton no touch reveal.

**a11y** (cross-cutting) — Largest lens. Disclosure gap on ColumnsMenu trigger (`DataTable.tsx:656`); background not inert under `aria-modal` (`Modal.tsx`/`Drawer.tsx`, **S2-adjacent**); interactive-in-`<label>` Tooltip (`:24-44`); EntityCard button-with-interactive-descendants (latent); CopyField no `aria-live`; SubNav dual active-state source; and the touch-target cluster (**S5**: ChipsField, Checkbox, Toggle, RowAction, mobile rows, BottomTabs, Tooltip trigger).

**Weakest areas overall:** rendering (S1) and a11y (S5 + disclosure/inert gaps). **Strongest:** motion.

---

## 4. WHAT'S ALREADY GOOD — preserve these (don't let fixes regress them)

- **Portal dropdown pattern (the reference to copy, not replace).** `Select.tsx` / `ComboboxField` portal to `document.body` (`Select.tsx:183,240`), `position:fixed` from `getBoundingClientRect()` (`:64-67`), correct ARIA listbox (`aria-haspopup`/`aria-expanded`/`aria-controls`/`aria-activedescendant`, `:151-154`), focus stays on trigger with `btnRef.focus()` on commit (`:59`). This is the model for S1 — extend it, don't rewrite it. (Its scroll-closes behavior is the one weakness to upgrade, per the P1 row.)
- **GSAP reduced-motion gating.** Per-component inline `matchMedia('(prefers-reduced-motion: reduce)')` in Modal (`:55`) and Drawer (`:64`) sets final state / immediate unmount under reduce; AppBackground correctly gates its whole parallax branch on `no-preference`. The global CSS net (`theme.css:148-159`) covers all CSS transitions. No unguarded GSAP tween was found — keep this discipline on any new animation.
- **Focus trap + restore.** `useFocusTrap` (`lib/useFocusTrap.ts`) traps Tab in JS, sets initial focus, and restores to the opener on cleanup; Modal/Drawer gate it on `open && mounted` so focus restores during the exit tween. Preserve the gating. (The only gap is background `inert` — additive, per §2.)
- **Warm-never-blue palette discipline.** Accent `#ffd60a`, warm focus ring (`outline:2px solid var(--accent)`), near-opaque `--overlay-bg` on floating panels, `Select` existing specifically to avoid native blue. No blue/cool/native-focus violation was found — keep this hard rule when adding the `Floating` primitive and `--z-*` tokens.
- **Deferred-unmount lifecycle** for overlay enter/exit, and **CopyField/RowAction's `title` affordance** (the pattern IconButton should copy, not abandon).

---

## 5. SUGGESTED FIX SEQUENCE (build shared infra first; analysis only — no code changed)

Order matters: each step makes later per-component fixes trivial.

1. **`--z-*` token scale in `theme.css` (S2).** Smallest, zero-risk, unblocks the Toaster collision and gives the `Floating` primitive a token to consume. Do this first so step 2 doesn't hardcode another literal.
2. **Shared `Floating` / `usePortalRect` primitive (S1)** — extract the Select portal+fixed+`getBoundingClientRect` logic, add top/bottom flip + horizontal clamp + reposition-on-scroll + a tap-to-toggle touch path. This is the highest-leverage build: it resolves the P0 plus Tooltip flip/clamp/touch, FormField/IoSchemaField propagation, IconButton/Rail `.ico-tip`, and the Select/Combobox scroll-closes P1s in one place.
3. **Migrate Tooltip and `.ico-tip` onto the primitive, and fix Select/Combobox scroll handling.** Mostly deletion of inline-absolute code; FormField and the whole field library inherit the clip fix for free.
4. **Stable-id row-key convention (S3)** — add ids in `kvRows.ts`, `emptyIoField()`, `SpecFormState`; re-key the three editors. Independent of 1-3, parallelizable.
5. **Field-contract helper (S4)** — standardize `width:100%`, `error → var(--fail)` border, and the `hint`/`tooltip`/`required` prop surface across Text/Number/Json. Step 2 must land first so the tooltip slot is already portal-correct.
6. **`--min-touch` token + icon-hit-slop utility (S5)** — apply across ChipsField, Checkbox, Toggle, RowAction, mobile rows, BottomTabs, Tooltip/IconButton triggers; add `title={label}` to IconButton. The touch-reveal path piggybacks on step 2's primitive.
7. **Sweep the remaining isolated P2s** — Modal close button + background `inert`; ColumnsMenu disclosure attrs + focus return; CopyField try/catch + timer cleanup + `aria-live`; EntityCard role guard; SubNav single active source; and the token-literal cleanups (Button/SectionHeader/Rail/SubNav/badges/ProviderIcon/AppBackground docstring), which become mechanical once `--z-*`/`--fw-*`/`--s-*`/`--ease-*`/`--dur-*` are the established path.

**Net:** building **two tokens (`--z-*`, `--min-touch`) + two primitives (`Floating`, field-contract helper) + one convention (stable row keys)** retires the P0, every rendering/S1 P1, and the bulk of the a11y and consistency P2s. The remaining work is a mechanical sweep.

---

## Appendix A — House Patterns Reference

# Actionow Web — House Patterns Reference

The established-correct conventions of the shared component infrastructure. Auditors hold every component against these; documented deviations are findings. All file paths absolute under `/Users/alienworm/actionow-web/apps/web/src`.

---

## 1. Overlay / Floating Pattern

Two distinct families. **Modal/Drawer are full-screen modal surfaces**; **Select/Combobox/menus are anchored popovers**. They portal the same way but position and dismiss differently.

### 1a. Anchored popover — CANONICAL: `components/ui/Select.tsx`

This is the reference every dropdown/menu/tooltip-bubble must match.

- **Portal:** `createPortal(<menu/>, document.body)` (Select.tsx:183, 240). Escapes ancestor `overflow:auto/hidden/clip` and stacking contexts. The trigger `<button>` stays in place; only the floating panel is portaled.
- **Position:** `position: 'fixed'` with coords from the trigger's `getBoundingClientRect()` (Select.tsx:64–67):
  ```
  const r = btnRef.current?.getBoundingClientRect();
  if (r) setRect({ left: r.left, top: r.bottom + 4, width: r.width });
  ```
  Panel renders `left: rect.left, top: rect.top, width: rect.width` (Select.tsx:191–193). The `+4` is the trigger↔menu gap.
- **z-index:** `90` (Select.tsx:194). Same as Combobox, DataTable column-menu, Toaster.
- **Dismiss — three listeners, attached only while `open` (Select.tsx:62–82):**
  - **Outside-click:** `document.addEventListener('mousedown', onDown)` — closes unless target is inside trigger OR menu (`btnRef.current?.contains(t) !== true && menuRef.current?.contains(t) !== true`).
  - **Escape:** handled in `onKeyDown` on the trigger (Select.tsx:129–132), not a document listener.
  - **Resize:** `window.addEventListener('resize', place)` — REPOSITIONS (re-runs `place`).
  - **Scroll:** `window.addEventListener('scroll', close, true)` — CAPTURE-PHASE, and **closes** (not repositions). All three removed in cleanup.
- **Focus:** focus **stays on the trigger** the whole time (Select.tsx docstring lines 16–20). The active option is tracked via `aria-activedescendant` (line 154), options have `tabIndex={-1}` (line 213). On commit, `btnRef.current?.focus()` (line 59). This is the correct ARIA listbox/combobox pattern — NOT a focus trap.

**Known weaknesses baked into this canonical (these are house behavior, not per-component findings):** scroll _closes_ rather than repositions (so an inner-scroll inside a modal kills the dropdown), and repositioning happens on resize only — never on scroll. Any new popover should at minimum match this; matching only _resize_ repositioning is the current bar.

### 1b. Modal surface — CANONICAL: `components/ui/Modal.tsx` + `components/ui/Drawer.tsx`

- **Portal:** `createPortal(<backdrop/>, document.body)` (Modal.tsx:148, Drawer.tsx:158).
- **Backdrop:** `position:'fixed'`, `inset:0`, `zIndex:80`, `background:'var(--scrim)'` (Modal.tsx:93–96, Drawer.tsx:103–105). Modal centers (`alignItems/justifyContent:center`, `padding:var(--s-4)`); Drawer pins right (`justifyContent:'flex-end'`).
- **Panel:** `role="dialog"`, `aria-modal="true"`, `aria-label={title}`, `className="glass"`, `background:'var(--overlay-bg)'` (near-opaque, deliberately overrides the glass bg so form text stays legible). Modal `borderRadius:var(--r-lg)`, `padding:var(--s-5)`, `width:min(440px,92vw)`, `maxHeight:min(86dvh,720px)`. Drawer `borderRadius:0`, `height:100dvh`, `width` prop default `min(480px,96vw)`.
- **Dismiss:**
  - **Backdrop click:** backdrop `onClick={onClose}` (`role="presentation"`); panel `onClick={(e)=>e.stopPropagation()}` so inner clicks don't bubble (Modal.tsx:91/108, Drawer.tsx:100/115).
  - **Escape:** `document.addEventListener('keydown', …)` checking `e.key==='Escape'`, attached only while `open` (Modal.tsx:41–48, Drawer.tsx:50–57).
  - No scroll/resize dismiss (it's a full-screen surface).
- **Focus:** `useFocusTrap(dialogRef, open && mounted)` (Modal.tsx:35, Drawer.tsx:44). Gated on `open && mounted` so the trap releases the instant a close is requested (during the exit tween), letting focus restore to the trigger before unmount.
- **Lifecycle:** deferred-unmount. `mounted` stays true through the exit tween; only set false in the GSAP `onComplete` (guarded by `openRef.current` against rapid close→reopen). Reduced-motion sets `mounted=false` immediately (Modal.tsx:69–72, Drawer.tsx:78–81).
- **Scrollport gotcha:** the content region is `overflowY:'auto'` (Modal.tsx:134, Drawer.tsx:144) — **this is a confirmed clipping ancestor.** It uses `marginInline:calc(-1*var(--s-2))` + `paddingInline:var(--s-2)` so a focused input's outline ring isn't clipped (Modal.tsx:122–130, Drawer.tsx:132–138). It does NOT solve clipping for inline-positioned popovers/tooltips inside it.

### Canonical quote (Select.tsx docstring, lines 11–20)

> _"System-styled select: a glass trigger + a portaled warm popover (never the native OS dropdown, which renders a blue selection off-palette and is clipped inside scrollable modals). Portaled + fixed-positioned so it escapes modal overflow. Closes on outside-click, Escape, or scroll."_

---

## 2. Focus Management — what `useFocusTrap` ACTUALLY does

`lib/useFocusTrap.ts`. Signature `useFocusTrap(ref, active)`. Precise behavior (this determines real a11y findings):

- **Traps Tab — YES, in JS, not via `inert`.** A capture-phase `document.addEventListener('keydown', onKeyDown, true)` (line 57) intercepts `Tab`/`Shift+Tab` and wraps focus: at last element (or focus escaped the container) Tab→first; at first, Shift+Tab→last (lines 36–55). If there are zero focusables it `preventDefault`s Tab entirely (lines 39–42).
- **Initial focus — YES.** On activate, focuses the first focusable inside the container; if none, sets `tabindex=-1` on the container and focuses it (lines 28–34).
- **Restore focus to opener — YES.** Captures `document.activeElement` at activation (line 26) and on cleanup calls `previouslyFocused.focus()` (lines 60–62). So Modal/Drawer **do** return focus to the trigger on close. (Restore fires on the effect-cleanup, which runs when `active`→false OR unmount.)
- **Background inert / `aria-hidden` — NO. This is the key gap.** The trap does NOT set `inert` or `aria-hidden="true"` on the rest of the document. Background content is still in the a11y tree and reachable by screen-reader virtual cursor and by mouse; only _keyboard Tab_ is corralled. Any finding claiming "background is inert when a modal is open" is FALSE — flag the absence as the real limitation.
- **Focusable selector** (line 4–5): `a[href]`, non-disabled `button/textarea/input/select`, `[tabindex]:not([tabindex="-1"])`; filters out `hidden` and `aria-hidden="true"`. Recomputed live on each Tab (line 38), so dynamically-added controls are included.

Docstring (lines 13–18) states it is "reusable by future Drawer/ConfirmDialog" — Drawer already consumes it. New modal-like surfaces must use it, gated `open && mounted`.

---

## 3. Motion Conventions

### Tokens — `lib/motion/tokens.ts` (JS, for GSAP) mirror `--dur-*` / `--ease-*` in `theme.css`

| Token   | `DUR` (s, tokens.ts) | CSS `--dur-*` (theme.css:19) |
| ------- | -------------------- | ---------------------------- |
| instant | 0.12                 | 0.12s                        |
| fast    | 0.18                 | 0.18s                        |
| base    | 0.26                 | 0.26s                        |
| slow    | 0.42                 | 0.42s                        |
| slower  | 0.7                  | 0.7s                         |

`EASE` (tokens.ts:11–16): `out:'power3.out'`, `in:'power2.in'`, `inOut:'power2.inOut'`, `spring:'elastic.out(1, 0.45)'`. CSS pairs (theme.css:20–21): `--ease-out: cubic-bezier(0.2,0.8,0.2,1)`, `--ease-in: cubic-bezier(0.4,0,1,1)`. (Note: CSS only ships `--ease-out`/`--ease-in`; no CSS var for inOut/spring.)

GSAP defaults (`lib/motion/gsap.ts:8`): `gsap.defaults({ ease: EASE.out, duration: DUR.slow })`. ScrollTrigger + useGSAP registered there; **all GSAP must be imported from `lib/motion/gsap`**, not raw `gsap`.

**Enter/exit pattern (Modal/Drawer):** enter uses `DUR.base`+`EASE.out`; exit uses `DUR.fast`+`EASE.in`. Modal: dialog `opacity 0→1, scale 0.96→1, y 8→0` (Modal.tsx:63–64). Drawer: panel `opacity 0→1, x 40→0` (Drawer.tsx:72–73).

### Reduced-motion gating — TWO mechanisms; know which applies

1. **GSAP (JS animation) — per-component `matchMedia` check. THIS IS THE REFERENCE.** Modal.tsx:55 and Drawer.tsx:64:

   ```
   const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
   ```

   When `reduced`: on open, `gsap.set` to final state (no tween); on close, `setMounted(false)` immediately (Modal.tsx:57–72, Drawer.tsx:66–81). **Any GSAP animation MUST do this branch itself** — the CSS safety net does NOT touch GSAP (it animates inline styles via JS, bypassing CSS transition rules). A GSAP tween without a `matchMedia` guard is a finding.
   - There is also a hook `useReducedMotion()` (`lib/motion/useReducedMotion.ts`) returning a reactive boolean off the same query — available but Modal/Drawer use the inline `matchMedia` form instead.

2. **CSS transitions/animations — global safety net.** `theme.css:148–159`:
   ```
   @media (prefers-reduced-motion: reduce) {
     *, *::before, *::after {
       animation-duration: 0.01ms !important;
       animation-iteration-count: 1 !important;
       transition-duration: 0.01ms !important;
       scroll-behavior: auto !important;
     }
   }
   ```
   Covers **every CSS `transition` and `@keyframes` animation and smooth-scroll** globally. So inline-style CSS transitions (e.g. `Button` line 25, `Select` CaretDown `transition:'transform 0.2s ease'` line 178, Tooltip's opacity transition) ARE neutralized by this net even though they're not individually gated — they are NOT findings on reduced-motion grounds. The comment is explicit: _"GSAP is handled per-component via matchMedia."_ The line that matters for findings: **CSS transition → covered by the net; JS/GSAP tween → must self-gate.**
   - Smooth scroll opt-in: `@media (prefers-reduced-motion: no-preference){ html{scroll-behavior:smooth} }` (theme.css:145–147).
   - `glass.css` also adds targeted `prefers-reduced-motion: reduce` blocks (logo-marquee:242–246, ico-tip/refresh-spin:251–254, entity-card hover:170–172) and a `prefers-reduced-transparency: reduce` block (285–289) dropping backdrop-filter.

---

## 4. Z-index Reality — ad-hoc scale, NO token

There is **no z-index token in `theme.css`** (confirmed — `theme.css` defines spacing/radius/type/motion/color tokens but zero `--z-*`). Every layer is a raw magic number. Full scale (SEED + confirmed in source):

| z      | Layer                                                                                           |
| ------ | ----------------------------------------------------------------------------------------------- |
| 0      | AppBackground / `.bg-grid` (glass.css:261) / ConsoleLayout content base                         |
| 1      | ConsoleLayout content, SubNav, SegmentedControl thumb, SpotlightCard, `.ico-btn` (glass.css:83) |
| 2–3    | DataTable sticky header                                                                         |
| 30     | BottomTabs                                                                                      |
| 40     | landing Nav (sticky)                                                                            |
| 60     | `.ico-tip` rail tooltip (glass.css:118)                                                         |
| **80** | **Modal / Drawer backdrop** (Modal.tsx:95, Drawer.tsx:104)                                      |
| **90** | **Select / Combobox / DataTable column-menu / Toaster** (Select.tsx:194)                        |
| 95     | **Tooltip bubble** (Tooltip.tsx:53)                                                             |

Consequences that are house reality (not per-component bugs to "fix" blindly, but the constraint auditors reason against): a popover (90) correctly sits above a modal backdrop (80) so a Select inside a Modal shows through; **Toaster shares 90 with dropdowns and thus renders above a modal backdrop (80)** — toasts paint over open modals. Tooltip at 95 is the highest. Because the value is a bare literal everywhere, there is no single source of truth — any new floating element must hand-pick a number consistent with this ladder.

---

## 5. Field Contract — `components/ui/FormField.tsx`

The shared shell every field (`TextField`, `NumberField`, `SelectField`, `JsonField`, etc.) must compose so label/error/hint are written exactly once.

**Props (FormField.tsx:22–39):**

- `id: string` (required) — wired to `<label htmlFor={id}>` (line 44). The control inside must carry this same `id`.
- `label?: string` — only renders the `<label>` when defined (line 42).
- `error?: string` — error line in `var(--fail)`, `--fs-caption`.
- `hint?: string` — hint line in `var(--faint)`, `--fs-caption`. **Error wins over hint** (ternary, lines 59–63: error → else hint → else nothing). Exactly one line beneath, or none.
- `required?: boolean` — appends ` *` span in `var(--fail)` after the label (line 54).
- `tooltip?: string` — when set, renders `<Tooltip text={tooltip} />` inline next to the label text (line 55). This is the integration point for the (currently inline-positioned) Tooltip.
- `children: ReactNode` — the control, rendered between label and error/hint.

**Layout:** `display:flex; flexDirection:column; gap:6` wrapper; label is `inline-flex`, `gap:var(--s-1)`, `--fs-sm`, `color:var(--muted)`.

**ID helper `useFieldId(explicit?)` (FormField.tsx:10–13):** returns `explicit ?? \`ff-${useId()}\``. Fields call this to get a stable id, pass it to both `FormField id=` and the control. **No error-state styling is applied to the control by FormField** — it only renders the error _text_; the control's own error border/ring (if any) is the field component's responsibility. A field that renders its own label/hint instead of composing FormField, or that doesn't share one id between label and control, is a finding.

---

## 6. Theme / Palette Tokens — `styles/theme.css`

Dark is default (`:root`, `color-scheme: dark`); `[data-theme='light']` overrides. **Warm-never-blue is a hard rule.** Use tokens, never raw hex/blue.

**Spacing `--s-*` (8px grid, theme.css:8):** `--s-1:4 --s-2:8 --s-3:12 --s-4:16 --s-5:20 --s-6:24 --s-8:32 --s-10:40 --s-16:64` (px). Padding/gap must use these, not literals.

**Radius `--r-*` (theme.css:10–11):** `--r-xs:8 --r-sm:11 --r-md:14 --r-lg:18 --r-pill:999`. (Cards `--r-md`, modals `--r-lg`, inputs/menus `--r-sm`, buttons `--r-pill`.)

**Font-size `--fs-*` (theme.css:13–16):** `--fs-nano:9 --fs-micro:10 --fs-caption:11 --fs-sm:13 --fs-base:15 --fs-md:16 --fs-lg:18 --fs-xl:24 --fs-2xl:30`; fluid `--fs-h2 / --fs-h1 / --fs-display` via `clamp()`. Weights `--fw-medium:600 --fw-semibold:700 --fw-bold:800`. Tracking `--track-tight:-0.03em --track-snug:-0.015em`.

**Color tokens:**

- Brand accent (constant across themes, theme.css:3–5): `--accent:#ffd60a` (warm yellow), `--accent-2:#ff9f0a` (amber), `--ink:#1c1500` (near-black on accent), `--grad-accent: linear-gradient(135deg, accent, accent-2)`.
- Text: `--text`, `--muted`, `--faint` (descending emphasis).
- Status: `--ok` / `--run` / `--wait` / `--fail` / `--idle` / `--log-ok` — all warm or warm-tinted; `--fail` is the red (`#f87171` dark / `#dc2626` light). Used for errors (FormField), danger Button.
- Surfaces: `--bg`, `--glass-bg`/`--glass-bd`/`--glass-hl`/`--glass-shadow` (drive `.glass`), `--panel-bg`/`--panel-bd` (drive `.panel`), `--nav-bg`.
- Interaction: `--hover-bg` (warm `rgba(255,214,10,.08)`), `--hover-bd` (warm border), `--spot`, `--shadow-cta`/`-hover`, `--glow-accent*`, `--shadow-accent-*`, `--shadow-lift`.

**Overlay-specific tokens (the load-bearing ones for floating UI):**

- `--overlay-bg`: `rgba(28,25,19,0.97)` dark / `rgba(252,250,245,0.98)` light (theme.css:54, 87). **Near-opaque** — every floating panel (Modal/Drawer panel, Select/Combobox menu, Tooltip bubble) overrides its glass/panel bg with this so text stays legible over arbitrary content.
- `--scrim`: `rgba(0,0,0,0.45)` dark / `rgba(40,30,5,0.32)` light (theme.css:36, 111) — the modal/drawer backdrop.
- `--panel-bd`: `rgba(255,255,255,0.08)` dark / `rgba(0,0,0,0.06)` light (theme.css:55, 88) — overlay/panel borders.

**Warm-never-blue enforcement points:** focus ring is `outline: 2px solid var(--accent)` (theme.css:130–134, overrides browser blue); tap-highlight `rgba(255,214,10,.2)` (line 136); `::selection` warm (line 137). Select.tsx exists specifically to avoid the native OS dropdown's blue selection. Any blue/cool color, native focus-blue, or off-palette hex is a finding.

**Glass utilities (`styles/glass.css`):** `.glass` (heavy blur 22px + saturate, glass-bg/bd/hl/shadow), `.panel` (lighter blur 10px, panel-bg/bd), `.glass-hover` (warm-tint lift), `.btn-tactile` (push feedback). `prefers-reduced-transparency: reduce` drops `backdrop-filter` to solid `--panel-bg` (glass.css:285–289). Floating panels use `className="glass"` but override `background:var(--overlay-bg)` to defeat see-through.

---

## Quick auditor checklist (derived)

- Floating non-modal element NOT portaled to `document.body` with `position:fixed` from `getBoundingClientRect()` → **finding** (e.g. **Tooltip.tsx renders an inline `position:absolute` bubble, zIndex 95, never portaled — clipped by Modal/Drawer `overflowY:auto` scrollports** at Modal.tsx:134 / Drawer.tsx:144 and any `overflow` ancestor).
- Floating element with no collision/flip that can overflow the viewport (Tooltip's `bottom:calc(100%+--s-2)` is always-above) → finding.
- GSAP tween without an inline `matchMedia('(prefers-reduced-motion: reduce)')` guard → finding. (Pure CSS transitions are covered by the global net — NOT a finding.)
- Modal-like surface not using `useFocusTrap(ref, open && mounted)`, or not restoring focus to the trigger → finding. Claiming background is `inert`/`aria-hidden` when a modal is open → it ISN'T (real limitation to note).
- Hardcoded spacing/radius/font-size/color instead of `--s-*`/`--r-*`/`--fs-*`/color tokens, or any blue/cool/native-blue → finding.
- Field component not composing FormField (duplicating label/error/hint) or not sharing one id between label and control → finding.
- Interactive element nested inside another interactive element (Tooltip wraps trigger in a `<button cursor:help>` — risky inside a `<label>` or alongside other controls; no touch/hover affordance) → finding.
