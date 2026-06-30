# Phase 4 — Responsive + Status A11y — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give 768–960px tablets a usable full-width layout, cap detail-page reading width, and make status legible without colour alone (neutral PillTone, sparkline/plugin aria, one caution token).

**Architecture:** Two independent threads. A = breakpoint bumps + a max-width on `DetailScaffold`. B = a new `neutral` PillTone + `role="img"`/label on the sparkline + a labelled StatusBadge on the plugin test + a caution-token fix + targeted `--faint`→`--muted` swaps.

**Tech Stack:** React 19 + TS, vitest + @testing-library/react, Vite. i18n: react-i18next.

**Spec:** `docs/superpowers/specs/2026-06-30-responsive-a11y-design.md`

**Branch:** `feat/console-responsive-a11y` (stacked on Phase 3).

**Verification:** `pnpm -C apps/web typecheck` after each task; unit tests where noted; final task runs full suite + build + preview smoke.

---

## File map

| File                                                        | Change                                           | Task |
| ----------------------------------------------------------- | ------------------------------------------------ | ---- |
| `components/console/ConsoleLayout.tsx`, `chrome/TopBar.tsx` | chrome gate `BP.md`→`BP.lg`                      | 1    |
| `features/auth/AuthPage.tsx`                                | split `BP.wide`→`BP.lg`                          | 1    |
| `styles/theme.css`                                          | `--content-detail: 960px`                        | 2    |
| `components/console/DetailScaffold.tsx`                     | max-width reading column                         | 2    |
| `features/console/PlatformSettingsPage.tsx`                 | settings row wraps cleanly + override tone       | 3, 4 |
| `components/ui/Pill.tsx` (+test)                            | `neutral` tone                                   | 4    |
| `features/console/RelayTracesPage.tsx`, `AuditLogPage.tsx`  | route-tag / filter chip → `neutral`              | 4    |
| `features/console/StatusPage.tsx`                           | sparkline `role="img"`+aria; `--faint`→`--muted` | 5, 7 |
| `features/console/PluginsPage.tsx`                          | test-result StatusBadge + label                  | 6    |
| `features/console/OverviewPage.tsx`                         | caution `--warn`→`--wait`                        | 6    |
| `features/auth/AuthPage.tsx`                                | eyebrow `--faint`→`--muted` (if fails AA)        | 7    |
| `i18n/locales/{zh-CN,en}/console.json`                      | `status.sparkAria`, `plugins.testOk/testError`   | 5, 6 |

---

## Task 1: Responsive breakpoints (chrome + auth)

**Files:** `components/console/ConsoleLayout.tsx`, `components/console/chrome/TopBar.tsx`, `features/auth/AuthPage.tsx`.

- [ ] **Step 1:** `ConsoleLayout.tsx:36` change `const isDesktop = useMediaQuery(BP.md);` → `const isDesktop = useMediaQuery(BP.lg);`
- [ ] **Step 2:** `TopBar.tsx:37` change `const isDesktop = useMediaQuery(BP.md);` → `const isDesktop = useMediaQuery(BP.lg);`
- [ ] **Step 3:** `AuthPage.tsx:153` change `const isDesktop = useMediaQuery(BP.wide);` → `const isDesktop = useMediaQuery(BP.lg);`
- [ ] **Step 4: Verify** `pnpm -C apps/web typecheck` green; preview at ~860px shows the mobile layout (BottomTabs + full-width), at ≥960px the Rail+SubNav (verify in Task 8).
- [ ] **Step 5: Commit** `git commit -am "fix(web): raise console/auth desktop breakpoint to BP.lg (tablet full-width)"`

---

## Task 2: DetailScaffold reading column

**Files:** `styles/theme.css`, `components/console/DetailScaffold.tsx`.

- [ ] **Step 1:** In `theme.css` `:root`, near `--content-max: 1200px;`, add `--content-detail: 960px;`
- [ ] **Step 2:** In `DetailScaffold.tsx` (the return ≈ lines 121-126), wrap the children in a capped column:

```tsx
return (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
    <DetailBackLink to={backTo} label={backLabel} />
    <div style={{ maxWidth: 'var(--content-detail)', width: '100%' }}>
      {notFound ? <NotFound message={notFoundMessage} /> : children}
    </div>
  </div>
);
```

(use the actual prop names from the file: `backTo`/`backLabel`/`notFound`/`notFoundMessage`/`children` — confirm by reading.)

- [ ] **Step 3: Verify** `pnpm -C apps/web typecheck` green.
- [ ] **Step 4: Commit** `git commit -am "fix(web): cap detail-page content at a reading width (--content-detail)"`

---

## Task 3: Settings rows wrap cleanly

**Files:** `features/console/PlatformSettingsPage.tsx`.

- [ ] **Step 1:** Read the `SettingRow` (≈ lines 124-217). The right editor panel uses a fixed `width: 260`. Change it to `flex: '1 1 260px'` (so it grows to full width when it wraps below the left panel). Keep the left panel `flex: 1, minWidth: 220`.
- [ ] **Step 2: Verify** `pnpm -C apps/web typecheck` green; preview a settings row at a narrow width — the editor stacks full-width rather than wrapping mid-row.
- [ ] **Step 3: Commit** `git commit -am "fix(web): settings editor stacks full-width when the row wraps"`

---

## Task 4: Neutral PillTone + migrate non-status chips

**Files:** `components/ui/Pill.tsx` (+ `Pill.test.tsx`), `features/console/RelayTracesPage.tsx`, `AuditLogPage.tsx`, `PlatformSettingsPage.tsx`.

- [ ] **Step 1: Write the failing test** — `apps/web/src/components/ui/Pill.test.tsx` (create or append)

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Pill } from './Pill';

