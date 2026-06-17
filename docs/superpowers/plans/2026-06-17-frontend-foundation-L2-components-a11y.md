# Frontend Foundation L2 — Components & Accessibility (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Checkbox (`- [ ]`) steps.

**Goal:** Unify the component contracts (one `onChange(value)`, a `FormField` wrapper, consistent variants), make interactive surfaces accessible (keyboard-operable rows/cards, Modal focus trap, Select keyboard nav), fix the `StatusBadge` i18n leak + `Button` loading state, extract `IconButton`, add the foundational primitives the system lacks, split the oversized console chrome, and make the chrome context hooks loop-safe.

**Architecture:** A `FormField` shell standardizes label/error/hint; all field inputs emit `onChange(value)`. A `useFocusTrap` hook backs `Modal`. New primitives (`NumberField`, `Checkbox`, `Toggle`, `SegmentedControl`, `Tabs`, `IconButton`) live in `components/ui`. `ConsoleLayout` is decomposed into `components/console/chrome/*`. Speculative feature-coupled primitives (ConfirmDialog, Tooltip, Pagination, Badge, CodeBlock, Drawer) are **deferred** to the feature that first needs them (YAGNI) — noted, not built.

**Tech Stack:** Vite 6, React 19, TS (strict), react-i18next, Phosphor, vitest, @testing-library/react (installed).

Spec: `docs/.../2026-06-17-frontend-foundation-consolidation-design.md` §3-L2. Conventions: `docs/CONVENTIONS.md`. Working dir `/Users/alienworm/actionow-web`. Gate: `pnpm --filter @actionow/web typecheck && lint && build`; tests `pnpm --filter @actionow/web exec vitest run`. Commit subjects must be lowercase (commitlint). A preview runs on :4173 (controller verifies visually).

## Current component APIs (read these files first)

`components/ui/{Button,Select,SelectField,TextField,JsonField,Modal,Toaster,toast,SectionHeader,StatCard}.tsx`, `components/data/{EntityCard,DataTable,StatusBadge}.tsx`, `components/console/{ConsoleChrome,ConsoleLayout}.tsx`, and consumers in `features/console/*` + `features/auth/AuthPage.tsx`. Key facts: `TextField` emits `onChange(event)` and spreads `InputHTMLAttributes` (the `type="number"` escape hatch); `Select`/`SelectField`/`JsonField`/`TenantSelect` emit `onChange(value)`; `Modal` only handles Escape; `EntityCard`/`DataTable` rows are `<div onClick>`; `StatusBadge` renders the raw `status` string; `Button` variants are `cta|ghost`, sizes `md|lg`; the `ico-btn`/`RailButton` pattern is duplicated across chrome + `ThemeToggle`/`LanguageSwitch`.

---

## File Structure

- `components/ui/FormField.tsx` (new) — label/error/hint/required shell.
- `components/ui/TextField.tsx` (modify) — `onChange(value)`, compose `FormField`, `error?`/`hint?`; drop arbitrary-attr spread (keep `type`/`placeholder`/`autoComplete`/`min` explicit props).
- `components/ui/NumberField.tsx` (new) — `onChange(number)`, min/max/step; composes FormField.
- `components/ui/Checkbox.tsx`, `Toggle.tsx`, `SegmentedControl.tsx`, `Tabs.tsx`, `IconButton.tsx` (new).
- `components/ui/Select.tsx` (modify) — keyboard nav.
- `components/ui/SelectField.tsx`, `JsonField.tsx` (modify) — compose FormField; JsonField error→`--fail`.
- `components/ui/Modal.tsx` (modify) + `lib/useFocusTrap.ts` (new).
- `components/ui/Button.tsx` (modify) — `loading`, variants `cta|ghost|link|danger`, sizes `sm|md|lg`.
- `components/data/StatusBadge.tsx` (modify) — `{tone, label}` API + a `statusTone(status)` mapper export.
- `components/data/EntityCard.tsx`, `DataTable.tsx` (modify) — keyboard-operable rows.
- `components/console/chrome/{Rail,SubNav,TopBar,BottomTabs}.tsx` (new) + `ConsoleLayout.tsx` (modify, becomes composition root).
- `components/console/ConsoleChrome.tsx` (modify) — `useSetConsole*(render, deps)`.
- Tests: `*.test.tsx` for FormField, NumberField, Checkbox/Toggle, SegmentedControl, Tabs, useFocusTrap, Select keyboard.
- Migrations: `features/console/*`, `features/auth/AuthPage.tsx`, i18n `console.json` (status labels).

