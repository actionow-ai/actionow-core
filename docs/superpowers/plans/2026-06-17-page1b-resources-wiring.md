# Page 1b — Resources / Catalog Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Checkbox (`- [ ]`) steps.

**Goal:** Build the operator Resources/Catalog page against the real `/admin/*` API using the Page-1a forms toolkit — tabbed detail (Overview · Channels · Pricing), a full channel editor `Drawer` (all fields, config via `KeyValueEditor`, inline credential), a pricing editor using `PricebookSpecForm`, and a create-resource modal using `IoSchemaField` + enum selects + `ChipsField`. **No raw JSON anywhere; every field has a hint and/or tooltip.**

**Architecture:** Parent components own the editable toolkit state (`KvRow[]` for config, `{inputs,outputs}` for ioSchema, `SpecFormState` + method for pricing) and convert via `objectFromRows`/`buildIoSchema`/`buildSpec` at submit. Data via `qk` + `mutationError`; client methods (L1) already exist. Channels use the enhanced `DataTable` (rowActions edit/toggle + bulk enable/disable).

**Tech Stack:** React 19, TS strict, TanStack Query v5, react-i18next, Phosphor, vitest.

Spec: `docs/superpowers/specs/2026-06-17-frontend-api-integration-design.md` §5. Toolkit: Page 1a (committed). Working dir `/Users/alienworm/actionow-web`. Gate: `pnpm --filter @actionow/web typecheck && pnpm --filter @actionow/web lint && pnpm --filter @actionow/web build`; tests `pnpm --filter @actionow/web exec vitest run`. Lowercase commits. Rules: no blue, no emoji (Phosphor), dark+light, button no-wrap, i18n both locales, tokens, a11y. **Run the backend on :3000 current** (channels/secrets/pricebook routes live).

## Toolkit APIs (Page 1a — use these; do NOT type raw JSON)

- `enums.ts`: `MODALITIES, RESOURCE_KINDS, PRICEBOOK_METHODS, PRICEBOOK_TIMINGS, CHANNEL_STATUSES, MARKUP_TYPES, COMMON_PROVIDERS, EXEC_MODES, toOptions(opts,t)`.
- `KeyValueEditor({ label?, tooltip?, hint?, value: KvRow[], onChange:(rows:KvRow[])=>void, presets? })`; helpers `rowsFromObject(obj)→KvRow[]`, `objectFromRows(rows)→Record<string,string>` from `components/ui/kvRows`.
- `ChipsField({ label?, tooltip?, hint?, value:string[], onChange, suggestions?, placeholder? })`.
- `Drawer({ open,title,onClose,children,footer?,width? })`.
- `IoSchemaField({ value:{inputs:IoField[];outputs:IoField[]}, onChange })`; helpers `emptyIoField()`, `buildIoSchema(inputs,outputs)→{inputs,outputs}` from `components/data/ioSchemaShape`.
- `PricebookSpecForm({ method:PricebookMethod, value:SpecFormState, onChange })`; helpers `emptySpecForm()`, `buildSpec(method, state)→object` from `components/data/pricebookSpec`.
- `Tooltip` + `FormField.tooltip` (and `tooltip?` passthrough on `TextField`/`NumberField`/`SelectField`).
- Existing: `DataTable` (rowActions/selectable/bulkActions/searchable/pageSize), `Tabs`, `Modal`, `Toggle`, `StatusBadge`+`statusTone`, `ProviderIcon`, `TenantSelect`, `Button`(loading), `qk`, `mutationError`, `useUrlState`, `STALE_REFERENCE`.

## File Structure

- `src/features/console/ChannelEditor.tsx` (new) — channel create/edit Drawer.
- `src/features/console/PricingModal.tsx` (new) — add-price modal (method + PricebookSpecForm + fixedCredits).
- `src/features/console/ResourceDetailPane.tsx` (rewrite) — tabbed detail; channels table actions/bulk.
- `src/features/console/ResourcesPage.tsx` (modify) — create-resource modal: IoSchemaField + enum selects + ChipsField execModes.
- i18n `console.json` both locales — channel/credential/pricing/resource field labels + hints + tooltips; `resources.tabs.*`.

