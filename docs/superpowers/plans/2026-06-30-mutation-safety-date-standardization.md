# Phase 3 — Mutation Safety + Date Standardization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every apply-on-change write safe (disable-while-pending, commit-on-blur, pending affordance) and standardize two stray date inputs onto the themed `DateField` — behaviour-preserving except the intended safety fixes.

**Architecture:** Small additive props on three primitives (`Select`/`SelectField` `disabled`, `NumberField` `onBlur`; `RowAction.loading` already exists), then wire the existing `isPending` pattern into 6 call-sites. Date thread adds a `lib/date.ts` helper and swaps two inputs to `DateField`.

**Tech Stack:** React 19 + TS, vitest + @testing-library/react, Vite.

**Spec:** `docs/superpowers/specs/2026-06-30-mutation-safety-date-standardization-design.md`

**Branch:** `feat/console-mutation-safety-dates` (stacked on Phase 2 `feat/shared-primitive-extraction`).

**Verification:** `pnpm -C apps/web test <file>` per unit test; `pnpm -C apps/web typecheck` after each task; final task runs full suite + build.

**Note (correction to spec §5):** `RowAction` ALREADY has `loading?: boolean` — Proxies just needs wiring (Task 6), no primitive change.

---

## File map

| File                                                                                             | Change                                                      | Task |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- | ---- |
| `components/ui/Select.tsx`                                                                       | add `disabled` (trigger button)                             | 1    |
| `components/ui/SelectField.tsx`                                                                  | forward `disabled`                                          | 1    |
| `components/ui/NumberField.tsx`                                                                  | add `onBlur`                                                | 1    |
| `features/console/RouteGroupsPage.tsx`                                                           | `ChannelMemberRow`: local state + commit-on-blur + disabled | 2    |
| `features/console/{TenantDetailPage,ApiKeyDetailPage,SubjectDetailPanel,ResourceDetailPane}.tsx` | `disabled={mutation.isPending}` on binding selects          | 3    |
| `features/console/ProxiesPage.tsx`                                                               | `loading={probe.isPending && probe.variables?.id===r.id}`   | 4    |
| `lib/date.ts` (new)                                                                              | `isoMidnight` helper                                        | 5    |
| `features/console/RedemptionCodesPage.tsx`                                                       | TextField+toIso → DateField                                 | 6    |
| `features/console/ServiceTokensPage.tsx`                                                         | native datetime-local → DateField                           | 7    |

---

## Task 1: Primitive props — `Select`/`SelectField` disabled + `NumberField` onBlur

**Files:** Modify `components/ui/Select.tsx`, `SelectField.tsx`, `NumberField.tsx`; Test `components/ui/SelectField.test.tsx` (new).

- [ ] **Step 1: Write the failing test** — `apps/web/src/components/ui/SelectField.test.tsx`

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SelectField } from './SelectField';

const opts = [
  { value: 'a', label: 'Apple' },
  { value: 'b', label: 'Banana' },
];

