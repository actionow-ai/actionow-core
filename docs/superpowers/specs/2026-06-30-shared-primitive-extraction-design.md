# Phase 2 — 共享原子抽取(去重)

**Date:** 2026-06-30
**Status:** Design approved, pending spec review
**Scope:** `apps/web` (frontend only). Phase 2 of the 5-phase frontend-quality program.
**Branch:** `feat/shared-primitive-extraction`, **stacked on Phase 1** (`feat/liquid-glass-material-tokens`, PR #75) because both touch `EntityCard`. Rebase onto `main` after #75 merges.

---

## 1. Background

The 2026-06-30 design audit's **systemic theme #3**: several genuinely-shared affordances are
copy-pasted with drift instead of factored into one component — the one-time secret-reveal modal
exists 3× with divergent warning colors/labels; copy buttons exist with one i18n'd and one
hardcoded-English; the admin-only gate is hand-rolled 3× alongside an existing `AdminOnlyNote`
component; `useDebounced` is duplicated verbatim; a panel inline-style object is copied across detail
pages; and a label/value meta cell is reimplemented. This phase extracts each into a single shared
unit so behaviour and styling can't drift, folding in two real bug-fixes along the way.

This phase carries **no new features** and is intended to be behaviour-preserving except for two
deliberate fixes (ChatContent copy button i18n; unified secret-reveal warning colour).

---

## 2. Goals / non-goals

### Goals

- Extract six duplicated patterns into single shared units, each independently testable.
- Migrate every existing call-site to the shared unit; delete the duplicates.
- Fold in the two bug-fixes the duplication was hiding.
- Zero behaviour change otherwise; green typecheck/lint/tests/build.

### Non-goals

- No new features.
- Do **not** touch the table summary template-strings in FaultPolicies/LimitPlans/RouteGroups
  (they are i18n whole-strings, not label/value pairs — not the MetaCell pattern).
- Do **not** rewrite `CopyField` internals (it is a distinct value-pill UX, kept as-is).
- Phases 3–5.

---

## 3. The six units

### 3.1 `useDebounced` → `lib/useDebounced.ts`

Verbatim-identical hook currently in `features/console/AuditLogPage.tsx:21-37` and
`features/console/RelayTracesPage.tsx:47-67`.

**Signature (unchanged):**

```ts
function useDebounced(
  value: string,
  commit: (v: string) => void,
  delay?: number, // default 350
): [string, (v: string) => void];
```

Move to `lib/useDebounced.ts` (joins the existing `lib/` hooks: `useMediaQuery`, `useUrlState`,
`useFocusTrap`). Both pages import it; delete the two local definitions.

### 3.2 `CopyButton` → `components/ui/CopyButton.tsx` (new)

An **icon-only** click-to-copy button. Replaces `ChatContent.CopyButton`
(`features/app/playground/ChatContent.tsx:80-97`, **hardcoded English** — the bug) and
`ChatMessage.CopyBtn` (`features/app/playground/ChatMessage.tsx:219-236`).

**API:**

```tsx
function CopyButton(props: {
  value: string;
  size?: number; // default 14
  bare?: boolean; // default true
  label?: string; // default t('common.copy')
  copiedLabel?: string; // default t('common.copied')
  failedLabel?: string; // default t('common.copyFailed')
}): JSX.Element;
```

- Uses `IconButton` (Copy → Check icon on success).
- **Adds error handling + timer cleanup** the playground copies lack: `try/await clipboard …
catch → failed`, `useEffect(() => () => clearTimeout(timer))`, ~1500ms reset.
- i18n via `useTranslation('console')` (the `common.*` keys already exist).
- `CopyField` (`components/data/CopyField.tsx`) is **unchanged** — different UX (value pill).

### 3.3 `SecretRevealModal` → `components/ui/SecretRevealModal.tsx` (new)

The one-time "copy your new secret now" modal. Replaces the 3 instances:
`ApiKeysPage.tsx:267-287`, `ServiceTokensPage.tsx:162-186`, `RedemptionCodesPage.tsx:195-215`.

**API:**

```tsx
function SecretRevealModal(props: {
  open: boolean;
  title: string;
  onClose: () => void;
  value: string | string[]; // string[] joined with '\n' (redemption codes)
  warn: string; // warning line text (caller-supplied, i18n'd)
  copyLabel: string;
  copiedLabel: string;
  failedLabel?: string;
  doneLabel: string; // footer button label
}): JSX.Element;
```

- Renders `Modal` (title/onClose) + a warning line + `CopyField` + a footer `Button variant="cta"`
  that calls `onClose`.
- **Standardizes the warning colour to `var(--warn)`** (today: `--run` in ApiKeys/RedemptionCodes,
  `--fail` in ServiceTokens — `--warn` is the semantic caution token, value matches `--run`).
- Callers keep their own i18n keys (passed as props); `value` accepts the array for redemption codes.

### 3.4 `AdminOnlyNote` extended (banner | page)

Extend the existing `features/app/AdminOnlyNote.tsx` (today zero-prop banner: info icon + `app.adminOnly`).

**New API:**

```tsx
function AdminOnlyNote(props: {
  variant?: 'banner' | 'page'; // default 'banner' (current behaviour)
  message?: string; // default t('app.adminOnly')
}): JSX.Element;
```

- `banner` (default): the current inline `role="note"` icon + text. AppKeys usage unchanged.
- `page`: the centered full-page note (`padding var(--s-5)`, `text-align center`, `--muted`,
  `--fs-sm`) currently hand-rolled in `AppSubjects.tsx:142-158`, `AppLimitPlans.tsx:150-166`,
  `MembersPage.tsx:148-166`.
- Migrate the 3 guards to:
  ```tsx
  if (!isTenantAdmin)
    return roleLoading ? null : (
      <AdminOnlyNote variant="page" message={t('app.subjects.adminOnly')} />
    );
  ```
  (per-page messages preserved via `message`; the `roleLoading ? null` flash-guard stays at the call-site).

### 3.5 `Panel` → `components/ui/Panel.tsx` (new)

A `className="panel"` vertical-stack container that bakes in the repeated inline
`{borderRadius: var(--r-md), display:flex, flexDirection:column, gap, padding}`.

**API:**

```tsx
function Panel(props: {
  children: ReactNode;
  gap?: string; // default 'var(--s-3)'
  padding?: string; // default 'var(--s-4)'
  maxWidth?: number | string;
  className?: string; // appended after 'panel'
  style?: CSSProperties; // escape hatch, spread last
}): JSX.Element;
```

Migrate: `SubjectDetailPanel.tsx` (drop its module-level `const panel`),
`ApiKeyDetailPage.tsx:189-217` (`maxWidth: 360`, `gap: var(--s-4)`),
`AppLimitPlans.tsx:426-434` (rule panel: `padding: var(--s-3)`, `gap: var(--s-2)`), and the other
copies found during implementation. `.panel` CSS class itself (in `glass.css`) is unchanged.

### 3.6 `MetaCell` → `components/data/MetaCell.tsx` (new, label/value only)

The uppercase-caption label + tabular value cell.

**API:**

```tsx
function MetaCell(props: {
  label: string;
  value: ReactNode;
  nowrap?: boolean; // default true
}): JSX.Element;
```

- Markup = EntityCard's current meta cell: label (`--fs-caption`, uppercase, `.06em`, `--faint`) +
  value (`.tabular`, `--fs-sm`, `--text`, `marginTop var(--s-0)`, `white-space: nowrap` when `nowrap`).
- `EntityCard.tsx` meta map delegates to `<MetaCell>` (keep the `CardMeta {label,value}` interface).
- Detail-page hand-rolled label/value definition rows reuse it (enumerated in the plan).
- **Table template-string cells are NOT touched.**

---

## 4. Where things live (existing conventions)

- Hooks → `lib/` (named export). UI primitives → `components/ui/`. Data/domain → `components/data/`.
- All named exports; no barrel index; co-located `*.test.tsx`.
- i18n via `useTranslation('console')` (or `()` for `common`). Keys already exist for `common.copy*`.

---

## 5. Testing

- New focused vitest + RTL tests: `CopyButton` (copy success → Check + copied label; clipboard
  reject → failed label), `SecretRevealModal` (renders value, array-join, copy, done closes),
  `AdminOnlyNote` (banner vs page rendering + default/explicit message), `Panel` (default + override
  props applied, `panel` class present), `MetaCell` (label/value render, nowrap toggle),
  `useDebounced` (debounce timing with fake timers; value-prop resync).
- Existing page tests (`ApiKeysPage.test`, `ServiceTokensPage.test`, etc.) + `vite build` catch
  call-site regressions; update only intended snapshot diffs.
- Acceptance: typecheck + lint + full vitest + `vite build` green; only behaviour changes are the
  two folded bug-fixes (§3.2 i18n, §3.3 unified `--warn`).

---

## 6. Risks & mitigations

| Risk                                                               | Mitigation                                                                                         |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Call-site migration changes behaviour subtly                       | Behaviour-preserving extraction; per-component unit test; page tests + build.                      |
| `AdminOnlyNote` default `variant='banner'` must not change AppKeys | Default = current behaviour; only the 3 page-guards opt into `variant='page'`.                     |
| `Panel` default gap/padding differs from a call-site's value       | Every migrated call-site passes its exact `gap`/`padding`/`maxWidth`; defaults only for new uses.  |
| Stacked on unmerged Phase 1 (#75)                                  | Branch off Phase 1; rebase to `main` after #75 merges. EntityCard edits coordinate with Phase 1's. |
| `--warn` vs `--run` value identical today                          | `--warn` is the semantic name; value parity means zero visual change, just intent-correct.         |

---

## 7. Out of scope (restated)

Table summary template-strings; `CopyField` internals; any new feature; Phases 3–5.
