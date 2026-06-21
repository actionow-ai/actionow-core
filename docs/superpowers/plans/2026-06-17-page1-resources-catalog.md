# Page 1 — Resources / Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Checkbox (`- [ ]`) steps.

**Goal:** Build the operator Resources/Catalog page against the real `/admin/*` API — a master list + a tabbed detail (Overview · Channels · Pricing) with a full channel editor (all fields + credentials), pricing editor, and create-resource — using enum selects (no free-text casts) and a new `Drawer`.

**Architecture:** A new `Drawer` (side panel, like `Modal` but right-slide) hosts the channel editor; a new `lib/api/enums.ts` centralizes enum option sets so `SelectField` options and the `types.ts` unions share one source. `ResourceDetailPane` is restructured into `Tabs`. Channels use the enhanced `DataTable` (rowActions edit/toggle + bulk enable/disable). All data via `qk` + `mutationError`; client methods (L1) already exist.

**Tech Stack:** React 19, TS strict, TanStack Query v5, react-i18next, Phosphor, GSAP, vitest + RTL.

Spec: `docs/superpowers/specs/2026-06-17-frontend-api-integration-design.md` §5. Working dir `/Users/alienworm/actionow-web`. Gate: `pnpm --filter @actionow/web typecheck && pnpm --filter @actionow/web lint && pnpm --filter @actionow/web build`; tests `pnpm --filter @actionow/web exec vitest run`. Lowercase commits.

**Backend = source of truth** (`/Users/alienworm/actionow-core`): all endpoints used here already have L1 client methods in `apps/web/src/lib/api/admin.ts` (`listResources`, `createResource`, `listChannels`, `createChannel`, `updateChannel`, `createSecret`, `listPricebook`, `createPricebook`). Types in `apps/web/src/lib/api/types.ts` (`ResourceView`, `ChannelView`, `CreateChannelBody`, `UpdateChannelBody`, `CreateSecretBody`, `SecretView`, `CreatePricebookBody`, enums `Modality`/`PricebookMethod`/`PricebookTiming`/`ChannelStatus`). **Run the backend on :3000 must be current** (it was restarted — channels GET returns data).

---

## File Structure

- `src/lib/api/enums.ts` (new) + `enums.test.ts` — enum option sets + `toOptions(opts,t)`.
- `src/components/ui/Drawer.tsx` (new) + `Drawer.test.tsx` — right-slide panel.
- `src/features/console/ResourceDetailPane.tsx` (rewrite) — tabbed detail.
- `src/features/console/ChannelEditor.tsx` (new) — the channel create/edit Drawer form (incl. new-credential flow).
- `src/features/console/ResourcesPage.tsx` (modify) — create-resource modal: modality/kind enum selects.
- i18n `src/i18n/locales/{zh-CN,en}/console.json` — `enums.*`, `channels.form.*`, `channels.actions.*`, `credentials.*`, `pricebook.form.*` additions (both locales).

---

## Task 1: `lib/api/enums.ts` — centralized enum option sets

**Files:** `src/lib/api/enums.ts` (new), `src/lib/api/enums.test.ts` (new).

- [ ] **Step 1: Write the failing test** `enums.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { MODALITIES, PRICEBOOK_METHODS, toOptions } from './enums';

describe('enums', () => {
  it('modality option values match the backend union', () => {
    expect(MODALITIES.map((o) => o.value)).toEqual([
      'text',
      'image',
      'video',
      'audio',
      'composite',
    ]);
  });
  it('toOptions resolves labelKey via t', () => {
    const t = ((k: string) => `T:${k}`) as unknown as Parameters<typeof toOptions>[1];
    const opts = toOptions(PRICEBOOK_METHODS, t);
    expect(opts[0]).toEqual({ value: 'unit', label: 'T:enums.method.unit' });
  });
});
```

- [ ] **Step 2: Run it, verify red.** `pnpm --filter @actionow/web exec vitest run src/lib/api/enums.test.ts` → cannot resolve `./enums`.
- [ ] **Step 3: Implement** `src/lib/api/enums.ts`:

```ts
import type { TFunction } from 'i18next';

import type { ChannelStatus, Modality, PricebookMethod, PricebookTiming } from './types';

export interface EnumOption<V extends string> {
  value: V;
  labelKey: string;
}

export const MODALITIES: EnumOption<Modality>[] = [
  { value: 'text', labelKey: 'enums.modality.text' },
  { value: 'image', labelKey: 'enums.modality.image' },
  { value: 'video', labelKey: 'enums.modality.video' },
  { value: 'audio', labelKey: 'enums.modality.audio' },
  { value: 'composite', labelKey: 'enums.modality.composite' },
];

export const RESOURCE_KINDS: EnumOption<'model' | 'workflow'>[] = [
  { value: 'model', labelKey: 'enums.kind.model' },
  { value: 'workflow', labelKey: 'enums.kind.workflow' },
];

export const PRICEBOOK_METHODS: EnumOption<PricebookMethod>[] = [
  { value: 'unit', labelKey: 'enums.method.unit' },
  { value: 'matrix', labelKey: 'enums.method.matrix' },
  { value: 'fixed', labelKey: 'enums.method.fixed' },
  { value: 'formula', labelKey: 'enums.method.formula' },
  { value: 'passthrough', labelKey: 'enums.method.passthrough' },
];

export const PRICEBOOK_TIMINGS: EnumOption<PricebookTiming>[] = [
  { value: 'pre', labelKey: 'enums.timing.pre' },
  { value: 'post', labelKey: 'enums.timing.post' },
];

export const CHANNEL_STATUSES: EnumOption<ChannelStatus>[] = [
  { value: 'active', labelKey: 'enums.channelStatus.active' },
  { value: 'disabled', labelKey: 'enums.channelStatus.disabled' },
];

/** Common provider_type values surfaced as a hint (the field stays free text). */
export const COMMON_PROVIDERS = [
  'openai',
  'anthropic',
  'gemini',
  'deepseek',
  'qwen',
  'zhipu',
  'kimi',
  'minimax',
  'volcengine',
  'doubao',
  'ernie',
  'hunyuan',
  'cloudflare',
  'dify',
];

/** Map enum options → SelectField `{value,label}` by resolving labelKey with `t`. */
export function toOptions<V extends string>(
  opts: EnumOption<V>[],
  t: TFunction,
): { value: V; label: string }[] {
  return opts.map((o) => ({ value: o.value, label: t(o.labelKey) }));
}
```

- [ ] **Step 4: Verify green.** Same vitest command → pass.
- [ ] **Step 5: Add i18n `enums.*` to BOTH `console.json` locales.** en: `"enums": { "modality": {"text":"Text","image":"Image","video":"Video","audio":"Audio","composite":"Composite"}, "kind": {"model":"Model","workflow":"Workflow"}, "method": {"unit":"Unit","matrix":"Matrix","fixed":"Fixed","formula":"Formula","passthrough":"Passthrough"}, "timing": {"pre":"Pre","post":"Post"}, "channelStatus": {"active":"Active","disabled":"Disabled"} }`. zh-CN: `{ "modality": {"text":"文本","image":"图像","video":"视频","audio":"音频","composite":"复合"}, "kind": {"model":"模型","workflow":"工作流"}, "method": {"unit":"按量","matrix":"矩阵","fixed":"固定","formula":"公式","passthrough":"透传"}, "timing": {"pre":"前置","post":"后置"}, "channelStatus": {"active":"启用","disabled":"停用"} }`.
- [ ] **Step 6: Verify + commit.** `vitest run` green. `git add apps/web/src/lib/api/enums.ts apps/web/src/lib/api/enums.test.ts apps/web/src/i18n/locales && git commit -m "feat(web): centralized enum option sets for selects"`.

---

## Task 2: `Drawer` component

**Files:** `src/components/ui/Drawer.tsx` (new), `src/components/ui/Drawer.test.tsx` (new).

Model it on `Modal.tsx` (read it): portal, `mounted` deferred-unmount, `useFocusTrap(ref, open && mounted)`, Escape, `--scrim` backdrop, `--overlay-bg` panel, GSAP enter/exit, reduced-motion instant. Difference: the panel slides in from the right and is full-height.

