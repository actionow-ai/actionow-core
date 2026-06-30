# Phase 1 — 设计系统地基:液态玻璃材质 + token 收紧

**Date:** 2026-06-30
**Status:** Design approved, pending spec review
**Scope:** `apps/web` (frontend only). First of a 5-phase frontend-quality program.

---

## 1. Background & motivation

A 12-agent per-page design audit of `apps/web` (2026-06-30) graded the frontend **B+ (8/10)**: a
mature, token-driven, accessible system held back not by structural faults but by _systemic polish
gaps_. Two of the audit's findings motivate this phase directly:

- **Systemic theme #1 — inline-style objects vs CSS-class primitives.** The token system is
  excellent but only _partially load-bearing_: wherever a surface uses per-component inline style
  objects instead of the `.btn`/`.field`/`.chip` classes, raw pixel values, off-scale font-weights
  (`780/760/680` with no token), and hardcoded radii leak past the token layer. The fix is to treat
  the CSS-class layer as the enforcement layer and add the missing token rungs.
- **Consistency violation — material hierarchy inverted.** The dense ops console (`/console`) uses
  the richer `.glass` (blur 22) while the tenant `/app` — which is _meant_ to be the airier product
  surface — uses the flatter `.panel` (blur 10). The hero balance figure on `AppOverview` sits on the
  lower-tier material.

This phase also fulfils a standing product wish: an Apple-style **"liquid glass"** material. Research
(see the liquid-glass evaluation, same session) concluded that the popular `rdev/liquid-glass-react`
library is the wrong vehicle — its marquee refraction effect is Chromium-only and degrades to plain
blur in Safari/Firefox, it is a single-component wrapper at odds with this app's token/class
architecture, and the app already has a mature glass layer (`styles/glass.css`). The right move is to
add a richer **cross-browser CSS** material tier built on the existing glass tokens.

### The 5-phase program (context only — only Phase 1 is in scope here)

1. **设计系统地基:tokens + 液态玻璃材质** ← _this spec_
2. 共享原子抽取(去重):`SecretRevealModal`, `CopyButton`, `AdminOnlyNote(banner|page)`, hoisted `useDebounced`, shared `Panel`/`MetaCell`.
3. 正确性 + 一致性收敛:apply-on-change mutation safety + detail/`DateField` standardization.
4. 响应式 + 无障碍:tablet chrome tier + detail max-width + status de-color-dependence.
5. 次要面打磨:`PlaygroundComingSoon`, `AppMedia`, Dify result screen, in-form section grouping.

Each subsequent phase gets its own spec → plan → implementation cycle.

---

## 2. Goals / non-goals

### Goals

- Introduce an **opt-in** liquid-glass material tier (`.liquid-glass`, `.liquid-glass--subtle`)
  built on existing glass tokens, cross-browser (Chrome/Safari/Firefox identical), with an
  accessibility fallback.
- Apply it **broadly but safely**: chrome, floating overlays, `/app` showcase, landing accents,
  and entity cards — fixing the `/app` material-hierarchy inversion.
- **Exhaustively** tighten the token layer so the new material (and existing primitives) reference
  tokens instead of leaking literals: `--control-h`, `--fw-heading`, `--s-0`/`--s-1h`, and a sweep
  of scattered hardcoded sub-token values.
- **Zero visible regressions** and a green test suite.

### Non-goals (explicitly deferred)

- Real refraction / SVG displacement maps (Chromium-only, GPU-heavy) — a possible later experiment.
- Any change to dense `DataTable` row backgrounds (they stay solid for readability).
- Phases 2–5.
- Light/dark _behavior_ changes beyond what the material needs (the theme system stays as-is).

---

## 3. Locked design decisions

| #   | Decision                         | Choice                                                                                                             |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| D1  | New material vs upgrade `.glass` | **New independent opt-in tier**; `.glass`/`.panel` untouched.                                                      |
| D2  | Application breadth              | **Broad**: chrome + floating + `/app` showcase + entity cards (subtle) + landing accents. Dense tables stay solid. |
| D3  | Refraction                       | **Pure CSS, cross-browser.** No displacement.                                                                      |
| D4  | Token sweep depth                | **Exhaustive** sweep of hardcoded literals, with the rounding rule in §6.                                          |

---

## 4. New tokens (`apps/web/src/styles/theme.css`)

Added to `:root` (dark default), with `[data-theme='light']` overrides where the value must differ.

```css
/* control sizing */
--control-h: 40px; /* canonical interactive control height (matches today's .btn/.ico-btn) */

/* type */
--fw-heading: 780; /* editorial section-heading weight; tokenizes landing's raw 780 */

/* micro-spacing the 8px scale was missing */
--s-0: 2px;
--s-1h: 6px;

/* liquid-glass backdrop recipes (per-theme so light mode does not over-brighten) */
--lg-backdrop: blur(28px) saturate(190%) brightness(1.06); /* dark: full tier */
--lg-backdrop-subtle: saturate(150%) brightness(1.03); /* no blur — high-count surfaces (§5 D2) */
```

