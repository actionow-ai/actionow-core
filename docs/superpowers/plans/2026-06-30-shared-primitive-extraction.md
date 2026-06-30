# Phase 2 — Shared-Primitive Extraction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract six duplicated UI patterns in `apps/web` into single shared units, migrate every call-site, and fold in two bug-fixes — behaviour-preserving, all green.

**Architecture:** New units land in their conventional homes (`lib/` hook, `components/ui/` primitives, `components/data/` MetaCell; `AdminOnlyNote` extended in place). Each new unit is TDD'd (failing test → minimal impl → green), then call-sites migrate to it and the duplicates are deleted. No barrel index (project convention); named exports; co-located `*.test.tsx`.

**Tech Stack:** React 19 + TypeScript, vitest + @testing-library/react (jsdom), Vite. i18n: react-i18next.

**Spec:** `docs/superpowers/specs/2026-06-30-shared-primitive-extraction-design.md`

**Branch:** `feat/shared-primitive-extraction` (stacked on Phase 1 `feat/liquid-glass-material-tokens`).

**Verification per task:** `pnpm -C apps/web test <file>` for the unit test, `pnpm -C apps/web typecheck` after migrations. Final task runs the full suite + build.

---

## File map

| File                                                                                                                                                                                                            | Responsibility          | Task            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | --------------- | --- |
| `apps/web/src/lib/useDebounced.ts` (+`.test.ts`)                                                                                                                                                                | debounce hook           | 1               |
| `apps/web/src/components/ui/CopyButton.tsx` (+test)                                                                                                                                                             | icon-only copy button   | 2               |
| `apps/web/src/components/ui/SecretRevealModal.tsx` (+test)                                                                                                                                                      | one-time secret modal   | 3               |
| `apps/web/src/features/app/AdminOnlyNote.tsx` (+test)                                                                                                                                                           | banner                  | page admin gate | 4   |
| `apps/web/src/components/ui/Panel.tsx` (+test)                                                                                                                                                                  | `.panel` vertical stack | 5               |
| `apps/web/src/components/data/MetaCell.tsx` (+test)                                                                                                                                                             | label/value cell        | 6               |
| Call-sites (AuditLog, RelayTraces, ChatContent, ChatMessage, ApiKeys/ServiceTokens/RedemptionCodes pages, AppSubjects/AppLimitPlans/MembersPage, SubjectDetailPanel/ApiKeyDetailPage/AppLimitPlans, EntityCard) | migrate to shared units | 1–6             |

---

## Task 1: `useDebounced` hook → `lib/`

**Files:** Create `apps/web/src/lib/useDebounced.ts` + `apps/web/src/lib/useDebounced.test.ts`; Modify `features/console/AuditLogPage.tsx`, `features/console/RelayTracesPage.tsx`.

- [ ] **Step 1: Write the failing test** — `apps/web/src/lib/useDebounced.test.ts`

```ts
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDebounced } from './useDebounced';

describe('useDebounced', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('commits the local value after the delay, once', () => {
    const commit = vi.fn();
    const { result } = renderHook(() => useDebounced('a', commit, 300));
    act(() => result.current[1]('ab'));
    expect(commit).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(299));
    expect(commit).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(commit).toHaveBeenCalledExactlyOnceWith('ab');
  });

  it('resyncs local when the committed value prop changes', () => {
    const commit = vi.fn();
    const { result, rerender } = renderHook(({ v }) => useDebounced(v, commit, 300), {
      initialProps: { v: 'a' },
    });
    rerender({ v: 'z' });
    expect(result.current[0]).toBe('z');
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `pnpm -C apps/web test src/lib/useDebounced.test.ts` → FAIL (module not found).

- [ ] **Step 3: Create `apps/web/src/lib/useDebounced.ts`**

```ts
import { useEffect, useState } from 'react';

/** Local-mirror + debounced-commit for filter inputs: type freely, commit after `delay`.
 *  Returns [localValue, setLocalValue]; re-syncs local when the committed `value` changes. */
