# Frontend Foundation L3 — Motion System (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Checkbox (`- [ ]`) steps.

**Goal:** Turn ad-hoc animation into a system: apply the `--dur-*`/`--ease-*` + `DUR`/`EASE` tokens, unify reduced-motion via `gsap.matchMedia` (+ a CSS safety net), make re-runnable tweens `fromTo`, and add the missing motion — auth feedback (mode cross-fade, error shake, field focus, success), Modal/Toaster enter-exit, route transitions, and console list reveal + count-up.

**Architecture:** Motion tokens already exist (`theme.css --dur-*/--ease-*`, `lib/motion/tokens.ts` `DUR`/`EASE`, `gsap.defaults` set in L0). This layer makes the existing GSAP usage consume them, centralizes the reduced-motion decision in `gsap.matchMedia()` (replacing scattered `if (reduced) return`), and adds new orchestrations. All animation is transform/opacity only and reduced-motion-safe by default.

**Tech Stack:** React 19, GSAP 3 + @gsap/react `useGSAP`, vitest. Motion is largely visual — verify via build + the `:4173` preview (controller does visual checks); unit-test only pure helpers.

Spec §3-L3: `docs/.../2026-06-17-frontend-foundation-consolidation-design.md`. Conventions: `docs/CONVENTIONS.md`. Working dir `/Users/alienworm/actionow-web`. Gate: `pnpm --filter @actionow/web typecheck && lint && build`; `vitest run`. Lowercase commits.

## Read first

`lib/motion/{gsap.ts,tokens.ts,useReducedMotion.ts}`; landing `components/landing/{ImmersiveHero,FeaturePan,LiveConsole,FlipWords,Reveal,CTASection}.tsx`; `components/glass/AppBackground.tsx`; `features/auth/AuthPage.tsx`; `components/ui/{Modal,Toaster,RoseLoader}.tsx`; `components/console/ConsoleLayout.tsx` + `chrome/*`; `components/data/CardCollection.tsx`; `components/console/StatCard.tsx`; `styles/theme.css` (`scroll-behavior`), `styles/glass.css`.

Key facts: `DUR` (seconds) + `EASE` (gsap names) exist in `tokens.ts`; CSS `--dur-*`/`--ease-*` exist. `gsap.defaults({ease:EASE.out,duration:DUR.slow})` already set. Landing components use `useReducedMotion()` + `if (reduced) return` guards and raw duration/ease literals. `AppBackground` pointer-parallax + cursor spotlight run regardless of reduced-motion. `theme.css` has global `scroll-behavior: smooth` with no reduced-motion override. `Modal` does `if(!open) return null` (instant). `Toaster` mounts/removes via setTimeout (no exit). The L2 `SegmentedControl` already animates the auth login/register indicator; `Button loading` already covers submit-busy.

---

## File Structure

- `lib/motion/useReducedMotion.ts` (keep — for CSS toggles); add `lib/motion/matchMedia` usage inline in components (no new file needed unless a helper emerges).
- `styles/theme.css` (modify) — wrap global `scroll-behavior: smooth` + add a reduced-motion CSS safety net.
- `styles/glass.css` (modify if needed) — any new keyframes (modal/toast) + reduced-motion guards.
- Landing components (modify) — consume `DUR`/`EASE`; convert re-runnable `gsap.from`→`fromTo`; reduced-motion via `gsap.matchMedia`.
- `components/glass/AppBackground.tsx` (modify) — gate pointer parallax + spotlight on reduced-motion.
- `features/auth/AuthPage.tsx` (modify) — mode cross-fade, error shake, field-focus accent, success micro.
- `components/ui/Modal.tsx` (modify) — backdrop fade + dialog scale enter/exit (deferred unmount).
- `components/ui/Toaster.tsx` (modify) — slide/fade enter + exit-before-remove.
- `components/console/ConsoleLayout.tsx` (modify) — route-transition wrapper around `<Outlet/>`.
- `components/data/CardCollection.tsx` (modify) — stagger reveal.
- `components/console/StatCard.tsx` (modify) — count-up.

---

## Task 1: Tokenize durations/eases + matchMedia reduced-motion + CSS safety net

