# Phase 5 — Secondary-Surface Polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish four secondary surfaces — the playground coming-soon placeholder, the media gallery, the Dify import result, and the long editors — to the finish of the rest of the app.

**Architecture:** Item 1 extracts ChatWelcome's `Badge`/`Center` to a shared playground module and reuses them. Item 2 swaps media `object-fit`, fixes the audio tile, and makes the empty copy kind-aware. Item 3 surfaces the Dify result with a success badge + auto-scroll. Item 4 inserts the existing `SectionHeader` between editor field groups. Layout/i18n only — no logic or backend change.

**Tech Stack:** React 19 + TS, vitest + @testing-library/react, Vite. i18n: react-i18next.

**Spec:** `docs/superpowers/specs/2026-06-30-surface-polish-design.md`

**Branch:** `feat/console-surface-polish` (stacked on Phase 4).

**Verification:** `pnpm -C apps/web typecheck` after each task; unit tests where noted; final task runs full suite + build + preview smoke.

---

## File map

| File                                                           | Change                                                          | Task    |
| -------------------------------------------------------------- | --------------------------------------------------------------- | ------- |
| `features/app/playground/welcome-chrome.tsx` (new, +test)      | shared `Badge` + `Center`                                       | 1       |
| `features/app/playground/ChatWelcome.tsx`                      | import shared Badge/Center (drop locals)                        | 1       |
| `features/app/playground/PlaygroundComingSoon.tsx`             | rewrite with Badge/Center                                       | 1       |
| `features/app/AppMedia.tsx` (+test)                            | object-fit contain, audio tile, kind-aware empty + clear filter | 2       |
| `features/console/DifyImportPage.tsx`                          | success badge + scroll + close CTA                              | 3       |
| `features/console/FaultPoliciesPage.tsx`, `LimitPlansPage.tsx` | SectionHeaders                                                  | 4       |
| `i18n/locales/{zh-CN,en}/console.json`                         | new keys                                                        | 2, 3, 4 |

---

## Task 1: Playground coming-soon polish

**Files:** Create `features/app/playground/welcome-chrome.tsx` (+ `welcome-chrome.test.tsx`); Modify `ChatWelcome.tsx`, `PlaygroundComingSoon.tsx`.

- [ ] **Step 1:** Read `ChatWelcome.tsx` lines ~105-144 to copy `Center` + `Badge` verbatim.
- [ ] **Step 2: Create `welcome-chrome.tsx`** — move the two helpers, exported:

```tsx
import type { ReactNode } from 'react';

/** Full-height centered column for playground welcome / placeholder screens. */
export function Center({ children }: { children: ReactNode }) {
  return (
    <div style={{ height: '100%', display: 'grid', placeItems: 'center', padding: 'var(--s-5)' }}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 'var(--s-3)',
          textAlign: 'center',
          maxWidth: 560,
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** A 56px icon badge — accent gradient (primary) or glass (secondary). */
export function Badge({ icon, accent }: { icon: ReactNode; accent?: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 56,
        height: 56,
        borderRadius: 'var(--r-lg)',
        display: 'grid',
        placeItems: 'center',
        background: accent === true ? 'var(--grad-accent)' : 'var(--glass-bg)',
        border: accent === true ? 'none' : '1px solid var(--panel-bd)',
        color: accent === true ? 'var(--bg)' : 'var(--muted)',
        boxShadow: accent === true ? 'var(--shadow-lift)' : 'none',
      }}
    >
      {icon}
    </span>
  );
}
```

- [ ] **Step 3: Write the test** — `welcome-chrome.test.tsx`

```tsx
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Badge } from './welcome-chrome';

describe('Badge', () => {
  it('renders its icon with the accent gradient', () => {
    const { container } = render(<Badge icon={<svg data-testid="i" />} accent />);
    const span = container.querySelector('span') as HTMLElement;
    expect(span.querySelector('[data-testid="i"]')).toBeInTheDocument();
    expect(span).toHaveStyle({ background: 'var(--grad-accent)' });
  });
});
```