---

## Task 1: `ChannelEditor` Drawer (config via KeyValueEditor + inline credential)

**Files:** `src/features/console/ChannelEditor.tsx` (new).

- [ ] **Implement.** Read `apps/web/src/lib/api/admin.ts` (`createChannel`/`updateChannel`/`createSecret`) + `types.ts` (`ChannelView`/`CreateChannelBody`/`UpdateChannelBody`/`ChannelStatus`) + `kvRows`. Component:

```tsx
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/ui/Button';
import { Drawer } from '../../components/ui/Drawer';
import { KeyValueEditor } from '../../components/ui/KeyValueEditor';
import { objectFromRows, rowsFromObject, type KvRow } from '../../components/ui/kvRows';
import { NumberField } from '../../components/ui/NumberField';
import { SelectField } from '../../components/ui/SelectField';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { CHANNEL_STATUSES, COMMON_PROVIDERS, toOptions } from '../../lib/api/enums';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { ChannelStatus, ChannelView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';

const ASYNC_MEDIA_PRESET = {
  submitPath: '/api/v1/tasks',
  pollPath: '/api/v1/tasks/{id}',
  signatureHeader: 'X-Signature',
  timestampHeader: 'X-Timestamp',
};

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
  const [configRows, setConfigRows] = useState<KvRow[]>(rowsFromObject(channel?.config));

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
      const cfg = objectFromRows(configRows);
      const body = {
        providerType,
        endpoint: endpoint.trim() === '' ? undefined : endpoint.trim(),
        model: model.trim() === '' ? undefined : model.trim(),
        proxyRef: proxyRef.trim() === '' ? undefined : proxyRef.trim(),
        credentialRef: credentialRef.trim() === '' ? undefined : credentialRef.trim(),
        weight,
        status,
        config: Object.keys(cfg).length > 0 ? cfg : undefined,
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
        tooltip={t('channels.tip.provider')}
        hint={COMMON_PROVIDERS.join(' · ')}
        value={providerType}
        onChange={setProviderType}
      />
      <TextField
        label={t('channels.form.endpoint')}
        tooltip={t('channels.tip.endpoint')}
        value={endpoint}
        onChange={setEndpoint}
      />
      <TextField
        label={t('channels.form.model')}
        tooltip={t('channels.tip.model')}
        value={model}
        onChange={setModel}
      />
      <TextField
        label={t('channels.form.proxyRef')}
        tooltip={t('channels.tip.proxyRef')}
        value={proxyRef}
        onChange={setProxyRef}
      />
      <NumberField
        label={t('channels.form.weight')}
        tooltip={t('channels.tip.weight')}
        value={weight}
        onChange={setWeight}
        min={1}
      />
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
            tooltip={t('channels.tip.credentialRef')}
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
            tooltip={t('credentials.tip.value')}
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
      <KeyValueEditor
        label={t('channels.form.config')}
        tooltip={t('channels.tip.config')}
        value={configRows}
        onChange={setConfigRows}
        presets={[{ label: t('channels.preset.asyncMedia'), value: ASYNC_MEDIA_PRESET }]}
      />
    </Drawer>
  );
}
```

Note: the editor is opened with `key={channel?.id ?? 'new'}` by the parent (Task 3) so state reseeds per row.

- [ ] **Verify** typecheck/build green. Commit `feat(web): channel editor drawer (config key-value + inline credential)`.

## Task 2: `PricingModal` (method + PricebookSpecForm + fixedCredits)

**Files:** `src/features/console/PricingModal.tsx` (new).

- [ ] **Implement.** Read `pricebookSpec` (`SpecFormState`/`emptySpecForm`/`buildSpec`), `enums` (`PRICEBOOK_METHODS`/`PRICEBOOK_TIMINGS`), `admin.createPricebook`, `types` (`PricebookMethod`/`PricebookTiming`).