`[data-theme='light']` overrides:

```css
--lg-backdrop: blur(28px) saturate(150%) brightness(1.02);
--lg-backdrop-subtle: saturate(135%) brightness(1.01);
```

Rationale: light mode's `--glass-bg` is already much more opaque (0.55 vs 0.06 alpha), so it needs
less saturate/brightness to avoid a washed-out look. All _color_ comes from existing tokens
(`--glass-bg`, `--glass-bd`, `--glass-hl`, `--glass-shadow`, `--panel-bg`, `--shadow-lift`) so the
material tracks the theme automatically.

---

## 5. Material classes (`apps/web/src/styles/glass.css`)

```css
/* Liquid glass — richer opt-in tier for chrome / floating / showcase surfaces.
   Sheen is baked into the background gradient (not a ::before) so the class stays composable. */
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
    /* specular top edge */ inset 0 -1px 0 color-mix(in srgb, var(--glass-hl) 30%, transparent),
    /* faint counter-edge */ var(--glass-shadow);
}

/* Subtle tier — for high-count surfaces (entity-card grids). Keeps the glass LOOK
   (gradient sheen + specular edge + saturate) but DROPS backdrop blur, so a grid of
   dozens of cards does not stack dozens of GPU blur layers (audit: ~3-4 blur layers
   per viewport is the safe ceiling). */
.liquid-glass--subtle {
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--glass-hl) 18%, var(--panel-bg)),
    var(--panel-bg) 50%
  );
  backdrop-filter: var(--lg-backdrop-subtle); /* saturate/brightness only, no blur */
  -webkit-backdrop-filter: var(--lg-backdrop-subtle);
  box-shadow:
    inset 0 1px 0 var(--glass-hl),
    var(--shadow-lift);
}
```

### Accessibility fallback

Extend the existing `@media (prefers-reduced-transparency: reduce)` block (currently covering
`.glass`/`.panel`) to flatten both new classes to a solid surface with no `backdrop-filter`:

```css
@media (prefers-reduced-transparency: reduce) {
  .liquid-glass,
  .liquid-glass--subtle {
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    background: var(--panel-bg);
  }
}
```

The material itself has no animation; hover lift continues to come from the existing `.glass-hover`
where composed, which already honours `prefers-reduced-motion`.

---

## 6. Token sweep (exhaustive) — `theme.css`, `glass.css`, and inline-styled components

### 6a. Control height

Replace hardcoded control heights with `var(--control-h)`:

| Location                | Current            | After                                |
| ----------------------- | ------------------ | ------------------------------------ |
| `glass.css` `.field`    | `min-height: 42px` | `min-height: var(--control-h)` (→40) |
| `glass.css` `.btn` (md) | `min-height: 40px` | `min-height: var(--control-h)`       |
| `glass.css` `.ico-btn`  | `height: 40px`     | `height: var(--control-h)`           |
| `ChipsField.tsx`        | `minHeight: 40`    | `var(--control-h)`                   |
| `KeyValueEditor.tsx`    | `minHeight: 40`    | `var(--control-h)`                   |

`.btn-sm` (32) and `.btn-lg` (48) keep their own heights. The net visible change is `.field`
shrinking 2px to align with buttons/icon-buttons on shared toolbar rows.

### 6b. Heading weight

Map landing/section heading weights to `var(--fw-heading)` (780) and reconcile the outliers:
`780 → --fw-heading`; `760 → --fw-heading` (unify); `680 → --fw-semibold` (700). Files (from audit):
`LiveConsole.tsx`, `Scenarios.tsx`, `HowItWorks.tsx`, `Pricing.tsx`, `CTASection.tsx`,
`FeaturePan.tsx`. Detail-page `<h1>` size is reconciled via `DetailScaffold` to one size.

### 6c. Sub-token spacing

Sweep scattered hardcoded gaps/padding to tokens. **Rounding rule (hard constraint first):**

1. **Zero visible regression is the hard constraint.** The token sweep must not visibly change a
   component's proportions.
2. Frequent half-steps `2px → --s-0`, `6px → --s-1h`.
3. Rare oddballs snap to the 8px grid **only where review confirms no visible change**:
   `3→2 (--s-0)`, `5→4 (--s-1)`, `7→8 (--s-2)`, `9→8 (--s-2)`, `11→12 (--s-3)`.
