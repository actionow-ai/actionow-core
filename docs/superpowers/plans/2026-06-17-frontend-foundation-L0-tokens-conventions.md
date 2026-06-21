# Frontend Foundation L0 — Tokens & Conventions Baseline (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the token + convention baseline (type scale, shadows, gradient, scrim, motion, radius, breakpoints) and a `CONVENTIONS.md`, plus fix the urgent global-ScrollTrigger bug — so every later layer builds on a single source of truth.

**Architecture:** Add CSS-variable tokens to `src/styles/theme.css`, mirror motion tokens in `src/lib/motion/tokens.ts`, centralize breakpoints in `src/lib/breakpoints.ts`, then sweep existing hardcoded values onto the new tokens. Pure-CSS/token work is verified by typecheck+lint+build+visual; logic helpers get vitest unit tests.

**Tech Stack:** Vite 6, React 19, TypeScript, Tailwind v4 (being de-emphasized), GSAP, vitest.

Spec: `docs/superpowers/specs/2026-06-17-frontend-foundation-consolidation-design.md` (§3 L0, §4 urgent fix #1).

Working dir: `/Users/alienworm/actionow-web`. Run commands from there. Verify gate (used throughout):
`pnpm --filter @actionow/web typecheck && pnpm --filter @actionow/web lint && pnpm --filter @actionow/web build`

---

## File Structure

- `src/styles/theme.css` — **modify**: add type-scale rungs, accent shadows, gradient, scrim, motion, radius tokens (dark `:root` + light `[data-theme='light']`).
- `src/lib/motion/tokens.ts` — **create**: TS mirror of duration/easing tokens for GSAP.
- `src/lib/motion/tokens.test.ts` — **create**: unit test for token shape.
- `src/lib/motion/gsap.ts` — **modify**: set `gsap.defaults`.
- `src/lib/breakpoints.ts` — **create**: named breakpoint queries + `useBreakpoint`.
- `src/lib/breakpoints.test.ts` — **create**: unit test for the constants.
- `src/components/landing/FeaturePan.tsx`, `LiveConsole.tsx` — **modify**: remove global ScrollTrigger kill (urgent fix #1).
- `src/components/landing/{Pricing,HowItWorks,Scenarios}.tsx` — **modify**: replace Tailwind grids with inline grids.
- `src/components/landing/ImmersiveHero.tsx` — **modify**: replace `↓` glyph with a Phosphor icon.
- Heading/shadow/font-size sweep across landing + a few UI files (Task 7–9).
- `docs/CONVENTIONS.md` — **create**: the written conventions.

---

## Task 1: Add design tokens to theme.css

**Files:**

- Modify: `src/styles/theme.css`

- [ ] **Step 1: Add theme-independent tokens to the dark `:root` block**

In the `:root { ... }` block (the dark default), add these declarations (font sizes, radius, durations, easings, and the accent gradient do NOT vary by theme, so they live only here):

```css
/* type scale — added rungs (theme-independent) */
--fs-nano: 9px;
--fs-micro: 10px;
--fs-md: 16px;
--fs-xl: 24px;
--fs-2xl: 30px;
/* radius */
--r-xs: 8px;
/* motion */
--dur-instant: 0.12s;
--dur-fast: 0.18s;
--dur-base: 0.26s;
--dur-slow: 0.42s;
--dur-slower: 0.7s;
--ease-out: cubic-bezier(0.2, 0.8, 0.2, 1);
--ease-in: cubic-bezier(0.4, 0, 1, 1);
/* accent gradient (accent vars are brand-constant across themes) */
--grad-accent: linear-gradient(135deg, var(--accent), var(--accent-2));
```

- [ ] **Step 2: Add theme-varying tokens to the dark `:root` block**

Add the dark values for shadows/scrim/glow (these get a light override in Step 3):

```css
--shadow-accent-sm: 0 4px 14px rgba(255, 176, 10, 0.4);
--shadow-accent-md: 0 6px 16px rgba(255, 176, 10, 0.35);
--shadow-accent-card: 0 12px 30px rgba(255, 176, 10, 0.18);
--glow-accent-strong: 0 0 14px rgba(255, 176, 10, 0.55);
--scrim: rgba(0, 0, 0, 0.45);
```

- [ ] **Step 3: Add the light overrides to the `[data-theme='light']` block**

Only the theme-varying tokens need a light value:

```css
--shadow-accent-sm: 0 4px 14px rgba(245, 158, 11, 0.28);
--shadow-accent-md: 0 6px 16px rgba(245, 158, 11, 0.22);
--shadow-accent-card: 0 12px 30px rgba(245, 158, 11, 0.16);
--glow-accent-strong: 0 0 14px rgba(245, 158, 11, 0.4);
--scrim: rgba(40, 30, 5, 0.32);
```

- [ ] **Step 4: Verify build is green**

Run: `pnpm --filter @actionow/web build`
Expected: builds successfully (tokens are additive; nothing consumes them yet).

- [ ] **Step 5: Commit**

```bash
git -C /Users/alienworm/actionow-web add apps/web/src/styles/theme.css
git -C /Users/alienworm/actionow-web commit -m "feat(web): add type-scale, shadow, gradient, scrim, motion, radius tokens"
```

---

## Task 2: Motion token TS mirror + gsap defaults

**Files:**

- Create: `src/lib/motion/tokens.ts`
- Create: `src/lib/motion/tokens.test.ts`
- Modify: `src/lib/motion/gsap.ts`

- [ ] **Step 1: Write the failing test**

`src/lib/motion/tokens.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { DUR, EASE } from './tokens';

describe('motion tokens', () => {
  it('exposes numeric second-based durations', () => {
    expect(DUR.base).toBeCloseTo(0.26);
    expect(DUR.slow).toBeGreaterThan(DUR.fast);
  });
  it('exposes gsap-compatible easing strings', () => {
    expect(EASE.out).toMatch(/^cubic-bezier|power|sine|elastic/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @actionow/web exec vitest run src/lib/motion/tokens.test.ts`
Expected: FAIL — cannot resolve `./tokens`.

- [ ] **Step 3: Create the tokens module**

`src/lib/motion/tokens.ts` (values mirror the CSS `--dur-*`; GSAP wants seconds as numbers and named eases):

```ts
/** Motion durations in seconds — mirror of the `--dur-*` CSS tokens (for GSAP). */
export const DUR = {
  instant: 0.12,
  fast: 0.18,
  base: 0.26,
  slow: 0.42,
  slower: 0.7,
} as const;

/** GSAP easing names paired with the CSS `--ease-*` cubic-beziers. */
export const EASE = {
  out: 'power3.out',
  in: 'power2.in',
  inOut: 'power2.inOut',
  spring: 'elastic.out(1, 0.45)',
} as const;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @actionow/web exec vitest run src/lib/motion/tokens.test.ts`
Expected: PASS.

- [ ] **Step 5: Set gsap defaults**

Modify `src/lib/motion/gsap.ts` to apply project-wide defaults after registration:

```ts
import { useGSAP } from '@gsap/react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

import { DUR, EASE } from './tokens';

gsap.registerPlugin(useGSAP, ScrollTrigger);
gsap.defaults({ ease: EASE.out, duration: DUR.slow });

export { gsap, ScrollTrigger, useGSAP };
```

- [ ] **Step 6: Verify + commit**

Run: `pnpm --filter @actionow/web typecheck && pnpm --filter @actionow/web exec vitest run src/lib/motion`
Expected: PASS.

```bash
git -C /Users/alienworm/actionow-web add apps/web/src/lib/motion/tokens.ts apps/web/src/lib/motion/tokens.test.ts apps/web/src/lib/motion/gsap.ts
git -C /Users/alienworm/actionow-web commit -m "feat(web): motion token mirror + gsap defaults"
```

---

## Task 3: Centralize breakpoints

**Files:**

- Create: `src/lib/breakpoints.ts`
- Create: `src/lib/breakpoints.test.ts`
- Modify: consumers of `useMediaQuery` that pass a `(min-width: …)` literal (see Step 5).

- [ ] **Step 1: Write the failing test**

`src/lib/breakpoints.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { BP } from './breakpoints';

describe('breakpoints', () => {
  it('defines the canonical media queries', () => {
    expect(BP.md).toBe('(min-width: 768px)');
    expect(BP.lg).toBe('(min-width: 960px)');
    expect(BP.xl).toBe('(min-width: 1100px)');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @actionow/web exec vitest run src/lib/breakpoints.test.ts`
Expected: FAIL — cannot resolve `./breakpoints`.

- [ ] **Step 3: Create the breakpoints module**

`src/lib/breakpoints.ts` (consolidates the scattered 768/880/960/1100 literals into named steps):

```ts
/** Canonical responsive breakpoints as matchMedia query strings. */
export const BP = {
  sm: '(min-width: 640px)',
  md: '(min-width: 768px)',
  wide: '(min-width: 880px)',
  lg: '(min-width: 960px)',
  xl: '(min-width: 1100px)',
} as const;

export type Breakpoint = keyof typeof BP;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @actionow/web exec vitest run src/lib/breakpoints.test.ts`
Expected: PASS.

- [ ] **Step 5: Refactor consumers to named breakpoints**

Replace every inline `useMediaQuery('(min-width: …)')` literal with `useMediaQuery(BP.<name>)` and add `import { BP } from '../../lib/breakpoints';` (adjust relative depth per file). Sites (from grep):

- `components/console/ConsoleLayout.tsx` — `'(min-width: 768px)'` → `BP.md`
- `components/data/DataTable.tsx` — `'(min-width: 768px)'` → `BP.md`
- `components/layout/LanguageSwitch.tsx` — `'(min-width: 768px)'` → `BP.md`
- `components/landing/Nav.tsx` — `'(min-width: 768px)'` → `BP.md`
- `components/landing/FeaturePan.tsx` — `'(min-width: 880px)'` → `BP.wide`
- `features/auth/AuthPage.tsx` — `'(min-width: 960px)'` → `BP.lg`
- `features/console/ResourcesPage.tsx` — `'(min-width: 1100px)'` → `BP.xl`

(If a file uses a literal not in `BP`, add a named entry to `breakpoints.ts` rather than inlining.)

- [ ] **Step 6: Verify + commit**

Run the full gate: `pnpm --filter @actionow/web typecheck && pnpm --filter @actionow/web lint && pnpm --filter @actionow/web build`
Expected: green.

```bash
git -C /Users/alienworm/actionow-web add apps/web/src/lib/breakpoints.ts apps/web/src/lib/breakpoints.test.ts apps/web/src/components apps/web/src/features
git -C /Users/alienworm/actionow-web commit -m "feat(web): centralize responsive breakpoints"
```

---

## Task 4: Urgent fix #1 — remove global ScrollTrigger kills

**Files:**

- Modify: `src/components/landing/FeaturePan.tsx:90`
- Modify: `src/components/landing/LiveConsole.tsx:86`

Background: `useGSAP` already reverts the tweens/triggers it created via its `gsap.context`. The manual `ScrollTrigger.getAll().forEach((s) => s.kill())` kills **all** triggers on the page (Hero, Reveals, the other section), which breaks scroll reveals after a breakpoint/reduced-motion change.

- [ ] **Step 1: Remove the cleanup return in FeaturePan**

In `src/components/landing/FeaturePan.tsx`, delete the line:

```ts
return () => ScrollTrigger.getAll().forEach((s) => s.kill());
```

If `ScrollTrigger` is now unused in the file, also remove it from the import to satisfy `noUnusedLocals`. (Check: `grep -n ScrollTrigger src/components/landing/FeaturePan.tsx` — if only the import remains, drop it.)

- [ ] **Step 2: Remove the cleanup return in LiveConsole**

Same deletion in `src/components/landing/LiveConsole.tsx`, and the same import cleanup if `ScrollTrigger` becomes unused.

- [ ] **Step 3: Verify build + visually confirm reveals still fire**

Run: `pnpm --filter @actionow/web typecheck && pnpm --filter @actionow/web build`
Expected: green. Then with the `:4173` preview, scroll the landing top→bottom and confirm Hero, FeaturePan pin, LiveConsole, and the Reveal sections all still animate (and still animate after toggling theme).

- [ ] **Step 4: Commit**

```bash
git -C /Users/alienworm/actionow-web add apps/web/src/components/landing/FeaturePan.tsx apps/web/src/components/landing/LiveConsole.tsx
git -C /Users/alienworm/actionow-web commit -m "fix(web): stop landing components from killing all ScrollTriggers globally"
```

---

## Task 5: Replace re-inlined heading clamps with type tokens

**Files:** (each has a `clamp(...)` that duplicates a token)

- Modify: `src/features/auth/AuthPage.tsx` — `clamp(28px, 3.4vw, 46px)` → `var(--fs-h1)`
- Modify: `src/components/landing/Pricing.tsx`, `CTASection.tsx`, `Scenarios.tsx`, `HowItWorks.tsx`, `LiveConsole.tsx` — `clamp(26px, 3.4vw, 40px)` → `var(--fs-h2)`

- [ ] **Step 1: Confirm the token values match before swapping**

Run: `grep -n "\-\-fs-h1\|\-\-fs-h2" apps/web/src/styles/theme.css`
Expected: `--fs-h1` ≈ `clamp(28px, 3.4vw, 46px)` and `--fs-h2` ≈ `clamp(26px, 3.4vw, 40px)`. If the existing token differs, keep the token (it is the source of truth) — the goal is to stop re-inlining, not to preserve the literal.

- [ ] **Step 2: Apply the swaps**

In each file, replace the inline `fontSize: 'clamp(28px, 3.4vw, 46px)'` with `fontSize: 'var(--fs-h1)'`, and `fontSize: 'clamp(26px, 3.4vw, 40px)'` with `fontSize: 'var(--fs-h2)'`. Use grep to find any other `clamp(` heading literals and map them to the nearest `--fs-*` token.

- [ ] **Step 3: Verify + commit**

Run: `pnpm --filter @actionow/web build`
Expected: green; headings unchanged visually (spot-check landing + auth at `:4173`).

```bash
git -C /Users/alienworm/actionow-web add apps/web/src/features/auth/AuthPage.tsx apps/web/src/components/landing
git -C /Users/alienworm/actionow-web commit -m "refactor(web): use --fs-h1/--fs-h2 tokens instead of inlined clamps"
```

---

## Task 6: Tokenize ad-hoc accent shadows + gradient

**Files:**

- Modify: `src/components/brand/Logo.tsx` (or wherever `Logo` lives — `grep -rl "function Logo" src`)
- Modify: `src/components/landing/HowItWorks.tsx` (step badge shadow)
- Modify: `src/components/landing/Pricing.tsx` (featured-card shadow)
- Modify: `src/components/ui/RoseLoader.tsx` (drop-shadow glow)
- Modify: any `linear-gradient(135deg, var(--accent), var(--accent-2))` site → `var(--grad-accent)`

- [ ] **Step 1: Swap accent shadows to tokens**

Replace the hardcoded warm shadows with the Task-1 tokens:

- Logo `boxShadow: '0 4px 14px rgba(255,176,10,.4)'` → `'var(--shadow-accent-sm)'`
- HowItWorks step badge `'0 6px 16px rgba(255,176,10,.35)'` → `'var(--shadow-accent-md)'`
- Pricing featured card `'0 12px 30px rgba(255,176,10,.18)'` → `'var(--shadow-accent-card)'`
- RoseLoader `filter: 'drop-shadow(0 0 6px rgba(255,176,10,0.35))'` → `'drop-shadow(var(--glow-accent-strong))'` (verify the rendered glow still reads well; if too strong, tune `--glow-accent-strong` in theme.css).

- [ ] **Step 2: Swap the accent gradient to `--grad-accent`**

Find every `linear-gradient(135deg, var(--accent), var(--accent-2))` (`grep -rn "135deg, var(--accent)" src`) and replace with `var(--grad-accent)`. Known sites: `Button.tsx`, the Logo, `ConsoleLayout.tsx` (×2), `HowItWorks.tsx`, and `.card-glyph` in `styles/glass.css`.

- [ ] **Step 3: Verify + commit**

Run: `pnpm --filter @actionow/web build`; spot-check Logo, CTA button, step badges, RoseLoader, card glyph in both themes at `:4173`.

```bash
git -C /Users/alienworm/actionow-web add apps/web/src
git -C /Users/alienworm/actionow-web commit -m "refactor(web): tokenize accent shadows and the accent gradient"
```

---

## Task 7: Sweep magic font-sizes onto the type scale

**Files:** landing + UI files with bare numeric `fontSize` (see mapping). This is a deterministic find→token sweep, not a redesign.

- [ ] **Step 1: Enumerate offenders**

Run: `grep -rnE "fontSize: ?[0-9]" apps/web/src`
This lists every bare-number `fontSize`. Apply the mapping below to each (round to nearest rung; never invent a value):

| px literal         | token               |
| ------------------ | ------------------- |
| 9, 9.5             | `var(--fs-nano)`    |
| 10                 | `var(--fs-micro)`   |
| 11                 | `var(--fs-caption)` |
| 12, 12.5, 13, 13.5 | `var(--fs-sm)`      |
| 14, 15             | `var(--fs-base)`    |
| 16                 | `var(--fs-md)`      |
| 18                 | `var(--fs-lg)`      |
| 24                 | `var(--fs-xl)`      |
| 30                 | `var(--fs-2xl)`     |

Known hotspots from the audit: `StatCard.tsx`, `AccountsPage.tsx:69/82`, `ApiKeysPage.tsx:123`, `Toaster.tsx:38`, `Button.tsx:8-9`, `Modal.tsx:58`, `TextField.tsx:5-11`, `Pricing.tsx:35-39`, `HowItWorks.tsx:47-59`, `LiveConsole.tsx:142-161`, `ConsoleLayout.tsx:288`.

- [ ] **Step 2: Apply the mapping**

Edit each site to use the mapped token. For any value not in the table (none expected), add the nearest rung or leave it with a `// off-scale: <reason>` comment — do not silently invent.

- [ ] **Step 3: Verify**

Run: `grep -rnE "fontSize: ?[0-9]" apps/web/src` → expect only intentionally-commented exceptions remain.
Run the full gate (`typecheck && lint && build`); spot-check dashboard, accounts, auth, landing in both themes — text sizes should look unchanged.

- [ ] **Step 4: Commit**

```bash
git -C /Users/alienworm/actionow-web add apps/web/src
git -C /Users/alienworm/actionow-web commit -m "refactor(web): replace magic font-sizes with type-scale tokens"
```

---

## Task 8: Remove stray Tailwind grids on the landing

**Files:**

- Modify: `src/components/landing/Pricing.tsx:22`, `HowItWorks.tsx:32`, `Scenarios.tsx:47`

Goal: one layout mechanism (inline + CSS var), matching the rest of the app. These three are the only `grid-cols-*` Tailwind usages.

- [ ] **Step 1: Replace each Tailwind grid with an inline responsive grid**

- `Pricing.tsx:22` `<div className="grid grid-cols-1 md:grid-cols-2" style={{ gap: 'var(--s-4)' }}>` → `<div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 'var(--s-4)' }}>`
- `Scenarios.tsx:47` — same pattern as Pricing (2-up → `minmax(260px, 1fr)`).
- `HowItWorks.tsx:32` `grid-cols-1 md:grid-cols-3` → `gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))'`.

Remove the now-empty `className="grid ..."` (keep any other classes if present).

- [ ] **Step 2: Verify responsive behavior**

Run: `pnpm --filter @actionow/web build`. At `:4173`, resize across mobile/tablet/desktop and confirm Pricing/Scenarios go 1→2 columns and HowItWorks 1→3, matching prior behavior.

- [ ] **Step 3: Commit**

```bash
git -C /Users/alienworm/actionow-web add apps/web/src/components/landing/Pricing.tsx apps/web/src/components/landing/HowItWorks.tsx apps/web/src/components/landing/Scenarios.tsx
git -C /Users/alienworm/actionow-web commit -m "refactor(web): replace Tailwind landing grids with inline grids"
```

---

## Task 9: Replace the `↓` glyph with a Phosphor icon

**Files:**

- Modify: `src/components/landing/ImmersiveHero.tsx:90`

- [ ] **Step 1: Swap the glyph**

Add `ArrowDownIcon` to the existing `@phosphor-icons/react` import in the file, then replace the scroll cue:

```tsx
// before:  ↓ {t('live.title')}
// after:
<ArrowDownIcon size={12} weight="bold" /> {t('live.title')}
```

Wrap the row in a flex container if needed so icon + text align (`display: 'inline-flex', alignItems: 'center', gap: 6`).

- [ ] **Step 2: Verify + commit**

Run: `pnpm --filter @actionow/web build`; confirm the cue renders as an icon at `:4173`.

```bash
git -C /Users/alienworm/actionow-web add apps/web/src/components/landing/ImmersiveHero.tsx
git -C /Users/alienworm/actionow-web commit -m "refactor(web): use Phosphor ArrowDown icon for the scroll cue"
```

---

## Task 10: Write CONVENTIONS.md

**Files:**

- Create: `docs/CONVENTIONS.md`

- [ ] **Step 1: Write the conventions doc**

Create `docs/CONVENTIONS.md` capturing the L0 rules (and forward-referencing L1–L3 which later layers will fill in):

```markdown
# Actionow Web — Conventions

## Design tokens (single source of truth: `src/styles/theme.css`)

- **Type:** all `fontSize` must reference `--fs-*` (`--fs-nano` 9 · `--fs-micro` 10 · `--fs-caption` 11 · `--fs-sm` 13 · `--fs-base` 15 · `--fs-md` 16 · `--fs-lg` 18 · `--fs-h2`/`--fs-h1`/`--fs-display` · `--fs-xl` 24 · `--fs-2xl` 30). No bare numbers; no re-inlined `clamp()` for headings.
- **Spacing/radius:** `--s-*`, `--r-xs/sm/md/lg/pill`. No magic px.
- **Color:** never blue (incl. hover/focus/active). Warm `--accent`/`--accent-2` only. Vendor brand logos are the sole color exception. No emoji — Phosphor `*Icon` only.
- **Shadows/gradient:** use `--glass-shadow`, `--shadow-lift`, `--shadow-cta*`, `--shadow-accent-*`, `--glow-accent*`, `--grad-accent`, `--scrim`. No ad-hoc rgba shadows.
- **Theme:** dark default + `[data-theme='light']`; every component must read tokens so both themes work.

## Motion

- Tokens: CSS `--dur-*`/`--ease-*`; GSAP mirror `lib/motion/tokens.ts` (`DUR`/`EASE`); `gsap.defaults` set in `lib/motion/gsap.ts`.
- GSAP: always inside `useGSAP({ scope, dependencies })`. **Never** call `ScrollTrigger.getAll().kill()` — rely on `useGSAP` auto-revert.
- Reduced motion is default-respected (see L3).

## Responsive

- Breakpoints come from `lib/breakpoints.ts` (`BP.md` 768 · `BP.wide` 880 · `BP.lg` 960 · `BP.xl` 1100). No inline `(min-width: …)` literals.
- Layout via inline styles + CSS vars (not Tailwind utilities).

## (Filled by later layers)

- L1 — data & caching: centralized query keys, cache-policy tiers, `keepPreviousData`, URL-as-truth for filters/tabs, `mutationError(t)`.
- L2 — components: `onChange(value)` contract, `FormField`, a11y (keyboard rows / Modal focus trap / Select keys), variant/size naming.
- L3 — motion details.
```

- [ ] **Step 2: Commit**

```bash
git -C /Users/alienworm/actionow-web add docs/CONVENTIONS.md
git -C /Users/alienworm/actionow-web commit -m "docs(web): add CONVENTIONS.md (L0 token + motion + responsive rules)"
```

---

## Final verification (L0 checkpoint)

- [ ] Run the full gate: `pnpm --filter @actionow/web typecheck && pnpm --filter @actionow/web lint && pnpm --filter @actionow/web build` → all green.
- [ ] Run unit tests: `pnpm --filter @actionow/web exec vitest run` → green.
- [ ] `grep -rnE "fontSize: ?[0-9]" apps/web/src` → only intentionally-commented exceptions.
- [ ] `grep -rn "getAll().forEach" apps/web/src` → no matches.
- [ ] Visual at `:4173` (dark + light): landing scrolls and all sections animate; headings/logo/badges/loader unchanged; mobile/tablet/desktop responsive intact.

## Self-Review notes

- Spec L0 coverage: tokens (T1), motion mirror+defaults (T2), breakpoints (T3), urgent fix #1 (T4), clamp→token (T5), accent shadows+gradient (T6), font-size sweep (T7), Tailwind removal (T8), `↓` glyph (T9), CONVENTIONS.md (T10). All §3-L0 + §4#1 items covered.
- No console/relay/feature work here (correctly deferred to later layers/specs).