---

## Task 1: `FormField` shell + tokens

- [ ] Write `FormField.test.tsx`: renders label, associates it (htmlFor/id), shows `error` text when set (in `--fail` color), shows `hint` when set + no error, marks `required`.
- [ ] Verify red. Implement `components/ui/FormField.tsx`:

```tsx
import type { ReactNode } from 'react';
let _id = 0;
export function useFieldId(explicit?: string) {
  return explicit ?? `ff-${(_id += 1)}`;
}
export function FormField({
  id,
  label,
  error,
  hint,
  required,
  children,
}: {
  id: string;
  label?: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {label !== undefined && (
        <label htmlFor={id} style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
          {label}
          {required === true && <span style={{ color: 'var(--fail)' }}> *</span>}
        </label>
      )}
      {children}
      {error !== undefined ? (
        <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--fail)' }}>{error}</span>
      ) : hint !== undefined ? (
        <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--faint)' }}>{hint}</span>
      ) : null}
    </div>
  );
}
```

- [ ] Verify green. Commit `feat(web): formfield shell for unified field labels/errors`.

## Task 2: `TextField` → `onChange(value)` + compose FormField

- [ ] Rewrite `TextField` to props `{ label?, value, onChange(value:string), error?, hint?, required?, type?, placeholder?, autoComplete?, disabled?, id? }` (no arbitrary attr spread). Render an `<input>` (warm-token styled, focus via global ring) inside `FormField`, wiring `id`. The `<input onChange={(e)=>onChange(e.target.value)}>` adapts the DOM event internally so callers pass `onChange(value)`.
- [ ] Migrate every `TextField` call site (grep `grep -rn "<TextField" apps/web/src`): change `onChange={(e) => setX(e.target.value)}` → `onChange={setX}` (or `(v)=>setX(v)`). Sites include ResourcesPage, ResourceDetailPane, AccountsPage, ApiKeysPage, ModifiersPage, DifyImportPage, TenantsPage, AuthPage.
- [ ] For the two numeric `TextField type="number"` smuggles (ApiKeysPage rate limit, AccountsPage credits/topup) — leave as TextField for now if NumberField (Task 3) isn't merged yet; Task 3 migrates them.
- [ ] Gate green. Commit `feat(web): unify textfield onChange(value) + formfield`.

## Task 3: `NumberField`

- [ ] Write `NumberField.test.tsx`: typing emits `onChange(number)`; respects min/max/step; empty input emits `onChange(NaN)` or `0` (pick: emit `0` and document); composes FormField (label/error render).
- [ ] Verify red. Implement `components/ui/NumberField.tsx` (`{ label?, value:number, onChange(n:number), min?, max?, step?, error?, hint?, required?, id? }`) — `<input type="number">` inside FormField; `onChange={(e)=>onChange(e.target.valueAsNumber)}` (guard NaN→0 or keep NaN, document).
- [ ] Migrate the numeric smuggles: ApiKeysPage rate-limit + AccountsPage credits/topup use `NumberField` with numeric state (string→number state change as needed).
- [ ] Verify green. Commit `feat(web): numberfield + replace type=number textfields`.

## Task 4: `Checkbox` + `Toggle`

