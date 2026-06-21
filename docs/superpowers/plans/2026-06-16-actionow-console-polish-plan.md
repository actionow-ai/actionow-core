# Console Layout & Design-System Polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Fix the highest-leverage findings from the 4-agent design audit — the operator console wastes vertical space and over-stretches on wide screens, there's no type scale, a duplicate StatusBadge, modals overflow on phones, and the auth CTA is hand-rolled.

**Architecture:** Add design tokens (type scale + glow + content width), upgrade the shared `DataTable` (fill height, readable type, per-column widths, mobile stacked cards), cap + center console content and replace the lonely "New" button with a real page-header toolbar, make `Modal` scroll, and route the auth submit through `Button`. Tokens land first so later tasks consume them.

**Tech Stack:** React 19 + TS, inline styles + CSS vars, vitest, browser verification against the real API on `:3000`. Worktree `/Users/alienworm/actionow-web`, branch `feat/admin-frontend`. Run `pnpm --filter @actionow/web <typecheck|lint|build|test>`.

**Out of scope (documented backlog, later round):** full sweep of all 28 ad-hoc font sizes; unify the 768/880/960/Tailwind-md breakpoints + `env(safe-area-inset-*)`; landing container-width token + FeaturePan heading centering + pricing card width; extract `<ListCreatePage>`/`<AccentChip>`/`<IconButton>`/`<SegmentedControl>`; unify the three field components; apply `--shadow-cta`/`--glow-accent` to all 7 call sites.

---

## Task 1: Design tokens (type scale, glow, content width, faint contrast)

**Files:** Modify `apps/web/src/styles/theme.css`

- [ ] **Step 1:** In the `:root` block, after the `--r-*` radii line, add:

```css
/* type scale */
--fs-caption: 11px;
--fs-sm: 13px;
--fs-base: 15px;
--fs-lg: 18px;
--fs-h2: clamp(26px, 3.4vw, 40px);
--fs-h1: clamp(28px, 3.4vw, 46px);
--fs-display: clamp(40px, 8vw, 104px);
--fw-medium: 600;
--fw-semibold: 700;
--fw-bold: 800;
--track-tight: -0.03em;
--track-snug: -0.015em;
/* layout + accent fx */
--content-max: 1200px;
--shadow-cta: 0 6px 18px rgba(255, 176, 10, 0.4);
--glow-accent: 0 0 6px rgba(255, 176, 10, 0.35);
--log-ok: #9bdcb0;
```