export function useDebounced(
  value: string,
  commit: (v: string) => void,
  delay = 350,
): [string, (v: string) => void] {
  const [local, setLocal] = useState(value);
  useEffect(() => {
    setLocal(value);
  }, [value]);
  useEffect(() => {
    if (local === value) return;
    const id = setTimeout(() => commit(local), delay);
    return () => clearTimeout(id);
  }, [local, value, commit, delay]);
  return [local, setLocal];
}
```

- [ ] **Step 4: Run, expect PASS** — `pnpm -C apps/web test src/lib/useDebounced.test.ts` → PASS.

- [ ] **Step 5: Migrate call-sites** — In `AuditLogPage.tsx` delete the local `function useDebounced(...)` (≈lines 21-37) and add `import { useDebounced } from '../../lib/useDebounced';`. Same in `RelayTracesPage.tsx` (≈lines 47-67). Verify the relative import depth (`features/console/*` → `../../lib/`).

- [ ] **Step 6: Verify** — `pnpm -C apps/web typecheck` green; `pnpm -C apps/web test src/features/console/AuditLogPage src/features/console/RelayTracesPage` green (if those tests exist; else skip).

- [ ] **Step 7: Commit** — `git commit -am "refactor(web): hoist useDebounced to lib (dedupe AuditLog/RelayTraces)"`

---

## Task 2: `CopyButton` primitive + playground migration (fixes i18n bug)

**Files:** Create `components/ui/CopyButton.tsx` + `.test.tsx`; Modify `features/app/playground/ChatContent.tsx`, `features/app/playground/ChatMessage.tsx`.

- [ ] **Step 1: Write the failing test** — `apps/web/src/components/ui/CopyButton.test.tsx`

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CopyButton } from './CopyButton';

describe('CopyButton', () => {
  it('copies the value and shows the copied label', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CopyButton value="sk-123" label="copy" copiedLabel="copied" />);
    fireEvent.click(screen.getByRole('button'));
    expect(writeText).toHaveBeenCalledWith('sk-123');
    await waitFor(() => expect(screen.getByLabelText('copied')).toBeInTheDocument());
  });

  it('shows the failed label when the clipboard rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CopyButton value="x" label="copy" failedLabel="failed" />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByLabelText('failed')).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `pnpm -C apps/web test src/components/ui/CopyButton.test.tsx` → FAIL (module not found).

- [ ] **Step 3: Create `apps/web/src/components/ui/CopyButton.tsx`**

```tsx
import { CheckIcon, CopyIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { IconButton } from './IconButton';

/** Icon-only click-to-copy button (Copy → Check). i18n-defaulted, with failure state
 *  and timer cleanup. For a value-pill copy field use CopyField instead. */