- [ ] In each landing GSAP component (`ImmersiveHero`, `FeaturePan`, `LiveConsole`, `FlipWords`, `Reveal`, `CTASection` via Reveal, `AppBackground`), replace raw duration/ease literals with `DUR.*`/`EASE.*` from `lib/motion/tokens.ts`.
- [ ] Replace the `if (reduced) return` pattern with `gsap.matchMedia()` scoped to the component, so full vs reduced variants live together:

```ts
useGSAP(
  () => {
    const mm = gsap.matchMedia();
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      /* full tweens */
    });
    // optional reduced branch: set final state instantly
    mm.add('(prefers-reduced-motion: reduce)', () => {
      /* gsap.set(...) end state */
    });
  },
  { scope: ref },
);
```

(Keep `useReducedMotion()` only where a non-GSAP/CSS toggle needs it.)

- [ ] `AppBackground`: gate the `pointermove` parallax + cursor spotlight listeners on `(prefers-reduced-motion: no-preference)` (currently always-on) — add them only inside the no-preference matchMedia branch; the idle blob drift is already gated.
- [ ] `theme.css`: change global `scroll-behavior: smooth` to be reduced-motion-aware, and add a safety net:

```css
@media (prefers-reduced-motion: no-preference) {
  html {
    scroll-behavior: smooth;
  }
}
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

(Remove the unconditional `html { scroll-behavior: smooth }`.)

- [ ] Verify: build green; at `:4173` landing still animates normally; emulate reduced-motion (controller) → animations collapse to end-state, no smooth-scroll.
- [ ] Commit `refactor(web): tokenize motion + unify reduced-motion via matchmedia + css safety net`.

## Task 2: `gsap.from` → `fromTo` in re-runnable effects

- [ ] In `ImmersiveHero`, `Reveal`, `LiveConsole`, `AuthPage` (any `useGSAP` whose deps can change, e.g. `[reduced]`/i18n/state), convert `gsap.from(targets, {...})` to `gsap.fromTo(targets, {<start>}, {<end>})` with explicit start+end so a mid-flight re-run can't strand elements at partial opacity. Keep the same visual.
- [ ] Verify build green; landing/auth reveals still play once and don't get stuck on theme/lang toggle.
- [ ] Commit `fix(web): use gsap.fromTo for re-runnable reveal effects`.

## Task 3: Auth page motion (cross-fade, error shake, field focus, success)

Files: `features/auth/AuthPage.tsx` (+ small CSS in glass.css if needed). NOTE: tab-switch indicator (SegmentedControl) + submit-busy (Button loading) already exist from L2 — do NOT redo them.

- [ ] **Mode cross-fade:** when `mode` (login↔register) changes, cross-fade / height-settle the form body (the fields that differ, e.g. autoComplete + submit label) — a short `gsap.fromTo(formBody, {opacity:.4, y:6},{opacity:1,y:0,duration:DUR.base,ease:EASE.out})` keyed on `mode` inside a `useGSAP` with `dependencies:[mode]`, guarded by matchMedia.
- [ ] **Error shake:** on a failed submit (the `catch` branch / `ApiError`), shake the card: `gsap.fromTo(cardRef.current, { x: -8 }, { x: 0, duration: DUR.slow, ease: 'elastic.out(1,0.4)' })` + a brief `--fail` border pulse. Trigger via a ref + an error counter state, or call directly in the catch. Respect reduced-motion (skip the shake; the toast still shows).
- [ ] **Field focus accent:** add a subtle focus transition to the auth `TextField`s (accent border/label lift on focus) — can be CSS on `:focus-within` of the field wrapper using `--accent` + `--dur-fast`; no blue.
- [ ] **Success micro:** on successful auth, before `navigate`, a brief success cue (e.g. morph the submit button to a check via the existing `CheckCircleIcon`, or a quick scale) — keep it ≤ `DUR.base` so navigation isn't delayed perceptibly; skip under reduced-motion.
- [ ] Verify at `:4173`: switch login/register → body cross-fades; submit wrong creds → card shakes + error toast; focus a field → accent; (success path needs valid creds — controller checks). Build green.
- [ ] Commit `feat(web): auth motion — mode cross-fade, error shake, field focus, success cue`.

## Task 4: Modal enter/exit

File: `components/ui/Modal.tsx`.

- [ ] Replace the instant `if(!open) return null` with an animated lifecycle: keep the node mounted through the exit, animate backdrop opacity (0→1) + dialog `scale(.96)→1`/`y(8)→0` on open (`DUR.base`, `EASE.out`), and reverse on close, unmounting `onComplete`. Use a local `mounted`/`visible` state + `useGSAP` (or a small timeline) keyed on `open`. Preserve the focus-trap (L2), Escape, scrollport padding. Reduced-motion → instant (no scale/fade, immediate mount/unmount) via matchMedia.
- [ ] Verify at `:4173`: open/close any modal → backdrop fades, dialog scales in, exit animates then unmounts; focus trap still works; reduced-motion = instant. Build green.
- [ ] Commit `feat(web): modal enter/exit animation`.

## Task 5: Toaster enter/exit

File: `components/ui/Toaster.tsx`.

- [ ] Animate each toast: slide-up + fade-in on mount; before removal, fade/slide-out then remove (hook the existing `setTimeout` to trigger an exit state first, then remove after the exit duration). Use CSS transitions or a tiny GSAP tween; transform/opacity only; reduced-motion → instant. Keep the `aria-live` from L2 if present (else add `aria-live="polite"`, errors `assertive`).
- [ ] Verify at `:4173`: trigger a toast (e.g. an action) → slides in, then slides out before disappearing. Build green.
- [ ] Commit `feat(web): toast enter/exit animation`.

## Task 6: Route transition on console `<Outlet/>`

File: `components/console/ConsoleLayout.tsx` (composition root).

- [ ] Wrap the `<Outlet/>` in a keyed transition: on `pathname` change, fade/slide-up the new view (`gsap.fromTo(viewRef, {opacity:0, y:8},{opacity:1,y:0,duration:DUR.base,ease:EASE.out})` inside `useGSAP` with `dependencies:[pathname]`). Keep it cheap (no exit needed — a quick enter is enough). Reduced-motion → no transform (instant). Must NOT break the scroll containers / fill layout from L0/earlier.
- [ ] Verify at `:4173`: navigate between console sections → content fades/slides in; layout/scroll unaffected; reduced-motion instant. Build green.
- [ ] Commit `feat(web): console route-transition on outlet`.

## Task 7: Card list reveal + StatCard count-up

Files: `components/data/CardCollection.tsx`, `components/console/StatCard.tsx`.

- [ ] `CardCollection`: stagger-reveal its cards on first render / when rows arrive (`gsap.from`/`fromTo` with `stagger: 0.04`, `DUR.base`, `EASE.out`, scoped). Guard reduced-motion. Don't fight the existing loading/empty states; only animate the rendered cards. Keep it subtle.
- [ ] `StatCard`: count-up the numeric `value` from 0 → target on mount/value-change (reuse the technique in `LiveConsole`'s stat count-up; `gsap.to({n:0},{n:target,...,onUpdate})`). Only when `value` is a number; reduced-motion → show final immediately. Tabular-nums to avoid width jitter.
- [ ] Verify at `:4173`: Dashboard tiles count up; lists stagger-reveal; reduced-motion = static. Build green.
- [ ] Commit `feat(web): card-list stagger reveal + statcard count-up`.

## Final verification (L3 checkpoint)

- [ ] Full gate + `vitest run` green.
- [ ] `grep -rn "if (reduced) return" apps/web/src` → minimized (landing GSAP uses matchMedia; remaining ones justified).
- [ ] `grep -rn "ScrollTrigger.getAll" apps/web/src` → none (L0 invariant holds).
- [ ] Controller visual at `:4173` (normal + emulated reduced-motion, dark + light): landing animates + reduced-motion collapses; auth cross-fade/shake/focus; modal + toast enter/exit; route transition; dashboard count-up + list stagger; nothing janky, no layout shift, no stuck-hidden elements.

## Self-review notes

- Spec L3 coverage: tokenize + matchMedia reduced-motion + AppBackground/scroll gating + CSS net (T1), fromTo (T2), auth motion set minus the L2-delivered pieces (T3), Modal enter/exit (T4), Toaster enter/exit (T5), route transition (T6), card reveal + count-up (T7).
- Motion is verified visually (build-green + preview), not via unit tests (animation timing isn't meaningfully unit-testable here); any pure helper added gets a test.