- [ ] **Step 2:** Improve `--faint` contrast (it fails WCAG AA at #8f897a on #0c0b09). In the dark `:root`, change `--faint: #8f897a;` → `--faint: #a39c8b;`.

- [ ] **Step 3:** In the `[data-theme='light']` block add `--log-ok: #2f7d4f;` (a readable green on the light surface).

- [ ] **Step 4:** Verify: `pnpm --filter @actionow/web build` (CSS parses). Commit `apps/web/src/styles/theme.css` → `feat(web): design tokens — type scale, glow, content width, faint contrast`.

---

## Task 2: Consolidate the duplicate StatusBadge

There are two: `components/data/StatusBadge.tsx` (semantic TONE-map tint — the keeper) and `components/ui/StatusBadge.tsx` (gold pill, added in the catalog plan — the duplicate). Same `status="active"` renders two ways.

**Files:** Modify `apps/web/src/components/data/StatusBadge.tsx`; Delete `apps/web/src/components/ui/StatusBadge.tsx`; Modify `ResourcesPage.tsx`, `ResourceDetailPage.tsx`, `ModifiersPage.tsx`.

- [ ] **Step 1:** In `components/data/StatusBadge.tsx`, change `fontSize: 9` → `fontSize: 'var(--fs-caption)'` and `borderRadius: 12` → `borderRadius: 'var(--r-pill)'`. Keep the TONE map and the `color-mix` tint. (It already maps `active→--ok`, `disabled→--fail`, `inactive` falls through to `--idle` — fine.)

- [ ] **Step 2:** Repoint the three catalog pages' import from `../../components/ui/StatusBadge` → `../../components/data/StatusBadge`. (`ResourcesPage.tsx:13`, `ResourceDetailPage.tsx:13`, `ModifiersPage.tsx` import line.) The component's prop API (`{ status: string }`) is identical, so no call-site changes.

- [ ] **Step 3:** `rm apps/web/src/components/ui/StatusBadge.tsx`.

- [ ] **Step 4:** Verify: `pnpm --filter @actionow/web typecheck && pnpm --filter @actionow/web lint && pnpm --filter @actionow/web build` (no dangling import of the deleted file). Commit → `refactor(web): consolidate StatusBadge onto the semantic version`.

---

## Task 3: DataTable — fill height, readable type, per-column widths, mobile cards

**Files:** Modify `apps/web/src/components/data/DataTable.tsx`

Current: a `.panel` with a grid header + grid rows, `minWidth:520`, header `fontSize:9 --faint`, rows `fontSize:11.5`, content-height (doesn't fill), no responsive behavior.

- [ ] **Step 1:** Add a `fill?: boolean` prop. When `fill`, the root panel is `display:flex; flexDirection:column; height:100%` and the rows region is a separate `flex:1; minHeight:0; overflowY:auto` container (header stays pinned above it). When not `fill`, keep today's natural-height behavior.

- [ ] **Step 2:** Typography: header cells `fontSize: 'var(--fs-caption)'`, `color: 'var(--muted)'` (not `--faint`); body rows `fontSize: 'var(--fs-sm)'`, vertical padding `var(--s-3)` (12px) → keep `var(--s-4)` horizontal. Row border stays `--row-bd`.

- [ ] **Step 3:** Responsive: add `import { useMediaQuery } from '../../lib/useMediaQuery';` and `const isDesktop = useMediaQuery('(min-width: 768px)');`. When NOT desktop, render each row as a stacked label/value card instead of the grid: a `.panel`-bordered block per row where each column renders as a `label (column header) / value` line (`display:flex; justifyContent:space-between; gap`), and DROP the `minWidth:520`. The desktop branch keeps `minWidth:520` + the grid. The column header text (for the mobile labels) comes from `c.header`.

- [ ] **Step 4:** The existing `Column.width` prop is already honored (`c.width ?? '1fr'`) — leave that logic; callers will now pass widths.

- [ ] **Step 5:** Verify: `pnpm --filter @actionow/web typecheck && lint && build`. Commit → `feat(web): DataTable fills height, readable type, mobile card rows`.

---

## Task 4: PageHeader toolbar + center/cap console content + fill the canvas

**Files:** Create `apps/web/src/components/console/PageHeader.tsx`; Modify `apps/web/src/components/console/ConsoleLayout.tsx`; Modify `ResourcesPage.tsx`, `ModifiersPage.tsx`, `TenantsPage.tsx`.

- [ ] **Step 1:** Create `PageHeader.tsx`:

```tsx
import type { ReactNode } from 'react';

/** Console page header: title (+ optional count) on the left, an action on the right. */
export function PageHeader({
  title,
  count,
  action,
}: {
  title: ReactNode;
  count?: number;
  action?: ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 'var(--s-3)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--s-2)', minWidth: 0 }}>
        <h1
          style={{
            fontSize: 'var(--fs-lg)',
            fontWeight: 'var(--fw-semibold)',
            letterSpacing: 'var(--track-snug)',
            margin: 0,
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </h1>
        {count !== undefined && (
          <span className="tabular" style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
            {count}
          </span>
        )}
      </div>
      {action}
    </div>
  );
}
```

- [ ] **Step 2:** In `ConsoleLayout.tsx`, cap + center the content. The scroll area is the `<div style={{ flex:1, minHeight:0, overflow:'auto', ... }}>` wrapping `<Outlet/>` (around line 232). Put an inner wrapper around `<Outlet/>`: `<div style={{ maxWidth: 'var(--content-max)', margin: '0 auto', width: '100%', height: '100%' }}><Outlet /></div>`. This caps content on wide screens and gives pages a `height:100%` parent so `DataTable fill` can stretch.

- [ ] **Step 3:** In `ResourcesPage.tsx`: replace the lonely right-aligned button row with `<PageHeader title={t('resources.title')} count={data?.length} action={<Button variant="ghost" onClick={() => setOpen(true)}><PlusIcon size={14} weight="bold" /> {t('resources.new')}</Button>} />`. Make the page wrapper fill height: `style={{ display:'flex', flexDirection:'column', gap:'var(--s-4)', height:'100%' }}`, and pass `fill` to the `DataTable`. Give columns widths: id `minmax(160px, 1.4fr)`, modality `120px`, provider `140px`, execModes `1fr`, status `110px` (set `width` on each `Column`). Note the action button is now `variant="ghost"` (accent reserved for the modal submit).

- [ ] **Step 4:** In `ModifiersPage.tsx`: same treatment — `<PageHeader title={t('modifiers.title')} count={data?.length} action={<Button variant="ghost" ...>}/>`, wrapper `height:100%`, `DataTable fill`, column widths (scope `1fr`, op `160px`, value `100px`, priority `100px`, active `110px`).

- [ ] **Step 5:** In `TenantsPage.tsx`: same — `<PageHeader title={t('tenants.title', 'Tenants')} count={data?.length} action={<Button variant="ghost" ...>}/>`, wrapper `height:100%`, `DataTable fill`, column widths (name `1.4fr`, isolation `140px`, created `180px`). (If `tenants.title` key is missing, add `"title"` to the `tenants` block in both `console.json` locales — zh `"租户"`, en `"Tenants"`.)

- [ ] **Step 6:** Verify: `pnpm --filter @actionow/web typecheck && lint && build`. Commit → `feat(web): console page-header toolbar + centered/filled content`.

---

## Task 5: Modal — max-height + internal scroll + sticky footer

**Files:** Modify `apps/web/src/components/ui/Modal.tsx`

- [ ] **Step 1:** Make the dialog a flex column that can't exceed the viewport, with the body scrolling and the title/footer fixed. Change the dialog `<div role="dialog" ...>` style to: `{ width: 'min(440px, 92vw)', maxHeight: 'min(86dvh, 720px)', display: 'flex', flexDirection: 'column', borderRadius: 'var(--r-lg)', padding: 'var(--s-5)' }`. Change the children wrapper to `{ marginTop: 'var(--s-4)', display: 'flex', flexDirection: 'column', gap: 'var(--s-3)', overflowY: 'auto', flex: 1, minHeight: 0 }`. Leave the footer as a non-scrolling flex child (its `marginTop: 'var(--s-5)'` is fine; add `flexShrink: 0`).

- [ ] **Step 2:** Verify: `pnpm --filter @actionow/web typecheck && lint && build`. Commit → `fix(web): modal max-height + internal scroll so submit stays reachable`.

---

## Task 6: Button gains type/disabled; AuthPage submit routes through Button

**Files:** Modify `apps/web/src/components/ui/Button.tsx`; Modify `apps/web/src/features/auth/AuthPage.tsx`

- [ ] **Step 1:** In `Button.tsx`, extend `Props` with `type?: 'button' | 'submit'` and `disabled?: boolean`. In the `<button>` branch, set `type={type ?? 'button'}` and `disabled={disabled}`, and when `disabled` apply `opacity: 0.7` + `cursor: 'default'` (merge into the style). The `to`/`href` branches ignore `type`/`disabled` (anchors/links don't take them) — that's fine.

- [ ] **Step 2:** In `AuthPage.tsx`, replace the hand-rolled `<button type="submit" ... className="btn-tactile cta-shine" style={{...gradient...}}>` (around lines 181-203) with:

```tsx
<Button variant="cta" size="lg" type="submit" disabled={busy} className="cta-shine">
  {t(mode === 'login' ? 'auth.loginSubmit' : 'auth.registerSubmit')}{' '}
  <ArrowRightIcon size={16} weight="bold" />
</Button>
```

Keep everything else (the form, segmented tabs, fields) unchanged. Confirm `Button` already applies `btn-tactile` (it does) so the class on the old button isn't lost.

- [ ] **Step 3:** Verify: `pnpm --filter @actionow/web typecheck && lint && build`. Commit → `refactor(web): route auth submit through Button (type/disabled support)`.

---

## Task 7: Browser verification against the real API

**Files:** none.

- [ ] **Step 1:** Build + serve (`vite preview` proxying to `:3000`); log in as admin.
- [ ] **Step 2:** Resources/Modifiers/Tenants: confirm each now shows a page-header (title + count + ghost action), the table FILLS the canvas height (no large void below), content is centered/capped on a wide window, columns are sized (status/date narrow, id/name wide), and the status badge is the semantic tint (consistent with Dashboard).
- [ ] **Step 3:** Open a create modal with many fields (Resources) at a short window height — confirm the body scrolls and the submit button stays visible/reachable.
- [ ] **Step 4:** Resize to a phone width (~390px) — confirm DataTable rows become stacked label/value cards (no horizontal scroll), and the bottom tab bar doesn't cover the last row.
- [ ] **Step 5:** Auth page — confirm the login button looks/behaves identically (now a `Button`), disabled state while busy.
- [ ] **Step 6:** Confirm no console errors; capture screenshots of a console list (desktop + mobile) and a modal. No commit (verification only).