```tsx
// state: method PricebookMethod('unit'), timing PricebookTiming('post'), version number(1),
//        resourceVersion number(resourceCurrentVersion), fixedCredits number(0), active boolean(true),
//        specForm SpecFormState(emptySpecForm()).
// fields:
//   SelectField method (toOptions(PRICEBOOK_METHODS,t)), tooltip method
//   SelectField timing (toOptions(PRICEBOOK_TIMINGS,t)), tooltip pre/post
//   NumberField resourceVersion (tooltip), NumberField version (tooltip)
//   when method==='fixed': NumberField fixedCredits (label 'human credits', tooltip µcredit note)
//   <PricebookSpecForm method={method} value={specForm} onChange={setSpecForm} />
//   Toggle active
// submit: api.createPricebook({ resourceId, resourceVersion, version,
//   method, timing, spec: buildSpec(method, specForm),
//   fixedCredits: method==='fixed' ? fixedCredits : undefined, active });
//   invalidate qk.pricebook(resourceId); onClose; mutationError(t).
```

Render inside `Modal`; CTA `loading={create.isPending}`. Props `{ resourceId, resourceCurrentVersion, open, onClose }`. Open with `key` reset on open so state is fresh each time.

- [ ] **Verify** gate green. Commit `feat(web): pricing modal with per-method spec form`.

## Task 3: Rewrite `ResourceDetailPane` — tabs + channel/pricing actions

**Files:** `src/features/console/ResourceDetailPane.tsx` (rewrite). Read the current file first (keep the header + queries).

- [ ] **Implement.** Structure:
  - Queries unchanged: `resources` (qk.resources, STALE_REFERENCE), `channels` (qk.channels(id)), `pricebook` (qk.pricebook(id)).
  - `const [tab, setTab] = useUrlState('tab', 'overview')`.
  - Channel editor state: `const [chOpen,setChOpen]=useState(false); const [editing,setEditing]=useState<ChannelView|undefined>(undefined);`. Render `<ChannelEditor key={editing?.id ?? 'new'} resourceId={id} channel={editing} open={chOpen} onClose={()=>setChOpen(false)} />`.
  - Pricing modal state: `const [pbOpen,setPbOpen]=useState(false);` render `<PricingModal key={pbOpen ? 'open' : 'closed'} resourceId={id} resourceCurrentVersion={resource?.current_version ?? 1} open={pbOpen} onClose={()=>setPbOpen(false)} />`.
  - status toggle + bulk mutations:

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

- `<Tabs value={tab} onChange={setTab} ariaLabel={t('resources.detail.tabsLabel')} tabs={[{value:'overview',label:t('resources.tabs.overview')},{value:'channels',label:t('resources.tabs.channels')},{value:'pricing',label:t('resources.tabs.pricing')}]}>` then render the active panel.
- **Overview panel**: the existing resource header (ProviderIcon + id + modality·provider·exec + StatusBadge + version).
- **Channels panel**: an "Add channel" `Button` (`setEditing(undefined); setChOpen(true)`) + the channels `DataTable`:

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
          setChOpen(true);
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

`chCols`: provider (ProviderIcon + provider_type), endpoint (`?? '—'`), model (`?? '—'`), weight, status (StatusBadge tone/label). (Reuse from the current file.)

- **Pricing panel**: "Add price" `Button` (`setPbOpen(true)`) + the pricebook `DataTable` (method/timing/version/active; searchable; pageSize 10) — keep the current `pbCols`.
- Remove the old inline add-channel + add-price Modals (replaced by ChannelEditor + PricingModal).
- [ ] **Verify** gate green. Commit `feat(web): tabbed resource detail with channel + pricing editors`.

## Task 4: Create-resource modal — IoSchemaField + enum selects + ChipsField

**Files:** `src/features/console/ResourcesPage.tsx` (modify). Read the current file.