- [ ] Write a combined `Checkbox.test.tsx` + `Toggle.test.tsx`: click toggles, emits `onChange(boolean)`, keyboard Space toggles, `aria-checked`/`role` correct, disabled blocks.
- [ ] Verify red. Implement `Checkbox.tsx` (`{checked, onChange(b), label?, disabled?}` — a real `<input type="checkbox">` visually restyled with warm tokens, or a `role="checkbox"` button; ensure keyboard + focus ring) and `Toggle.tsx` (switch styled; `role="switch"`, `aria-checked`). No blue; warm `--accent` when on.
- [ ] Verify green. Commit `feat(web): checkbox + toggle primitives`.

## Task 5: `SegmentedControl` + replace AuthPage toggle

- [ ] Write `SegmentedControl.test.tsx`: renders options, selected has `aria-selected`/pressed, arrow keys move selection, `onChange(value)` fires.
- [ ] Verify red. Implement `SegmentedControl.tsx` (`{ value, onChange(v), options: {value,label}[] }`) — a `role="tablist"`-ish or radiogroup of buttons with a sliding active indicator (absolute, `transform: translateX`, transition `var(--dur-base) var(--ease-out)`, reduced-motion via `useReducedMotion`). Warm active fill (`--grad-accent` or `--hover-bg`), no blue. Keyboard arrows.
- [ ] Replace `AuthPage`'s hand-rolled `<button>` login/register toggle (the native-component violation) with `SegmentedControl`. (The cross-fade animation of the form body is L3 — here just swap the control.)
- [ ] Verify green. Commit `feat(web): segmentedcontrol + use it for auth login/register toggle`.

## Task 6: `Tabs`

- [ ] Write `Tabs.test.tsx`: `role="tablist"`/`tab`/`tabpanel`, arrow-key roving focus, selected panel shown, `onChange`.
- [ ] Verify red. Implement `Tabs.tsx` (`{ value, onChange(v), tabs: {value,label}[], children }` or a compound API — pick the simpler controlled form). ARIA-correct, keyboard nav, warm active indicator.
- [ ] Verify green. Commit `feat(web): tabs primitive`.

## Task 7: `IconButton` + dedupe chrome buttons