export function CopyButton({
  value,
  size = 14,
  bare = true,
  label,
  copiedLabel,
  failedLabel,
}: {
  value: string;
  size?: number;
  bare?: boolean;
  label?: string;
  copiedLabel?: string;
  failedLabel?: string;
}) {
  const { t } = useTranslation('console');
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const onClick = () => {
    navigator.clipboard.writeText(value).then(
      () => setState('copied'),
      () => setState('failed'),
    );
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1500);
  };

  const lbl =
    state === 'copied'
      ? (copiedLabel ?? t('common.copied'))
      : state === 'failed'
        ? (failedLabel ?? t('common.copyFailed'))
        : (label ?? t('common.copy'));

  return (
    <IconButton
      icon={state === 'copied' ? CheckIcon : CopyIcon}
      label={lbl}
      bare={bare}
      size={size}
      onClick={onClick}
    />
  );
}
```

NOTE: the `setState('copied')` resolves async but the 1500ms reset timer is scheduled synchronously; the resolved state shows within the window. If a test needs the timer reset, that's covered by the cleanup. (Verify `IconButton` prop names `icon/label/bare/size/onClick` against `components/ui/IconButton.tsx` before finishing — adjust if the API differs.)

- [ ] **Step 4: Run, expect PASS** — `pnpm -C apps/web test src/components/ui/CopyButton.test.tsx` → PASS.

- [ ] **Step 5: Migrate ChatContent** — In `features/app/playground/ChatContent.tsx` delete the local `function CopyButton({ code }: ...)` (≈lines 80-97), add `import { CopyButton } from '../../../components/ui/CopyButton';`, and change its usage `<CopyButton code={...} />` → `<CopyButton value={...} />` (prop rename `code`→`value`). This fixes the hardcoded-English bug (defaults now i18n).

- [ ] **Step 6: Migrate ChatMessage** — In `features/app/playground/ChatMessage.tsx` delete the local `function CopyBtn({ text }: ...)` (≈lines 219-236), add the same import, and replace `<CopyBtn text={...} />` → `<CopyButton value={...} />`.

- [ ] **Step 7: Verify** — `pnpm -C apps/web typecheck` green.

- [ ] **Step 8: Commit** — `git commit -am "refactor(web): shared CopyButton primitive (fixes ChatContent hardcoded-English copy)"`

---

## Task 3: `SecretRevealModal` + 3 console pages

**Files:** Create `components/ui/SecretRevealModal.tsx` + `.test.tsx`; Modify `features/console/ApiKeysPage.tsx`, `ServiceTokensPage.tsx`, `RedemptionCodesPage.tsx`.

- [ ] **Step 1: Write the failing test** — `apps/web/src/components/ui/SecretRevealModal.test.tsx`

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SecretRevealModal } from './SecretRevealModal';

const base = {
  open: true,
  title: 'Your key',
  onClose: vi.fn(),
  warn: 'copy it now',
  copyLabel: 'copy',
  copiedLabel: 'copied',
  doneLabel: 'done',
};

describe('SecretRevealModal', () => {
  it('renders the warning + a string value', () => {
    render(<SecretRevealModal {...base} value="sk-abc" />);
    expect(screen.getByText('copy it now')).toBeInTheDocument();
    expect(screen.getByText('sk-abc')).toBeInTheDocument();
  });

  it('joins an array value with newlines', () => {
    render(<SecretRevealModal {...base} value={['a', 'b']} />);
    // CopyField renders the value text; the joined string is present.
    expect(screen.getByText((_, el) => el?.textContent === 'a\nb')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — module not found.

- [ ] **Step 3: Create `apps/web/src/components/ui/SecretRevealModal.tsx`**

```tsx
import { CopyField } from '../data/CopyField';
import { Button } from './Button';
import { Modal } from './Modal';

/** One-time "copy your new secret now" modal — wraps Modal + a caution line + CopyField.
 *  `value` may be an array (joined with newlines, e.g. redemption codes). */
export function SecretRevealModal({
  open,
  title,
  onClose,
  value,
  warn,
  copyLabel,
  copiedLabel,
  failedLabel,
  doneLabel,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  value: string | string[];
  warn: string;
  copyLabel: string;
  copiedLabel: string;
  failedLabel?: string;
  doneLabel: string;
}) {
  const text = Array.isArray(value) ? value.join('\n') : value;
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <Button variant="cta" onClick={onClose}>
          {doneLabel}
        </Button>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
        <span style={{ color: 'var(--warn)', fontSize: 'var(--fs-sm)' }}>{warn}</span>
        <CopyField
          value={text}
          copyLabel={copyLabel}
          copiedLabel={copiedLabel}
          failedLabel={failedLabel}
        />
      </div>
    </Modal>
  );
}
```

(Verify `Button` accepts `onClick` and `variant="cta"`, and `Modal` the `open/title/onClose/footer` props — both confirmed from existing usage. If the existing pages' "done" button used a different close handler, `onClose` is the unifier.)

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Migrate ApiKeysPage** — Replace the reveal `<Modal>…</Modal>` block (≈267-287) with:

```tsx
<SecretRevealModal
  open={plaintext !== null}
  title={t('apiKeys.reveal.title')}
  onClose={() => setPlaintext(null)}
  value={plaintext ?? ''}
  warn={t('apiKeys.reveal.warn')}
  copyLabel={t('apiKeys.reveal.copy')}
  copiedLabel={t('apiKeys.reveal.copied')}
  doneLabel={t('apiKeys.reveal.done')}