- [ ] **Implement.** Replace the create-resource modal body:
  - state: `kind` `useState<'model'|'workflow'>('model')`; `modality` `useState<Modality>('text')`; `provider` string; `execModes` `useState<string[]>(['blocking'])`; `ioForm` `useState<{inputs:IoField[];outputs:IoField[]}>({ inputs:[{...emptyIoField(),key:'prompt',type:'string',required:true}], outputs:[{...emptyIoField(),key:'text',type:'string'}] })`.
  - fields:
    - `TextField` id (tooltip: resource id, unique).
    - `TenantSelect` tenant.
    - `SelectField` kind = `toOptions(RESOURCE_KINDS, t)`.
    - `SelectField` modality = `toOptions(MODALITIES, t)`.
    - `TextField` providerType (hint `COMMON_PROVIDERS.join(' · ')`, tooltip).
    - `ChipsField` execModes (suggestions `EXEC_MODES`, tooltip).
    - `IoSchemaField` value=`ioForm` onChange=`setIoForm` (label/tooltip via its own internal labels; add a section hint).
  - submit: `api.createResource({ id: rid, tenantId, kind, modality, providerType: provider, execModes, ioSchema: buildIoSchema(ioForm.inputs, ioForm.outputs) })`; invalidate `qk.resources()`; `mutationError(t)`; CTA `loading`.
  - Remove the old `JsonField` ioSchema + free-text modality/execModes.
- [ ] **Verify** gate green. Commit `feat(web): create-resource form with ioschema builder + enum selects`.

## Task 5: i18n — labels, hints, tooltips (both locales)

**Files:** `console.json` (en + zh-CN).

- [ ] Add/extend (BOTH locales, synced): `resources.tabs.{overview,channels,pricing}`, `resources.detail.tabsLabel`; `channels.{addTitle,editTitle,save,created,updated}`, `channels.form.{provider,endpoint,model,proxyRef,weight,status,credentialRef,config}`, `channels.tip.{provider,endpoint,model,proxyRef,weight,credentialRef,config}`, `channels.actions.{enable,disable}`, `channels.preset.asyncMedia`; `credentials.{new,value,label,save,created}`, `credentials.tip.value`; `pricebook.form.{resourceVersion,version,method,timing,fixedCredits,active}`, `pricebook.tip.{method,timing,fixedCredits,resourceVersion,version}`; `resources.tip.{id,providerType,execModes,modality,kind}`; `common.edit`. Tooltips are plain-language descriptions incl. units (µcredits = 1/1,000,000 credit; weight = routing weight; credentialRef = encrypted-secret id; etc.).
- [ ] **Verify** gate + `vitest run` green; no missing-key warnings in the running app.
- [ ] Commit `feat(web): i18n for resources page fields + tooltips`.

---

## Final verification (Page 1 checkpoint — controller does this against the real API)

- [ ] Full gate + `vitest run` green.
- [ ] At `:4173` (backend current), logged in as admin:
  - Resources list loads; select → `/console/resources/:id` shows tabs; reload keeps selection + `?tab=`.
  - Channels tab lists real channels; "Add channel" opens the Drawer; create with endpoint/model/weight/status + a `config` key-value row saves; the list refreshes; "Edit" prefills the row's values (controlled state works); "New credential" creates a secret and fills credentialRef; toggle status flips; bulk enable/disable works.
  - Pricing tab: "Add price" → choose method `unit` → add a dimension+rate (µcredits) → saves; choose `fixed` → enter fixedCredits → saves.
  - Create resource: modality/kind selects, execModes chips, IoSchema builder (add an input field) → saves; appears in list.
  - **No raw JSON anywhere**; every field shows a hint or ⓘ tooltip; no blue/emoji; dark + light; keyboard reachable (Drawer trap, Tabs arrows, Select keys).

## Self-review notes

- Spec §5 coverage with the no-JSON convention: config→KeyValueEditor, ioSchema→IoSchemaField, spec→PricebookSpecForm, execModes→ChipsField, all enums→SelectField, fixedCredits→NumberField (human credits). Every field carries hint/tooltip.
- Controlled toolkit usage: parent owns `KvRow[]` / `{inputs,outputs}` / `SpecFormState`; builds object/schema/spec at submit (per 1a's controlled contract). Editor instances keyed so prefill reseeds per row.
- No `ConfirmDialog` (no DELETE on this page; channels soft-disable via PATCH).