describe('Pill neutral tone', () => {
  it('renders a neutral chip in the muted colour', () => {
    render(<Pill tone="neutral">canary</Pill>);
    const el = screen.getByText('canary');
    expect(el).toHaveStyle({ color: 'var(--muted)' });
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `pnpm -C apps/web test src/components/ui/Pill.test.tsx` → FAIL (`'neutral'` not assignable to PillTone).
- [ ] **Step 3:** `Pill.tsx` — add `neutral` to the union + map:

```tsx
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

- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Migrate chips** — grep `tone="run"` and `tone={'run'}`; change the **non-status** ones to `neutral`:
  - `RelayTracesPage.tsx` route-tag chip (`<Pill tone="run">{r.route_tag}</Pill>`) → `tone="neutral"`.
  - `AuditLogPage.tsx` target-id filter chip → `tone="neutral"`.
  - `PlatformSettingsPage.tsx:149` override marker `tone={isOverride ? 'run' : 'idle'}` → `tone={isOverride ? 'neutral' : 'idle'}`.
    Leave `TraceViewer.tsx` stream indicator and `StatusBadge` `running` on `run`.
- [ ] **Step 6: Verify** `pnpm -C apps/web typecheck` green.
- [ ] **Step 7: Commit** `git commit -am "feat(web): neutral PillTone; move non-status chips off the amber run tone"`

---

## Task 5: Sparkline a11y

**Files:** `features/console/StatusPage.tsx`, `i18n/locales/{zh-CN,en}/console.json`.

- [ ] **Step 1:** Add i18n key `status.sparkAria` to both locale files, e.g. zh-CN: `"sparkAria": "近 {{days}} 天：{{ok}} 天正常，{{err}} 天有错误"`; en: `"sparkAria": "Last {{days}} days: {{ok}} ok, {{err}} with errors"` (nest under the existing `status` object).
- [ ] **Step 2:** In `StatusPage.tsx` `Sparkline` (≈ 240-271), compute counts + wrap the bar container with `role="img"` + `aria-label`:

```tsx
  const okDays = history.filter((b) => b.total > 0 && b.errors === 0).length;
  const errDays = history.filter((b) => b.errors > 0).length;
  return (
    <div
      role="img"
      aria-label={t('status.sparkAria', { days: history.length, ok: okDays, err: errDays })}
      style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height: 28 }}
    >
      {/* per-bar divs unchanged (keep the title attr) */}
```

- [ ] **Step 3: Verify** `pnpm -C apps/web typecheck` green; the sparkline node exposes `role="img"` + a non-empty label.
- [ ] **Step 4: Commit** `git commit -am "fix(web): uptime sparkline announces a role=img aria summary"`

---

## Task 6: Plugin test label + caution colour

**Files:** `features/console/PluginsPage.tsx`, `features/console/OverviewPage.tsx`, `i18n/locales/{zh-CN,en}/console.json`.

- [ ] **Step 1:** Add i18n keys `plugins.testOk` / `plugins.testError` to both locales (zh-CN: `"testOk": "测试通过"`, `"testError": "测试失败"`; en: `"testOk": "Test passed"`, `"testError": "Test failed"`).
- [ ] **Step 2:** In `PluginsPage.tsx` (≈ 382-394), import `StatusBadge` (`from '../../components/data/StatusBadge'`) if not present, and render it above the `<pre>`:

```tsx
{
  testOut !== null && (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
      <StatusBadge
        tone={testOut.ok ? 'ok' : 'fail'}
        label={t(testOut.ok ? 'plugins.testOk' : 'plugins.testError')}
      />
      <pre
        className="mono"
        style={
          {
            /* existing styles */
          }
        }
      >
        {testOut.ok ? JSON.stringify(testOut.result, null, 2) : testOut.error}
      </pre>
    </div>
  );
}
```

(preserve the existing `<pre>` styles.)

- [ ] **Step 3:** In `OverviewPage.tsx:220-221`, change the caution colour `rate >= 95 ? 'var(--warn, var(--accent))'` → `rate >= 95 ? 'var(--wait)'`.
- [ ] **Step 4: Verify** `pnpm -C apps/web typecheck` green.
- [ ] **Step 5: Commit** `git commit -am "fix(web): plugin test result shows an OK/Error badge; caution band uses --wait"`

---

## Task 7: `--faint` contrast spot-fix

**Files:** `features/console/StatusPage.tsx`, `features/auth/AuthPage.tsx`.

- [ ] **Step 1:** Spot-check (via the preview inspector, Task 8) the two flagged glass-sitting captions: `StatusPage.tsx:244` no-history caption and `AuthPage.tsx:120-124` micro eyebrow on `.glass`. Where the contrast fails WCAG AA (caption/micro `--faint` on translucent), change that specific `color: 'var(--faint)'` → `color: 'var(--muted)'`. Do NOT change other `--faint` uses or the token.
- [ ] **Step 2: Verify** `pnpm -C apps/web typecheck` green; both themes legible.
- [ ] **Step 3: Commit** `git commit -am "fix(web): bump --faint→--muted on the two low-contrast glass captions"`

---

## Task 8: Full verification

- [ ] **Step 1:** `pnpm -C apps/web typecheck` → green.
- [ ] **Step 2:** `pnpm -C apps/web lint` → green.
- [ ] **Step 3:** `pnpm -C apps/web test` → green (existing + new Pill neutral test).
- [ ] **Step 4:** `pnpm -C apps/web build` → succeeds.
- [ ] **Step 5:** Preview smoke: resize to ~860px (mobile layout: BottomTabs + full-width content), ~1000px (Rail+SubNav); open a detail page (content capped ~960px, centred); confirm the sparkline `role="img"` + the plugin test badge render; check both themes; zero console errors.

---

## Self-review

- **Spec coverage:** §3.1 chrome → T1; §3.2 detail → T2; §3.3 auth → T1; §3.4 settings → T3; §4.1 neutral tone → T4; §4.2 sparkline → T5; §4.3 plugin → T6; §4.4 caution → T6; §4.5 faint → T7; §5 i18n → T5/T6; §6 testing → each task + T8. Covered.
- **Type consistency:** `PillTone` adds `'neutral'` everywhere it's referenced; `StatusBadge` tone `'ok'|'fail'`; `--content-detail` token used in T2 only.
- **Resolve-at-implementation (explicit):** DetailScaffold prop names (T2.2), the exact PlatformSettings right-panel style (T3.1), the precise non-status chip lines (T4.5 grep), AA pass/fail on the two faint spots (T7.1 inspector). Each has a read/grep/inspect step.