- [ ] **Step 4: Run** `pnpm -C apps/web test src/features/app/playground/welcome-chrome.test.tsx` → PASS.
- [ ] **Step 5: Update `ChatWelcome.tsx`** — delete its local `Center` + `Badge` definitions; add `import { Badge, Center } from './welcome-chrome';`.
- [ ] **Step 6: Rewrite `PlaygroundComingSoon.tsx`** render to:

```tsx
import { Badge, Center } from './welcome-chrome';
// …in the component (Icon, modality, t already in scope):
return (
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
);
```

Remove the now-unused inline-style scaffolding + any now-unused imports.

- [ ] **Step 7: Verify** `pnpm -C apps/web typecheck` green; `pnpm -C apps/web test src/features/app/playground` green.
- [ ] **Step 8: Commit** `git commit -am "feat(web): polish PlaygroundComingSoon to the ChatWelcome language (shared Badge/Center)"`

---

## Task 2: AppMedia gallery polish

**Files:** Modify `features/app/AppMedia.tsx` (+ `AppMedia.test.tsx` if present); `i18n/locales/{zh-CN,en}/console.json`.

- [ ] **Step 1:** Add i18n keys under `app.media`: `emptyKind` (zh `"没有{{kind}}素材"`, en `"No {{kind}} media yet"`) and `clearFilter` (zh `"全部"`, en `"All"`).
- [ ] **Step 2:** In `AppMedia.tsx`, change the image `<img>` and video `<video>` `objectFit: 'cover'` → `objectFit: 'contain'` (≈ lines 204, 237).
- [ ] **Step 3:** Make the audio branch (≈ lines 206-231) fill the 1:1 frame: wrap in a full-size column that centers the `MusicNotesIcon` badge and pins the `<audio>` to the bottom:

```tsx
<div
  style={{
    width: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'var(--s-2)',
    padding: 'var(--s-3)',
  }}
>
  <MusicNotesIcon size={40} weight="duotone" style={{ color: 'var(--faint)' }} aria-hidden="true" />
  <audio
    src={f.url}
    controls
    preload="none"
    aria-label={kindLabel}
    style={{ width: '100%', marginTop: 'auto' }}
  />
</div>
```

- [ ] **Step 4:** Make the empty copy kind-aware at the `CardCollection` `empty` prop (≈ line 168):

```tsx
empty={
  filter
    ? t('app.media.emptyKind', { kind: t(`app.media.kind.${filter}`) })
    : t('app.media.empty')
}
```

- [ ] **Step 5:** Add a clear-filter affordance next to the kind `SelectField` (shown only when `filter` is set):

```tsx
{
  filter && (
    <Button variant="ghost" size="sm" onClick={() => setKind('')}>
      {t('app.media.clearFilter')}
    </Button>
  );
}
```

(import `Button` if not already; place it adjacent to the `SelectField` in the filter slot.)

- [ ] **Step 6: Verify** `pnpm -C apps/web typecheck` green; if `AppMedia.test.tsx` exists, add/keep a test that with `?kind=video` and zero rows the empty copy contains the video label.
- [ ] **Step 7: Commit** `git commit -am "fix(web): media gallery — contain (no crop), uniform audio tile, kind-aware empty + clear filter"`

---

## Task 3: Dify import result prominence

**Files:** `features/console/DifyImportPage.tsx`; `i18n/locales/{zh-CN,en}/console.json`.

- [ ] **Step 1:** Add i18n `dify.imported` (zh `"导入完成"`, en `"Import complete"`).
- [ ] **Step 2:** In `DifyImportPage.tsx`, import `StatusBadge` from `'../../components/data/StatusBadge'` (if absent) and `useRef`/`useEffect` (if absent). Add a ref + scroll effect:

```tsx
const reportRef = useRef<HTMLDivElement>(null);
useEffect(() => {
  if (report) reportRef.current?.scrollIntoView({ block: 'nearest' });
}, [report]);
```

- [ ] **Step 3:** Wrap the existing report panel (≈ lines 240-257) with the ref + a success header:

```tsx
{
  report && (
    <div ref={reportRef} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
      <StatusBadge tone="ok" label={t('dify.imported')} />
      <div className="panel" style={{ borderRadius: 'var(--r-md)', padding: 'var(--s-4)' }}>
        {/* existing report label + <pre> unchanged */}
      </div>
    </div>
  );
}
```

- [ ] **Step 4:** Swap the footer CTA once a report exists — change the `footer` Button to: when `report` is set, render `<Button variant="cta" onClick={() => setOpen(false)}>{t('common.done')}</Button>`; else the existing submit button. (`common.done` already exists; confirm — else add it.)
- [ ] **Step 5: Verify** `pnpm -C apps/web typecheck` green.
- [ ] **Step 6: Commit** `git commit -am "fix(web): make the Dify import result prominent (success badge + scroll + done CTA)"`

---

## Task 4: Editor section grouping

**Files:** `features/console/FaultPoliciesPage.tsx`, `LimitPlansPage.tsx`; `i18n/locales/{zh-CN,en}/console.json`.

- [ ] **Step 1:** Add i18n keys: `faultPolicies.section.{basic,retry,timeouts,triggers,breaker,meta}` and `limitPlans.section.basic` (zh: 基本/重试/超时/触发条件/熔断/元数据, 基本; en: Basics/Retry/Timeouts/Triggers/Circuit breaker/Metadata, Basics).
- [ ] **Step 2:** In `FaultPoliciesPage.tsx` `FaultPolicyEditor`, import `SectionHeader` (`'../../components/ui/SectionHeader'`) and insert `<SectionHeader title={t('faultPolicies.section.X')} />` before each group: basic (before name) — optional/skip if it reads as the lead; retry (before retryCount block); timeouts (before connectMs); triggers (before retryCodes); breaker (replace/augment the existing toggle button area); meta (before status). Field order/logic unchanged.
- [ ] **Step 3:** In `LimitPlansPage.tsx` `LimitPlanEditor`, add `<SectionHeader title={t('limitPlans.section.basic')} />` before name, and convert the existing manual rules header (bold span + add button) into `<SectionHeader title={t('limitPlans.form.rules')} action={<the existing add-rule Button>} />`.
- [ ] **Step 4: Verify** `pnpm -C apps/web typecheck` green; preview both editors — they read as grouped sections.
- [ ] **Step 5: Commit** `git commit -am "fix(web): group long fault-policy/limit-plan editors into sections"`

---

## Task 5: Full verification

- [ ] **Step 1:** `pnpm -C apps/web typecheck` → green.
- [ ] **Step 2:** `pnpm -C apps/web lint` → green.
- [ ] **Step 3:** `pnpm -C apps/web test` → green (existing + Badge test + any AppMedia test).
- [ ] **Step 4:** `pnpm -C apps/web build` → succeeds.
- [ ] **Step 5:** Preview smoke: `/app/playground/image` shows the polished ComingSoon (accent badge + centered hierarchy); `/app/media` with a non-square asset shows it un-cropped + the audio tile matches the grid; open the Dify import modal (result path needs backend — at least confirm it renders); open a fault-policy editor → grouped sections; both themes; zero console errors.

---

## Self-review

- **Spec coverage:** §3 ComingSoon → T1; §4.1/4.2/4.3 AppMedia → T2; §5 Dify → T3; §6 editors → T4; §7 i18n → T2/T3/T4; §8 testing → each + T5. Covered.
- **Type consistency:** `Badge({icon, accent})`, `Center({children})` exported from `welcome-chrome`; `StatusBadge tone="ok"`; `SectionHeader {title, action?}` (existing). i18n keys listed once in §7 and added in the owning task.
- **Resolve-at-implementation (explicit):** exact ChatWelcome Badge/Center text (T1.1 read), AppMedia exact line context + filter-slot location (T2 read), DifyImportPage `report`/`setOpen` names + whether `common.done` exists (T3.4), FaultPolicy field-block boundaries (T4.2 read). Each has a read step.