- [ ] **Step 1: Write the failing test** `Drawer.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Drawer } from './Drawer';

describe('Drawer', () => {
  it('renders title + children when open and closes on Escape', async () => {
    const onClose = vi.fn();
    render(
      <Drawer open title="Edit channel" onClose={onClose}>
        <button>field</button>
      </Drawer>,
    );
    expect(screen.getByRole('dialog', { name: 'Edit channel' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Verify red.** `vitest run src/components/ui/Drawer.test.tsx` → cannot resolve `./Drawer`.
- [ ] **Step 3: Implement** `src/components/ui/Drawer.tsx`:

```tsx
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { gsap, useGSAP } from '../../lib/motion/gsap';
import { DUR, EASE } from '../../lib/motion/tokens';
import { useFocusTrap } from '../../lib/useFocusTrap';

/** A right-slide overlay panel for longer forms (e.g. the channel editor). */
export function Drawer({
  open,
  title,
  onClose,
  children,
  footer,
  width = 'min(480px, 96vw)',
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  const [mounted, setMounted] = useState(open);
  const backdropRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(open);
  openRef.current = open;

  useFocusTrap(panelRef, open && mounted);

  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useGSAP(
    () => {
      const backdrop = backdropRef.current;
      const panel = panelRef.current;
      if (!backdrop || !panel) return;
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (open) {
        if (reduced) {
          gsap.set(backdrop, { opacity: 1 });
          gsap.set(panel, { opacity: 1, x: 0 });
          return;
        }
        gsap.fromTo(backdrop, { opacity: 0 }, { opacity: 1, duration: DUR.base, ease: EASE.out });
        gsap.fromTo(
          panel,
          { x: 40, opacity: 0 },
          { x: 0, opacity: 1, duration: DUR.base, ease: EASE.out },
        );
        return;
      }
      if (reduced) {
        setMounted(false);
        return;
      }
      const tl = gsap.timeline({
        onComplete: () => {
          if (!openRef.current) setMounted(false);
        },
      });
      tl.to(panel, { x: 40, opacity: 0, duration: DUR.fast, ease: EASE.in }, 0);
      tl.to(backdrop, { opacity: 0, duration: DUR.fast, ease: EASE.in }, 0);
    },
    { dependencies: [open] },
  );

  if (!mounted) return null;
  return createPortal(
    <div
      ref={backdropRef}
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 80,
        background: 'var(--scrim)',
        display: 'flex',
        justifyContent: 'flex-end',
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="glass"
        style={{
          width,
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 0,
          padding: 'var(--s-5)',
          background: 'var(--overlay-bg)',
        }}
      >
        <h2 style={{ margin: 0, fontSize: 'var(--fs-md)', fontWeight: 700 }}>{title}</h2>
        <div
          style={{
            marginTop: 'var(--s-4)',
            marginInline: 'calc(-1 * var(--s-2))',
            paddingInline: 'var(--s-2)',
            paddingBlock: 'var(--s-1)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--s-3)',
            overflowY: 'auto',
            flex: 1,
            minHeight: 0,
          }}
        >
          {children}
        </div>
        {footer && (
          <div
            style={{
              marginTop: 'var(--s-5)',
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 'var(--s-2)',
              flexShrink: 0,
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
```

- [ ] **Step 4: Verify green** + full gate.
- [ ] **Step 5: Commit** `feat(web): drawer side-panel component`.

---

## Task 3: `ChannelEditor` — channel create/edit Drawer (with new-credential flow)

**Files:** `src/features/console/ChannelEditor.tsx` (new).

The editor opens for create (no `channel`) or edit (with a `ChannelView`). On save it calls `createChannel`/`updateChannel`. It includes an inline "new credential" sub-form (`createSecret`) that fills `credentialRef`.

- [ ] **Step 1: Implement** `ChannelEditor.tsx`:

```tsx
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/ui/Button';
import { Drawer } from '../../components/ui/Drawer';
import { JsonField, validateJson } from '../../components/ui/JsonField';
import { NumberField } from '../../components/ui/NumberField';
import { SelectField } from '../../components/ui/SelectField';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { ApiError } from '../../lib/api/errors';
import { CHANNEL_STATUSES, COMMON_PROVIDERS, toOptions } from '../../lib/api/enums';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { ChannelView, ChannelStatus } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';

export function ChannelEditor({
  resourceId,
  channel,
  open,
  onClose,
}: {
  resourceId: string;
  channel?: ChannelView;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();
  const editing = channel !== undefined;

  const [providerType, setProviderType] = useState(channel?.provider_type ?? '');
  const [endpoint, setEndpoint] = useState(channel?.endpoint ?? '');
  const [model, setModel] = useState(channel?.model ?? '');
  const [proxyRef, setProxyRef] = useState(channel?.proxy_ref ?? '');
  const [credentialRef, setCredentialRef] = useState(channel?.credential_ref ?? '');
  const [weight, setWeight] = useState(channel?.weight ?? 1);
  const [status, setStatus] = useState<ChannelStatus>(
    (channel?.status as ChannelStatus) ?? 'active',
  );
  const [config, setConfig] = useState(
    channel?.config ? JSON.stringify(channel.config, null, 2) : '',
  );
  const [cfgErr, setCfgErr] = useState<string | undefined>(undefined);

  // inline new-credential
  const [credOpen, setCredOpen] = useState(false);
  const [credValue, setCredValue] = useState('');
  const [credLabel, setCredLabel] = useState('');
  const createCred = useMutation({
    mutationFn: () =>
      api.createSecret({
        value: credValue,
        label: credLabel.trim() === '' ? undefined : credLabel.trim(),
      }),
    onSuccess: (s) => {
      setCredentialRef(s.id);
      setCredOpen(false);
      setCredValue('');
      setCredLabel('');
      toast(t('credentials.created'));
    },
    onError: mutationError(t),
  });

  const save = useMutation({
    mutationFn: () => {
      let cfg: Record<string, unknown> | undefined;
      if (config.trim() !== '') {
        const parsed = validateJson(config);
        if (!parsed.ok) throw new ApiError('invalid_input', parsed.error, 400, false);
        cfg = parsed.value as Record<string, unknown>;
      }
      const body = {
        providerType,
        endpoint: endpoint.trim() === '' ? undefined : endpoint.trim(),
        model: model.trim() === '' ? undefined : model.trim(),
        proxyRef: proxyRef.trim() === '' ? undefined : proxyRef.trim(),
        credentialRef: credentialRef.trim() === '' ? undefined : credentialRef.trim(),
        weight,
        status,
        config: cfg,
      };
      return editing
        ? api.updateChannel(resourceId, channel.id, body)
        : api.createChannel(resourceId, body);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.channels(resourceId) });
      toast(t(editing ? 'channels.updated' : 'channels.created'));
      onClose();
    },
    onError: mutationError(t),
  });

  return (
    <Drawer
      open={open}
      title={t(editing ? 'channels.editTitle' : 'channels.addTitle')}
      onClose={onClose}
      footer={
        <Button variant="cta" onClick={() => save.mutate()} loading={save.isPending}>
          {t('channels.save')}
        </Button>
      }
    >
      <TextField
        label={t('channels.form.provider')}
        value={providerType}
        onChange={setProviderType}
        hint={COMMON_PROVIDERS.join(' · ')}
      />
      <TextField label={t('channels.form.endpoint')} value={endpoint} onChange={setEndpoint} />
      <TextField label={t('channels.form.model')} value={model} onChange={setModel} />
      <TextField label={t('channels.form.proxyRef')} value={proxyRef} onChange={setProxyRef} />
      <NumberField label={t('channels.form.weight')} value={weight} onChange={setWeight} min={1} />
      <SelectField
        label={t('channels.form.status')}
        value={status}
        onChange={(v) => setStatus(v as ChannelStatus)}
        options={toOptions(CHANNEL_STATUSES, t)}
      />
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--s-2)' }}>
        <div style={{ flex: 1 }}>
          <TextField
            label={t('channels.form.credentialRef')}
            value={credentialRef}
            onChange={setCredentialRef}
          />
        </div>
        <Button variant="ghost" onClick={() => setCredOpen((v) => !v)}>
          {t('credentials.new')}
        </Button>
      </div>
      {credOpen && (
        <div
          className="panel"
          style={{
            borderRadius: 'var(--r-sm)',
            padding: 'var(--s-3)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--s-2)',
          }}
        >
          <TextField
            label={t('credentials.value')}
            value={credValue}
            onChange={setCredValue}
            type="password"
          />
          <TextField label={t('credentials.label')} value={credLabel} onChange={setCredLabel} />
          <Button variant="cta" onClick={() => createCred.mutate()} loading={createCred.isPending}>
            {t('credentials.save')}
          </Button>
        </div>
      )}
      <JsonField
        label={t('channels.form.config')}
        value={config}
        onChange={(v) => {
          setConfig(v);
          setCfgErr(v.trim() === '' || validateJson(v).ok ? undefined : 'invalid JSON');
        }}
        error={cfgErr}
      />
    </Drawer>
  );
}
```

- [ ] **Step 2: Verify** typecheck (no test — exercised via the page; logic is thin). Build green.
- [ ] **Step 3: Commit** `feat(web): channel editor drawer (full fields + inline credential)`.

---

## Task 4: Rewrite `ResourceDetailPane` into tabbed detail with full channels + pricing

**Files:** `src/features/console/ResourceDetailPane.tsx` (rewrite).

Replace the stacked sections with `Tabs` (Overview · Channels · Pricing). Channels tab uses the enhanced `DataTable` with `rowActions` (edit → ChannelEditor; toggle status → `updateChannel`), `selectable` + `bulkActions` (enable/disable selected). Keep the pricing tab's table + upgrade its add-price modal to enum selects + `fixedCredits` + `Toggle`.

- [ ] **Step 1: Implement the rewrite.** Key pieces (compose with existing patterns):
  - Tab state: `const [tab, setTab] = useUrlState('tab', 'overview')` (import `useUrlState`); `<Tabs value={tab} onChange={setTab} tabs={[{value:'overview',label:t('resources.tabs.overview')},{value:'channels',...},{value:'pricing',...}]} ariaLabel={...}>{tab==='overview'?<Overview/>:tab==='channels'?<Channels/>:<Pricing/>}</Tabs>`.
  - Channel editor state: `const [editorOpen, setEditorOpen] = useState(false); const [editing, setEditing] = useState<ChannelView | undefined>(undefined);` Open create: `setEditing(undefined); setEditorOpen(true)`. Open edit: `setEditing(row); setEditorOpen(true)`. Render `<ChannelEditor resourceId={id} channel={editing} open={editorOpen} onClose={() => setEditorOpen(false)} />`.
  - Channel status toggle mutation:

```tsx
const toggleStatus = useMutation({
  mutationFn: (c: ChannelView) =>
    api.updateChannel(id, c.id, { status: c.status === 'active' ? 'disabled' : 'active' }),
  onSuccess: async () => {
    await qc.invalidateQueries({ queryKey: qk.channels(id) });
  },
  onError: mutationError(t),
});
const bulkSetStatus = useMutation({
  mutationFn: async ({ rows, status }: { rows: ChannelView[]; status: ChannelStatus }) => {
    await Promise.all(rows.map((c) => api.updateChannel(id, c.id, { status })));
  },
  onSuccess: async () => {
    await qc.invalidateQueries({ queryKey: qk.channels(id) });
  },
  onError: mutationError(t),
});
```

- Channels DataTable:

```tsx
<DataTable
  columns={chCols}
  rows={channels.data ?? []}
  rowKey={(r) => r.id}
  loading={channels.isLoading}
  empty={t('channels.empty')}
  searchable
  selectable
  rowActions={(r) => (
    <div style={{ display: 'flex', gap: 'var(--s-1)' }}>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setEditing(r);
          setEditorOpen(true);
        }}
      >
        {t('common.edit')}
      </Button>
      <Button variant="ghost" size="sm" onClick={() => toggleStatus.mutate(r)}>
        {r.status === 'active' ? t('channels.actions.disable') : t('channels.actions.enable')}
      </Button>
    </div>
  )}
  bulkActions={(sel, clear) => (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          bulkSetStatus.mutate({ rows: sel, status: 'active' });
          clear();
        }}
      >
        {t('channels.actions.enable')}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          bulkSetStatus.mutate({ rows: sel, status: 'disabled' });
          clear();
        }}
      >
        {t('channels.actions.disable')}
      </Button>
    </>
  )}