4. Where a rounded value _does_ visibly change proportions (e.g. a compact control's padding),
   keep the exact value via a token comment rather than rounding — tokenization is the goal,
   blind rounding is not.

Known literal inventory to sweep (from audit, non-exhaustive — the plan enumerates the rest):
`Pill.tsx` (`gap:5`, `padding:'3px 9px'`), `SegmentedControl.tsx` (`gap:2`, `padding:'7px 14px'`),
`EntityCard.tsx` (`gap:6`, `marginTop:3`), `FormField.tsx` (`gap:6`), `SubNav.tsx` (`padding:'0 12px'`),
`TopBar.tsx` (`marginTop:2`), `card-glyph` radius `10`, landing glyph radii `10/11/12`.

---

## 7. Application map (D2 — broad)

| Surface                   | File(s) (from audit)                                          | Treatment                                                   |
| ------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------- |
| Rail                      | `components/console/chrome/Rail.tsx:31`                       | `.liquid-glass`                                             |
| SubNav                    | `components/console/chrome/SubNav.tsx:24`                     | `.liquid-glass`                                             |
| TopBar                    | `components/console/chrome/TopBar.tsx`                        | `.liquid-glass` (currently has no glass bg — this adds one) |
| Modal panel               | `components/ui/Modal.tsx`                                     | `.liquid-glass`                                             |
| Drawer panel              | `components/ui/Drawer.tsx`                                    | `.liquid-glass`                                             |
| `/app` hero balance + KPI | `features/app/AppOverview.tsx` (+ `BalanceCard`)              | `.liquid-glass` ← **fixes inversion**                       |
| Landing accent cards      | `components/landing/CTASection.tsx`, `Pricing.tsx` (featured) | `.liquid-glass`                                             |
| EntityCard                | `components/data/EntityCard.tsx` (`.entity-card`)             | `.liquid-glass--subtle`                                     |
| Dropdown/popover surfaces | Select / Combobox / DateField / FilterMenu                    | **unchanged** (already `.glass`, balanced)                  |
| `DataTable` rows          | `components/data/DataTable.tsx`                               | **unchanged (solid)**                                       |

Notes:

- `Modal`/`Drawer` _backdrops_ (the scrim `blur(2px)`) are unchanged; only the _panel_ surface
  upgrades.
- `.entity-card` currently uses solid `--panel-bg` with no `backdrop-filter`; `--subtle` adds the
  sheen/edge and a no-blur saturate/brightness, so per-card cost stays low across long grids.
- Surfaces already on `.glass` that read well (popovers, auth panels) are left as-is to bound the
  diff; they can migrate in a later pass.

---

## 8. /app material hierarchy fix (D2)

`AppOverview`'s balance card and KPI band move from `.panel` (blur 10) to `.liquid-glass` (full), so
the tenant product surface reads _richer_ than the ops console — the intended `/console`-vs-`/app`
divergence. `BalanceCard` is the shared component; if it is also used on `/console`, the `/app`
usage opts into the richer tier via a prop/class rather than changing `BalanceCard`'s default
(decided during implementation after checking call-sites).

---

## 9. Testing & verification

- **Unit/integration:** `pnpm test` stays green. Watch for EntityCard / chrome snapshot tests that
  assert on class names or inline styles; update snapshots only where the change is intended.
- **Visual, per-surface, both themes:** screenshot each upgraded surface before/after in dark
  (default) and `[data-theme='light']`, driven through the preview tools. Confirm no readability or
  proportion regression — especially the token-sweep rounding (§6c) and the `.field` height change.
- **Accessibility modes:** verify `prefers-reduced-transparency: reduce` flattens the new material
  to a solid surface, and `prefers-reduced-motion: reduce` is unaffected.
- **Cross-browser:** sanity-check the material in Chrome, Safari, and Firefox — it must look
  equivalent (the whole point of the pure-CSS decision).
- **Performance smoke:** scroll a long EntityCard grid and confirm no jank from the subtle tier.

---

## 10. Risks & mitigations

| Risk                                                   | Mitigation                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Broad rollout = wide regression surface                | Opt-in classes (D1); per-surface visual verification (§9); dense tables untouched.                                                                                                                                                                                                            |
| Backdrop-blur GPU cost on card grids                   | `--subtle` tier drops `backdrop-filter` blur (§5). Contingency: if the §9 perf smoke test shows the remaining `saturate/brightness` backdrop pass still costs on long grids, `--subtle` drops `backdrop-filter` entirely (pure gradient sheen + specular edge + shadow still reads as glass). |
| Token-sweep rounding shifts layouts                    | Hard "zero visible regression" constraint + keep-exact escape hatch (§6c).                                                                                                                                                                                                                    |
| `.field` 42→40 misaligns something that _relied_ on 42 | Audit shows 42 was the outlier; verify toolbar rows + field-heavy forms.                                                                                                                                                                                                                      |
| `BalanceCard` shared across `/console` and `/app`      | Opt-in via prop/class at the `/app` call-site, not a default change (§8).                                                                                                                                                                                                                     |

---

## 11. Out of scope (restated)

Refraction/displacement; dense `DataTable` row material; migrating already-balanced `.glass`
surfaces; Phases 2–5.