- [ ] Implement `IconButton.tsx` (`{ icon: Icon, label (a11y), onClick?, active?, size?, tooltip? }`) — renders a `<button class="ico-btn">` with `aria-label={label}`, optional slide-out `.ico-tip` tooltip, `is-active`. (Reuses existing `.ico-btn`/`.ico-tip` CSS.)
- [ ] Replace the duplicated raw `<button className="ico-btn">`/`RailButton` usages in chrome + `ThemeToggle` + `LanguageSwitch` with `IconButton`. (Done as part of Task 11's chrome split where they live; if doing before the split, update in place.)
- [ ] Gate green. Commit `feat(web): iconbutton primitive + dedupe chrome icon buttons`.

## Task 8: Modal focus trap

- [ ] Write `useFocusTrap.test.tsx` (render a trap container with buttons; assert initial focus moves inside; Tab from last wraps to first; on unmount focus returns to the previously-focused trigger). Use RTL + userEvent.
- [ ] Verify red. Implement `lib/useFocusTrap.ts` (`useFocusTrap(ref, active)`: on activate, store `document.activeElement`, focus first focusable in ref; keydown Tab/Shift-Tab cycles within; on deactivate, restore focus). Respect that there may be no focusables.
- [ ] Wire into `Modal`: focus-trap while `open`; keep Escape; restore on close. Keep the existing scrollport/padding.
- [ ] Verify green. Commit `feat(web): modal focus trap + restore (useFocusTrap)`.

## Task 9: `Select` keyboard navigation

- [ ] Write `Select.test.tsx` (open via Enter/Space/ArrowDown; ArrowUp/Down move active option; Home/End jump; Enter selects + closes; Escape closes; type-ahead jumps to matching label). Use RTL + userEvent.
- [ ] Verify red. Add keyboard handling to `Select` (roving `aria-activedescendant` or focus into the listbox; maintain `activeIndex`; handle ArrowUp/Down/Home/End/Enter/Escape + type-ahead buffer). Keep the portal/positioning/outside-click behavior.
- [ ] Verify green. Commit `feat(web): select keyboard navigation`.

## Task 10: `StatusBadge` `{tone, label}` + Button loading/variants

- [ ] `StatusBadge`: change API to `{ tone: 'ok'|'run'|'wait'|'fail'|'idle', label: string }` and export `statusTone(status: string): Tone` (the current string→tone map). Update every usage to `<StatusBadge tone={statusTone(s)} label={t('status.'+s, s)} />` (add a `status.*` i18n block in both locales for the known statuses: active/inactive/succeeded/failed/running/queued/etc — read the strings actually used). This stops leaking raw English enums.
- [ ] `Button`: add `loading?: boolean` (sets `aria-busy`, disables, shows an inline spinner — a tiny rotating Phosphor `CircleNotchIcon` or the `.refresh-spin` class); add variants `link` + `danger`; add size `sm`. Migrate mutation submit buttons (`create.mutate()` etc.) to pass `loading={mutation.isPending}`. Replace AuthPage's raw link-style `<button>` (switch-mode) with `Button variant="link"`.
- [ ] Gate green. Commit `feat(web): statusbadge tone/label i18n + button loading/link/danger`.

## Task 11: Keyboard-operable rows + cards

- [ ] `EntityCard`: when `onClick` is set, render the card as a focusable control — add `role="button"`, `tabIndex={0}`, `onKeyDown` (Enter/Space → onClick, preventDefault on Space). Keep the visual.
- [ ] `DataTable`: when `onRowClick` is set, same treatment on the row div (`role="button"`, `tabIndex`, key handler) — or render a `<button>` overlay. Ensure the global focus-ring shows.
- [ ] Gate green; (controller will keyboard-test). Commit `fix(web): keyboard-operable entity cards + table rows (a11y)`.

## Task 12: Split ConsoleLayout chrome + loop-safe context hooks

- [ ] Create `components/console/chrome/{Rail,SubNav,TopBar,BottomTabs}.tsx`, moving each component out of `ConsoleLayout.tsx` (preserve behavior: rail sliding indicator, subnav highlight, topbar action/filters/back/refresh + mobile chrome, bottom tabs). Use `IconButton` where the raw `ico-btn` buttons were. `ConsoleLayout.tsx` becomes the composition root (providers + layout + `<Outlet/>`).
- [ ] `ConsoleChrome`: change `useSetConsoleAction/Filters/Back` to `(render: () => ReactNode, deps: unknown[])` and `useMemo` internally (so callers can't cause the documented infinite loop). Update all page call sites (`useSetConsoleAction(() => <Button.../>, [t])` etc.).
- [ ] Gate green. Commit `refactor(web): split console chrome + loop-safe context hooks`.

## Final verification (L2 checkpoint)

- [ ] Full gate + `vitest run` green (incl. all new component tests).
- [ ] `grep -rn "onChange={(e) =>" apps/web/src/features` → none for TextField (all `onChange(value)`).
- [ ] `grep -rn "type=\"number\"" apps/web/src/features` → none (NumberField used).
- [ ] No raw `<select>`/`<input>` outside the wrappers; AuthPage segmented + switch-mode use `SegmentedControl`/`Button variant=link`.
- [ ] `ConsoleLayout.tsx` is now small (composition root); chrome under `components/console/chrome/`.
- [ ] Controller visual + keyboard checks at `:4173`: Tab focuses cards/rows + Enter opens; Modal traps focus + restores on close; Select arrow-keys; auth segmented control slides; both themes intact; mutation buttons show loading.

## Self-review notes

- Spec L2 coverage: onChange-unify+FormField (T1,T2), NumberField (T3), Checkbox/Toggle (T4), SegmentedControl (T5), Tabs (T6), IconButton (T7), Modal focus trap (T8), Select keys (T9), StatusBadge i18n + Button loading/variants (T10), keyboard rows/cards (T11), chrome split + loop-safe hooks (T12).
- Deferred (YAGNI, build with their feature): ConfirmDialog, Tooltip, Pagination, Badge, CodeBlock, Drawer — noted here so it's a conscious choice, not an omission.