describe('SelectField disabled', () => {
  it('does not open or change when disabled', () => {
    const onChange = vi.fn();
    render(<SelectField label="Fruit" value="a" onChange={onChange} options={opts} disabled />);
    const trigger = screen.getByRole('button', { name: 'Fruit' });
    expect(trigger).toBeDisabled();
    fireEvent.click(trigger);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `pnpm -C apps/web test src/components/ui/SelectField.test.tsx` → FAIL (`disabled` not a prop; trigger not disabled).

- [ ] **Step 3a: `Select.tsx`** — add `disabled` to the props type (after `id`):

```tsx
  id,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Option[];
  placeholder?: string;
  ariaLabel?: string;
  ariaInvalid?: boolean;
  ariaDescribedby?: string;
  id?: string;
  disabled?: boolean;
}) {
```

Then on the trigger `<button>` (around line 162) add `disabled={disabled}` and dim it. Change the button's opening + style:

```tsx
      <button
        ref={btnRef}
        id={id}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
```

and in its `style={{ … }}` change `cursor: 'pointer',` → `cursor: disabled === true ? 'not-allowed' : 'pointer',` and add `opacity: disabled === true ? 0.55 : undefined,`. (The native `disabled` attribute already blocks `onClick`/`onKeyDown`, so no guard logic is needed.)

- [ ] **Step 3b: `SelectField.tsx`** — add `disabled` to the props type + forward to `Select`:

```tsx
  tooltip,
  inline,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Option[];
  placeholder?: string;
  error?: string;
  hint?: string;
  tooltip?: string;
  inline?: boolean;
  disabled?: boolean;
}) {
```

and on `<Select … >` add `disabled={disabled}`.

- [ ] **Step 3c: `NumberField.tsx`** — add `onBlur` to props + the input:

```tsx
  disabled,
  id,
  onBlur,
}: {
  …
  disabled?: boolean;
  id?: string;
  onBlur?: () => void;
}) {
```

and on `<input … onChange={…}` add `onBlur={onBlur}`.

- [ ] **Step 4: Run, expect PASS** — `pnpm -C apps/web test src/components/ui/SelectField.test.tsx` → PASS.

- [ ] **Step 5: Verify** — `pnpm -C apps/web typecheck` green.

- [ ] **Step 6: Commit** — `git commit -am "feat(web): Select/SelectField disabled + NumberField onBlur"` (lowercase subject — commitlint rejects PascalCase-leading).

---

## Task 2: RouteGroups channel row — commit-on-blur (kills per-keystroke PUT)

**Files:** Modify `features/console/RouteGroupsPage.tsx`.

The `GroupChannelsDrawer` maps members `m` and fires `upsert.mutate` from each NumberField `onChange` (lines ≈555-577). Extract a `ChannelMemberRow` that mirrors priority/weight locally and commits on blur.

- [ ] **Step 1:** Add a `ChannelMemberRow` component near `GroupChannelsDrawer` (file-local; `m` type is the member row, `upsert` is the existing mutation passed down). It mirrors the JSX of the current row (label + remove Button + the two NumberFields) but with local state + blur-commit:

```tsx
function ChannelMemberRow({
  m,
  label,
  upsert,
  remove,
  t,
}: {
  m: { channel_id: string; priority: number; weight: number };
  label: string;
  upsert: {
    mutate: (v: { channelId: string; priority: number; weight: number }) => void;
    isPending: boolean;
    variables?: { channelId: string };
  };
  remove: { mutate: (channelId: string) => void };
  t: (k: string) => string;
}) {
  const [priority, setPriority] = useState(m.priority);
  const [weight, setWeight] = useState(m.weight);
  // Re-sync when the server row changes (refetch after a save / external edit).
  useEffect(() => {
    setPriority(m.priority);
    setWeight(m.weight);
  }, [m.priority, m.weight]);

  const pending = upsert.isPending && upsert.variables?.channelId === m.channel_id;
  const commit = (next: { priority: number; weight: number }) => {
    if (next.priority === m.priority && next.weight === m.weight) return;
    upsert.mutate({ channelId: m.channel_id, priority: next.priority, weight: next.weight });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--s-2)',
        }}
      >
        <strong style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {label}
        </strong>
        <Button variant="ghost" size="sm" onClick={() => remove.mutate(m.channel_id)}>
          <TrashIcon size={14} weight="bold" /> {t('groups.channels.remove')}
        </Button>
      </div>
      <div style={{ display: 'flex', gap: 'var(--s-3)' }}>
        <div style={{ flex: 1 }}>
          <NumberField
            label={t('groups.channels.cols.priority')}
            hint={t('groups.channels.priorityHint')}
            value={priority}
            onChange={setPriority}
            onBlur={() => commit({ priority, weight })}
            disabled={pending}
            min={0}
            step={10}
          />
        </div>
        <div style={{ flex: 1 }}>
          <NumberField
            label={t('groups.channels.cols.weight')}
            hint={t('groups.channels.weightHint')}
            value={weight}
            onChange={setWeight}
            onBlur={() => commit({ priority, weight })}
            disabled={pending}
            min={0}
            step={10}
          />
        </div>
      </div>
    </div>
  );
}
```

(Verify the outer per-row wrapper `style` matches the original; the original wrapper had `display:flex;flexDirection:column;gap:var(--s-2)` — keep whatever the original used. Confirm `useState`/`useEffect` are imported in RouteGroupsPage.)

- [ ] **Step 2:** Replace the inline `.map((m) => (<div>…priority/weight…</div>))` body with:

```tsx
{
  members.map((m) => (
    <ChannelMemberRow
      key={m.channel_id}
      m={m}
      label={rosterLabel(m.channel_id)}
      upsert={upsert}
      remove={remove}
      t={t}
    />
  ));
}
```

(use the actual members-array variable name from the file; `rosterLabel`, `upsert`, `remove`, `t` are already in scope of `GroupChannelsDrawer` — pass them down.)

- [ ] **Step 3: Verify** — `pnpm -C apps/web typecheck` green. Manually reason: typing in priority now only updates local state; the PUT fires once on blur. `pnpm -C apps/web test src/features/console/RouteGroupsPage` if a test exists.

- [ ] **Step 4: Commit** — `git commit -am "fix(web): route-group channel priority/weight commit on blur (no per-keystroke PUT)"`

---

## Task 3: Binding selects — disable while pending

**Files:** Modify `TenantDetailPage.tsx`, `ApiKeyDetailPage.tsx`, `SubjectDetailPanel.tsx`, `ResourceDetailPane.tsx`.

For each binding `SelectField` that mutates on change, add `disabled={mutation.isPending}`.

- [ ] **Step 1:** `TenantDetailPage.tsx` (the `bindPlan` SelectField, ≈ line 553): add `disabled={bindPlan.isPending}` to that `<SelectField … />`.
- [ ] **Step 2:** `ApiKeyDetailPage.tsx` (≈ lines 196, 204): add `disabled={bindGroup.isPending}` to the route-group SelectField and `disabled={bindPlan.isPending}` to the limit-plan SelectField.
- [ ] **Step 3:** `SubjectDetailPanel.tsx` (≈ line 176): add `disabled={bindPlan.isPending}` to the `bindPlan` SelectField.
- [ ] **Step 4:** `ResourceDetailPane.tsx` (≈ line 514): add `disabled={setResourceStatus.isPending}` to the status SelectField.
- [ ] **Step 5: Verify** — `pnpm -C apps/web typecheck` green. (Grep each file for the mutation name to confirm the `isPending` field exists on the `useMutation` result.)
- [ ] **Step 6: Commit** — `git commit -am "fix(web): disable binding selects while the bind mutation is pending"`

---

## Task 4: Proxies probe — pending affordance

**Files:** Modify `features/console/ProxiesPage.tsx`.

- [ ] **Step 1:** At the probe `RowAction` (≈ line 149) wire the existing `loading` prop:

```tsx
<RowAction
  icon={GlobeIcon}
  label={t('proxies.probe')}
  loading={probe.isPending && probe.variables?.id === r.id}
  onClick={() => probe.mutate(r)}
/>
```

(Confirm `probe.mutate(r)` passes the row whose `.id` matches; if the variable is the row's id rather than the row, adjust the comparison accordingly.)

- [ ] **Step 2: Verify** — `pnpm -C apps/web typecheck` green.
- [ ] **Step 3: Commit** — `git commit -am "fix(web): show pending state on the proxy health-probe row action"`

---

## Task 5: `lib/date.ts` — `isoMidnight` helper

**Files:** Create `lib/date.ts` + `lib/date.test.ts`.

- [ ] **Step 1: Write the failing test** — `apps/web/src/lib/date.test.ts`

```ts
import { describe, expect, it } from 'vitest';

import { isoMidnight } from './date';

describe('isoMidnight', () => {
  it('converts YYYY-MM-DD to an ISO UTC-midnight instant', () => {
    expect(isoMidnight('2026-06-30')).toBe('2026-06-30T00:00:00.000Z');
  });
  it('passes non-date strings through unchanged', () => {
    expect(isoMidnight('')).toBe('');
    expect(isoMidnight('whatever')).toBe('whatever');
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — module not found.

- [ ] **Step 3: Create `apps/web/src/lib/date.ts`**

```ts
/** A YYYY-MM-DD date → an ISO-8601 instant at UTC midnight; non-date strings pass through. */
export function isoMidnight(yyyymmdd: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(yyyymmdd) ? `${yyyymmdd}T00:00:00.000Z` : yyyymmdd;
}
```

- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(web): isoMidnight date helper (lib/date.ts)"`

---

## Task 6: RedemptionCodes — DateField

**Files:** Modify `features/console/RedemptionCodesPage.tsx`.

- [ ] **Step 1:** Delete the local `toIso` function (lines 24-27) and its usage; import the helper + DateField:
      `import { DateField } from '../../components/ui/DateField';` and `import { isoMidnight } from '../../lib/date';`.
- [ ] **Step 2:** In the create body builder, replace `body.expiresAt = toIso(expiresAt.trim())` with `body.expiresAt = isoMidnight(expiresAt.trim())`.
- [ ] **Step 3:** Replace the expiry `<TextField label=… hint=… value={expiresAt} onChange={setExpiresAt} />` with a labelled DateField:

```tsx
<FormField label={t('redemptionCodes.form.expiresAt')} hint={t('redemptionCodes.form.expiresHint')}>
  <DateField
    value={expiresAt}
    onChange={setExpiresAt}
    ariaLabel={t('redemptionCodes.form.expiresAt')}
    placeholder={t('redemptionCodes.form.expiresAt')}
  />
</FormField>
```

(import `FormField` from `'../../components/ui/FormField'` if not already; if `TextField` is now unused, drop its import — `pnpm typecheck` will flag it.)

- [ ] **Step 4: Verify** — `pnpm -C apps/web typecheck` green; `pnpm -C apps/web test src/features/console/RedemptionCodesPage` if a test exists (update assertions on the old input).
- [ ] **Step 5: Commit** — `git commit -am "refactor(web): redemption-code expiry uses themed DateField"`

---

## Task 7: ServiceTokens — DateField (date-only)

**Files:** Modify `features/console/ServiceTokensPage.tsx`.

- [ ] **Step 1:** Imports: add `import { DateField } from '../../components/ui/DateField';`, `import { FormField } from '../../components/ui/FormField';`, `import { isoMidnight } from '../../lib/date';`. The `expiresAt` state stays a string but now holds `YYYY-MM-DD` (update the `// datetime-local string` comment).
- [ ] **Step 2:** In the create mutation body, change `expiresAt: expiresAt.trim() === '' ? undefined : new Date(expiresAt).toISOString()` to `expiresAt: expiresAt.trim() === '' ? undefined : isoMidnight(expiresAt.trim())`.
- [ ] **Step 3:** Replace the native input block (lines ≈149-159):

```tsx
<label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-1)' }}>
  <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
    {t('tokens.form.expiresAt')}
  </span>
  <input
    type="datetime-local"
    value={expiresAt}
    onChange={(e) => setExpiresAt(e.target.value)}
    style={FIELD_INPUT_BASE}
  />
</label>
```

with:

```tsx
<FormField label={t('tokens.form.expiresAt')}>
  <DateField
    value={expiresAt}
    onChange={setExpiresAt}
    ariaLabel={t('tokens.form.expiresAt')}
    placeholder={t('tokens.never')}
  />
</FormField>
```

Drop the now-unused `FIELD_INPUT_BASE` import (typecheck will flag if it lingers).

- [ ] **Step 4: Verify** — `pnpm -C apps/web typecheck` green; update `src/features/console/ServiceTokensPage.test.tsx` if it asserts on the old `datetime-local` input.
- [ ] **Step 5: Commit** — `git commit -am "refactor(web): service-token expiry uses themed DateField (date-only)"`

---

## Task 8: Full verification

- [ ] **Step 1:** `pnpm -C apps/web typecheck` → green.
- [ ] **Step 2:** `pnpm -C apps/web lint` → green.
- [ ] **Step 3:** `pnpm -C apps/web test` → green (existing + new SelectField/date tests; updated ServiceTokens/RedemptionCodes tests).
- [ ] **Step 4:** `pnpm -C apps/web build` → succeeds.
- [ ] **Step 5:** Preview smoke (optional): open `/console/groups` channel drawer — typing priority no longer fires a request per keystroke (commits on blur); a binding select disables briefly while saving; the proxy probe shows a spinner. Confirm zero console errors.

---

## Self-review

- **Spec coverage:** §3.1 selects → Task 3; §3.2 number fields → Task 2 (+ NumberField.onBlur in Task 1); §3.3 row action → Task 4; §4.1 helper → Task 5; §4.2 RedemptionCodes → Task 6; §4.3 ServiceTokens → Task 7; §5 primitives → Task 1 (RowAction already had loading); §6 testing → each task + Task 8. Covered.
- **Type consistency:** `disabled?: boolean` on Select/SelectField; `onBlur?: () => void` on NumberField; `loading` on RowAction (pre-existing); `isoMidnight(string): string`; mutation `.isPending`/`.variables` used consistently.
- **Resolve-at-implementation (explicit):** exact members-array var name + per-row wrapper style in RouteGroups (Task 2.1/2.2); whether `probe.variables` is the row or its id (Task 4.1); whether call-sites already import `FormField`/drop `TextField`/`FIELD_INPUT_BASE` (Tasks 6/7 — typecheck flags). Each has a concrete verify step.