/>
```

Add the import; remove now-unused `Modal`/`CopyField`/`Button` imports IF no longer used elsewhere in the file (check first).

- [ ] **Step 6: Migrate ServiceTokensPage** (≈162-186) →

```tsx
<SecretRevealModal
  open={plaintext !== null}
  title={t('tokens.reveal.title')}
  onClose={() => setPlaintext(null)}
  value={plaintext ?? ''}
  warn={t('tokens.reveal.warn')}
  copyLabel={t('common.copy')}
  copiedLabel={t('common.copied')}
  failedLabel={t('common.copyFailed')}
  doneLabel={t('common.confirm')}
/>
```

- [ ] **Step 7: Migrate RedemptionCodesPage** (≈195-215) →

```tsx
<SecretRevealModal
  open={minted !== null}
  title={t('redemptionCodes.minted.title')}
  onClose={() => setMinted(null)}
  value={minted ?? []}
  warn={t('redemptionCodes.minted.warn')}
  copyLabel={t('redemptionCodes.minted.copy')}
  copiedLabel={t('redemptionCodes.minted.copied')}
  doneLabel={t('redemptionCodes.minted.done')}
/>
```

- [ ] **Step 8: Verify** — `pnpm -C apps/web typecheck` green; run the three pages' tests if present.

- [ ] **Step 9: Commit** — `git commit -am "refactor(web): SecretRevealModal (dedupe 3 reveal modals, unify --warn)"`

---

## Task 4: `AdminOnlyNote` banner|page + 3 guards

**Files:** Modify `features/app/AdminOnlyNote.tsx` (+ create `AdminOnlyNote.test.tsx`); Modify `features/app/AppSubjects.tsx`, `AppLimitPlans.tsx`, `MembersPage.tsx`.

- [ ] **Step 1: Read current `AdminOnlyNote.tsx`** to capture the exact banner markup/styles + which i18n namespace it uses.

- [ ] **Step 2: Write the failing test** — `apps/web/src/features/app/AdminOnlyNote.test.tsx`

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AdminOnlyNote } from './AdminOnlyNote';

describe('AdminOnlyNote', () => {
  it('renders a custom message in the page variant (centered note)', () => {
    render(<AdminOnlyNote variant="page" message="admins only" />);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent('admins only');
    expect(note).toHaveStyle({ textAlign: 'center' });
  });

  it('defaults to the banner variant', () => {
    render(<AdminOnlyNote message="admins only" />);
    expect(screen.getByRole('note')).toHaveTextContent('admins only');
  });
});
```

(If i18n breaks rendering without a provider, the existing app tests wrap with an i18n test util — reuse that wrapper; passing an explicit `message` avoids the default `t()` path.)