/>
```

`chCols` keep provider/endpoint/model/weight/status (as the current file already defines).

- Pricing add-price modal: replace the free-text `method`/`timing` `TextField`s with `SelectField` using `toOptions(PRICEBOOK_METHODS, t)` / `toOptions(PRICEBOOK_TIMINGS, t)`; change `method`/`timing` state to typed defaults (`useState<PricebookMethod>('unit')`); add `version`/`resourceVersion` as `NumberField` (default `resource?.current_version ?? 1`); add a conditional `fixedCredits` `NumberField` shown only when `method === 'fixed'` (pass `fixedCredits` in the `createPricebook` body when set); add an `active` `Toggle` (default true). Keep `spec` `JsonField`.
- Remove the old inline add-channel `Modal` (replaced by ChannelEditor); the "Add channel" button now does `setEditing(undefined); setEditorOpen(true)`.
- [ ] **Step 2: Verify** typecheck/lint/build green.
- [ ] **Step 3: Commit** `feat(web): tabbed resource detail with full channel + pricing editors`.

---

## Task 5: Create-resource modal — enum selects

**Files:** `src/features/console/ResourcesPage.tsx` (modify).

- [ ] **Step 1:** Change the create-resource modal: `modality` `TextField` → `SelectField` with `toOptions(MODALITIES, t)` and `modality` state typed `useState<Modality>('text')`; `kind` already a `SelectField` — switch its inline options to `toOptions(RESOURCE_KINDS, t)`; `providerType` stays `TextField` but add `hint={COMMON_PROVIDERS.join(' · ')}`; `execModes` stays `TextField`. Import from `../../lib/api/enums`.
- [ ] **Step 2:** Verify gate green.
- [ ] **Step 3: Commit** `feat(web): enum selects in create-resource form`.

---

## Task 6: i18n keys (both locales)

**Files:** `src/i18n/locales/{en,zh-CN}/console.json`.

- [ ] Add the new keys used above (BOTH locales, in sync):
  - `resources.tabs.{overview,channels,pricing}`
  - `channels.{addTitle,editTitle,save,created,updated}`, `channels.form.{provider,endpoint,model,proxyRef,weight,status,credentialRef,config}`, `channels.actions.{enable,disable}`
  - `credentials.{new,value,label,save,created}`
  - `pricebook.form.{resourceVersion,version,method,timing,fixedCredits,spec,active}` (extend existing block)
  - `common.edit` (if not present)
  - (`enums.*` added in Task 1)
- [ ] Verify gate green (no missing-key console warnings in the running app).
- [ ] **Commit** `feat(web): i18n for resource catalog channel/credential/pricing forms`.

---

## Final verification (Page 1 checkpoint)

- [ ] Full gate + `vitest run` green (incl. enums + Drawer tests).
- [ ] Against the real API at `:4173` (backend current):
  - Resources list loads; selecting a resource routes to `/console/resources/:id` and shows tabs; reload keeps selection + active tab (`?tab=`).
  - Channels tab lists real channels; "Add channel" opens the Drawer; create with endpoint/model/weight/status saves and the list refreshes; edit a channel (PATCH) persists; toggle status flips active/disabled; bulk-select + enable/disable works.
  - "New credential" in the editor creates a secret and fills `credentialRef`.
  - Pricing tab: add a price with method/timing selects (+ fixedCredits when method=fixed) saves and refreshes.
  - Create resource with modality/kind selects saves and appears in the list.
  - No blue, no emoji, dark + light, keyboard reachable (Drawer focus trap; tab arrow keys).

## Self-review notes

- Spec §5 coverage: enums (T1), Drawer (T2), channel editor + credentials (T3), tabbed detail + channels table actions/bulk + pricing editor (T4), create-resource enum selects (T5), i18n (T6). All §5.1–5.10 covered.
- New components limited to `Drawer` + `enums.ts` (per spec §4). No `ConfirmDialog` (no DELETE on this page). No hard channel delete (backend has none → soft disable).
- Types/method names verified against `types.ts` + `admin.ts` (L1): `updateChannel(resourceId, channelId, body)`, `createSecret({value,label}) → SecretView{id}`, `ChannelView.proxy_ref/credential_ref/config`, `CreatePricebookBody.fixedCredits`.
