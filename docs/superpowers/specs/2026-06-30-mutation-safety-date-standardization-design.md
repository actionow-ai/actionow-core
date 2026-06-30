# Phase 3 — 正确性 + 一致性:mutation 安全 + 日期标准化

**Date:** 2026-06-30
**Status:** Design approved (re-scoped after investigation), pending spec review
**Scope:** `apps/web` (frontend only). Phase 3 of the 5-phase frontend-quality program.
**Branch:** `feat/console-mutation-safety-dates`, **stacked on Phase 2** (`feat/shared-primitive-extraction`) — re-touches ApiKeyDetail/ServiceTokens/RedemptionCodes/SubjectDetailPanel. Rebase to `main` after the upstream branches merge.

---

## 1. Background & re-scope

The 2026-06-30 design audit flagged two Phase-3 items: **P0b apply-on-change mutation safety** and
**P1b detail/date standardization**. A code investigation (this session) re-scoped the latter:

- **Mutation safety (Thread A)** is the closest thing to a functional defect in the whole audit:
  controls that fire a write to **money / governance / routing** state directly from `onChange` /
  row-action `onClick`, with **no disable-while-pending** and (for one) a **PUT on every keystroke**.
  Rapid edits race; slow round-trips look unresponsive. The codebase already has the fix pattern
  (`Button.loading`, `isPending && variables.id===id` in `ModelAccessPage`, `lib/useDebounced`) — it's
  just not wired into these sites.
- **Date standardization (Thread B)** is a clean consistency win: two expiry inputs bypass the themed
  `DateField` (one native `datetime-local`, one free-text + regex).
- **Detail-pattern convergence (Thread C) — DROPPED.** The investigation found the catalog
  "redundant two-pane" (`ResourceDetailPane`, ~763 lines + `ResourcesPage` ~200) is **not redundant**:
  it's a legitimate _responsive_ two-pane (list+detail on wide, detail-replaces-list on narrow),
  distinct from the routed `/:id` pages. Retiring it is a ~960-line IA redesign for **no actual bug**.
  Out of scope (YAGNI).

---

## 2. Goals / non-goals

### Goals

- Make every apply-on-change write safe: disabled-while-pending (selects), commit-on-blur (the
  per-keystroke NumberFields), and a pending affordance (the row action). No races, no PUT-per-keystroke.
- Standardize the two stray date inputs onto the themed `DateField` (date-only), centralizing the
  `YYYY-MM-DD → ISO midnight` conversion.
- Zero feature change; green typecheck/lint/tests/build.

### Non-goals

- Thread C catalog two-pane retirement (not redundant; large).
- A `DateTimeField` (token expiry becomes date-only per decision).
- Debouncing the _selects_ (a discrete choice committing on change is correct UX — the fix is only
  to prevent overlapping in-flight writes).
- Phases 4–5.

---

## 3. Thread A — mutation safety

### 3.1 Selects: disable while pending

A `SelectField` that commits a mutation on change is fine UX (discrete choice); the only bug is that a
second change can fire while the first write is in flight. Fix: `disabled={mutation.isPending}`. Sites:

| File:line                    | Mutation            | State                       |
| ---------------------------- | ------------------- | --------------------------- |
| `TenantDetailPage.tsx:553`   | `bindPlan`          | governance (limit plan)     |
| `ApiKeyDetailPage.tsx:196`   | `bindGroup`         | routing (route group)       |
| `ApiKeyDetailPage.tsx:204`   | `bindPlan`          | governance                  |
| `SubjectDetailPanel.tsx:176` | `bindPlan`          | governance                  |
| `ResourceDetailPane.tsx:514` | `setResourceStatus` | governance (channel status) |

If `SelectField` does not already forward a `disabled` prop to the underlying trigger, **add it**
(pass through to the trigger button + visually dim + block opening). Verify against
`components/ui/SelectField.tsx` first.

### 3.2 NumberFields: commit-on-blur (kills per-keystroke PUT)

`RouteGroupsPage.tsx` `GroupChannelsDrawer` (≈ lines 555-575) fires
`upsert.mutate({ channelId, priority, weight })` from each NumberField's `onChange` — so typing "120"
sends three PUTs. Fix: hold priority/weight in **local state**, and commit a single
`upsert.mutate(...)` **on blur** (or Enter), with the field `disabled` while `upsert.isPending`.

Mechanism: a small local wrapper inside `GroupChannelsDrawer` (local `useState` per channel row mirror
of priority/weight; `onBlur` → if changed, `upsert.mutate`). If `NumberField` doesn't expose `onBlur`,
**add an optional `onBlur?: () => void`** to `components/ui/NumberField.tsx` (pass through to the
input). The local mirror re-syncs when the server row changes (mirror the `useDebounced` value-resync
idea, but commit-on-blur not on timer).