- [ ] **Step 3: Run, expect FAIL** (variant/message props don't exist).

- [ ] **Step 4: Rewrite `AdminOnlyNote.tsx`** — keep the existing banner markup; add the props:

```tsx
import { InfoIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

/** Tenant-admin-only gate note. `banner` = inline note over a still-visible list (default,
 *  e.g. AppKeys); `page` = centered full-page note replacing the content. */
export function AdminOnlyNote({
  variant = 'banner',
  message,
}: {
  variant?: 'banner' | 'page';
  message?: string;
}) {
  const { t } = useTranslation('console');
  const text = message ?? t('app.adminOnly');
  if (variant === 'page') {
    return (
      <div
        role="note"
        style={{
          padding: 'var(--s-5)',
          textAlign: 'center',
          color: 'var(--muted)',
          fontSize: 'var(--fs-sm)',
        }}
      >
        {text}
      </div>
    );
  }
  return (
    <div
      role="note"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--s-2)',
        padding: 'var(--s-2) var(--s-3)',
        color: 'var(--muted)',
        fontSize: 'var(--fs-sm)',
      }}
    >
      <InfoIcon size={15} aria-hidden="true" style={{ flexShrink: 0, color: 'var(--faint)' }} />
      {text}
    </div>
  );
}
```

IMPORTANT: replace the banner `style` block above with the **exact** one read in Step 1 so the AppKeys banner is pixel-identical (use the real namespace/key for the default too).

- [ ] **Step 5: Run, expect PASS.**

- [ ] **Step 6: Migrate the 3 guards** — In `AppSubjects.tsx` (≈142-158), `AppLimitPlans.tsx` (≈150-166), `MembersPage.tsx` (≈148-166) replace each hand-rolled block with:

```tsx
if (!isTenantAdmin) {
  return roleLoading ? null : (
    <AdminOnlyNote variant="page" message={t('app.subjects.adminOnly')} />
  );
}
```

(use the page's own key: `app.subjects.adminOnly` / `app.limitPlans.adminOnly` / `app.members.adminOnly`). Add the `AdminOnlyNote` import where missing; remove any now-unused imports.

- [ ] **Step 7: Verify** — `pnpm -C apps/web typecheck` green; run `AppKeys.gating.test`, `MembersPage.test`, `AppSubjects.test`, `AppLimitPlans.test` if present.

- [ ] **Step 8: Commit** — `git commit -am "refactor(web): AdminOnlyNote banner|page variant (dedupe 3 admin guards)"`

---

## Task 5: `Panel` primitive + detail-page migration

**Files:** Create `components/ui/Panel.tsx` + `.test.tsx`; Modify `features/console/SubjectDetailPanel.tsx`, `features/console/ApiKeyDetailPage.tsx`, `features/app/AppLimitPlans.tsx` (and any other copies found via grep).

- [ ] **Step 1: Write the failing test** — `apps/web/src/components/ui/Panel.test.tsx`

```tsx
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Panel } from './Panel';

describe('Panel', () => {
  it('applies the panel class and override props', () => {
    const { container } = render(
      <Panel gap="var(--s-2)" padding="var(--s-3)" maxWidth={360} className="x">
        hi
      </Panel>,
    );
    const el = container.firstChild as HTMLElement;
    expect(el.className).toBe('panel x');
    expect(el).toHaveStyle({ gap: 'var(--s-2)', padding: 'var(--s-3)', maxWidth: '360px' });
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Create `apps/web/src/components/ui/Panel.tsx`**

```tsx
import type { CSSProperties, ReactNode } from 'react';

/** A `.panel` vertical-stack container — bakes the repeated
 *  {borderRadius, flex column, gap, padding} so detail pages stop copy-pasting it. */
export function Panel({
  children,
  gap = 'var(--s-3)',
  padding = 'var(--s-4)',
  maxWidth,
  className,
  style,
}: {
  children: ReactNode;
  gap?: string;
  padding?: string;
  maxWidth?: number | string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={className ? `panel ${className}` : 'panel'}
      style={{
        borderRadius: 'var(--r-md)',
        display: 'flex',
        flexDirection: 'column',
        gap,
        padding,
        ...(maxWidth !== undefined ? { maxWidth } : {}),
        ...style,
      }}
    >
      {children}
    </div>
  );
}
```

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Grep + migrate** — `rg -n "className=[\"']panel[\"']" apps/web/src/features` to find the panel divs. Migrate the ones matching the `{borderRadius:--r-md, flex column, gap, padding}` shape:
  - `SubjectDetailPanel.tsx`: delete the module-level `const panel = {...}`; replace `<div className="panel" style={panel}>` usages with `<Panel gap="var(--s-3)">`.
  - `ApiKeyDetailPage.tsx` (≈189-217): `<Panel maxWidth={360} gap="var(--s-4)">…</Panel>`.
  - `AppLimitPlans.tsx` (≈426-434): `<Panel padding="var(--s-3)" gap="var(--s-2)">…</Panel>`.
    Leave panel divs that are NOT the flex-column shape (e.g. an alert banner using `.panel`) untouched.

- [ ] **Step 6: Verify** — `pnpm -C apps/web typecheck` green.

- [ ] **Step 7: Commit** — `git commit -am "refactor(web): Panel primitive (dedupe detail-page panel style objects)"`

---

## Task 6: `MetaCell` + EntityCard + detail rows

**Files:** Create `components/data/MetaCell.tsx` + `.test.tsx`; Modify `components/data/EntityCard.tsx` (and detail-page label/value rows found via grep).

- [ ] **Step 1: Write the failing test** — `apps/web/src/components/data/MetaCell.test.tsx`

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MetaCell } from './MetaCell';

describe('MetaCell', () => {
  it('renders label + value, nowrap by default', () => {
    const { container } = render(<MetaCell label="Status" value="active" />);
    expect(screen.getByText('Status')).toBeInTheDocument();
    const value = screen.getByText('active');
    expect(value).toHaveStyle({ whiteSpace: 'nowrap' });
    expect(value.className).toContain('tabular');
  });

  it('allows wrapping when nowrap=false', () => {
    render(<MetaCell label="L" value="v" nowrap={false} />);
    expect(screen.getByText('v')).toHaveStyle({ whiteSpace: 'normal' });
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Create `apps/web/src/components/data/MetaCell.tsx`**

```tsx
import type { ReactNode } from 'react';

/** A label/value definition cell — uppercase caption label over a tabular value.
 *  The console's standard "meta" presentation (extracted from EntityCard). */
export function MetaCell({
  label,
  value,
  nowrap = true,
}: {
  label: string;
  value: ReactNode;
  nowrap?: boolean;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          fontSize: 'var(--fs-caption)',
          textTransform: 'uppercase',
          letterSpacing: '.06em',
          color: 'var(--faint)',
        }}
      >
        {label}
      </div>
      <div
        className="tabular"
        style={{
          fontSize: 'var(--fs-sm)',
          color: 'var(--text)',
          marginTop: 'var(--s-0)',
          whiteSpace: nowrap ? 'nowrap' : 'normal',
        }}
      >
        {value}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Migrate EntityCard** — In `components/data/EntityCard.tsx`, replace the inline meta-map block (the `meta.map((m, i) => <div …label…value…/>)`) with:

```tsx
{
  meta.map((m, i) => <MetaCell key={i} label={m.label} value={m.value} />);
}
```

Add `import { MetaCell } from './MetaCell';`. Keep the wrapping `<div style={{ display:'flex', flexWrap:'wrap', gap:'var(--s-6)', marginTop:'var(--s-4)' }}>` and the `CardMeta` interface.

- [ ] **Step 6: Migrate detail-page label/value rows** — `rg -n "textTransform: 'uppercase'" apps/web/src/features` to find hand-rolled label/value rows (detail panels). Replace genuine label/value pairs with `<MetaCell label=… value=… nowrap={false} />` where wrapping is desired. Do NOT touch table cells that render a single i18n template string.

- [ ] **Step 7: Verify** — `pnpm -C apps/web typecheck` green; run `CardCollection.test` / any EntityCard-dependent tests.

- [ ] **Step 8: Commit** — `git commit -am "refactor(web): MetaCell label/value primitive (extract from EntityCard)"`

---

## Task 7: Full verification

- [ ] **Step 1:** `pnpm -C apps/web typecheck` → green.
- [ ] **Step 2:** `pnpm -C apps/web lint` → green (or only pre-existing warnings).
- [ ] **Step 3:** `pnpm -C apps/web test` → green (365+ existing + 6 new test files).
- [ ] **Step 4:** `pnpm -C apps/web build` → succeeds.
- [ ] **Step 5:** Quick preview smoke (optional, no backend needed): the playground copy button shows the i18n label; the landing/login still render. Confirm zero console errors.
- [ ] **Step 6:** Final commit if anything outstanding.

---

## Self-review notes

- **Spec coverage:** §3.1→T1, §3.2→T2, §3.3→T3, §3.4→T4, §3.5→T5, §3.6→T6, §5 testing→each task + T7. All covered.
- **Type consistency:** `useDebounced(value, commit, delay)`, `CopyButton{value,size,bare,label,copiedLabel,failedLabel}`, `SecretRevealModal{open,title,onClose,value,warn,copyLabel,copiedLabel,failedLabel,doneLabel}`, `AdminOnlyNote{variant,message}`, `Panel{children,gap,padding,maxWidth,className,style}`, `MetaCell{label,value,nowrap}` — used identically across tasks.
- **Resolve-at-implementation (explicit, not placeholders):** exact `IconButton` prop names (T2.3), exact current `AdminOnlyNote` banner styles + namespace (T4.1/T4.4), `Button` onClick support (T3.3), the full set of `.panel` flex-column copies (T5.5 grep), detail-page label/value rows (T6.6 grep). Each has a concrete grep/read step and a decision rule.