### 3.3 Row action: pending affordance

`ProxiesPage.tsx:149` `<RowAction … onClick={() => probe.mutate(r)} />` has no pending state. Fix: add
a `loading?: boolean` prop to `components/ui/RowAction.tsx` (mirror `Button.loading`: swap the icon for
a spinner / disable while loading), and wire
`loading={probe.isPending && probe.variables?.id === r.id}` at the call-site.

### 3.4 Shared convention (not a new abstraction)

No new hook — the fix is three existing-pattern applications: `disabled={m.isPending}` (selects),
local-state + commit-on-blur + `disabled` (number fields), `loading` prop (row action). This mirrors
`ModelAccessPage`'s `toggling={toggleChannel.isPending && toggleChannel.variables.id === c.id}`.

---

## 4. Thread B — date standardization

`DateField` (`components/ui/DateField.tsx`) is the themed date-only picker: `value` is `YYYY-MM-DD`,
`onChange(v)`, optional `min`/`max`/`placeholder`/`ariaLabel`; exports `parseISO`/`toISO`.

### 4.1 New helper `lib/date.ts`

```ts
/** A YYYY-MM-DD date → an ISO-8601 instant at UTC midnight; '' stays ''. */
export function isoMidnight(yyyymmdd: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(yyyymmdd) ? `${yyyymmdd}T00:00:00.000Z` : yyyymmdd;
}
```

Replaces the duplicated `toIso` in `RedemptionCodesPage` and the `new Date(expiresAt).toISOString()`
in `ServiceTokensPage`.

### 4.2 RedemptionCodesPage

Replace the free-text `TextField` (+ local `toIso`, lines 24-27) with:

```tsx
<DateField
  value={expiresAt}
  onChange={setExpiresAt}
  ariaLabel={t('redemptionCodes.form.expiresAt')}
/>
```

`expiresAt` state stays `YYYY-MM-DD` (DateField's format); the submit body uses
`isoMidnight(expiresAt.trim())` (only when non-empty — empty = never expires). Keep the field label
(via a wrapping `FormField`/label) and the hint.

### 4.3 ServiceTokensPage

Replace the native `<input type="datetime-local">` (lines 153-158) with a `<DateField>` (date-only).
Token expiry becomes **midnight-UTC of the chosen day** (acceptable for M2M tokens). State changes
from a `datetime-local` string to `YYYY-MM-DD`; the create body uses
`expiresAt.trim() === '' ? undefined : isoMidnight(expiresAt.trim())`. Drop `FIELD_INPUT_BASE` import
if now unused. The expiry-summary column (`new Date(r.expires_at).toLocaleString(...)`) is unchanged.

---

## 5. Primitive changes (small, additive)

- `SelectField`: forward `disabled` to the trigger (if absent). Behaviour-preserving when unset.
- `NumberField`: add optional `onBlur?: () => void` (if absent), passed to the input.
- `RowAction`: add optional `loading?: boolean` (spinner + disabled), mirroring `Button.loading`.
  All three are additive and default to today's behaviour — existing call-sites are unaffected.

---

## 6. Testing

- **Unit:** `RowAction` renders a spinner + is disabled when `loading`; `GroupChannelsDrawer`
  commit-on-blur fires `upsert` once on blur (not per keystroke) and is disabled while pending (test
  the wrapper logic, mocking the mutation); `isoMidnight` (valid date → ISO, empty/garbage passthrough);
  `SelectField` disabled blocks open + onChange.
- **Regression:** update `ServiceTokensPage.test` / `RedemptionCodesPage.test` for the DateField swap
  if they assert on the old inputs. Existing page tests + `vite build`.
- **Acceptance:** typecheck + lint + full vitest + `vite build` green. The only behaviour changes are
  the intended safety fixes (no per-keystroke PUT, no overlapping writes) and the date-input swap.

---

## 7. Risks & mitigations

| Risk                                                            | Mitigation                                                                                                       |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `disabled` on a select feels laggy on a fast write              | `isPending` is brief; the alternative (racing writes to governance) is worse. Optional: keep last value visible. |
| commit-on-blur changes when the write fires (blur vs keystroke) | Intended — one write per edit. Re-sync local mirror from server row so external updates aren't lost.             |
| Adding props to shared primitives                               | All additive + default to current behaviour; verify each prop exists before adding.                              |
| Token expiry loses time-of-day precision                        | Accepted per decision (M2M tokens, day granularity); midnight-UTC is unambiguous.                                |
| Stacked on unmerged Phase 1/2                                   | Branch off Phase 2; rebase after they merge.                                                                     |

---

## 8. Out of scope (restated)

Thread C catalog two-pane; `DateTimeField`; select debouncing; any new feature; Phases 4–5.
