import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CapabilitiesField } from '../../components/data/CapabilitiesField';
import { Button } from '../../components/ui/Button';
import { Drawer } from '../../components/ui/Drawer';
import { NumberField } from '../../components/ui/NumberField';
import { SelectField } from '../../components/ui/SelectField';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { MODALITIES, MODEL_STATUSES, toOptions, VISIBILITIES } from '../../lib/api/enums';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { ModelTestResult } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { STALE_REFERENCE } from '../../lib/query';
import { ModelTestPanel } from './ModelTestPanel';

type Visibility = 'public' | 'tenant';
type ModelStatus = 'active' | 'disabled';

/**
 * Model create/edit `Drawer`. `name === undefined` → create (empty form, fresh
 * idempotency key per open); a `name` → edit (fetch via `getModel`, seed the
 * form, render `name`/`resourceId`/`modality` read-only since the backend
 * `UpdateModelDto` excludes them). All inputs are structured — capabilities is a
 * toggle group, prices are integer µcredit/token fields with a credits-per-1M
 * hint; never raw JSON. Open with `key={name ?? 'new'}` so the seeded state
 * reseeds per target.
 */
export function ModelEditor({
  name,
  open,
  onClose,
  fixedResourceId,
}: {
  name?: string;
  open: boolean;
  onClose: () => void;
  /** When creating under a specific resource (the resource detail's Models tab),
   *  pre-fill + lock the resource so the operator can't pick a different one. */
  fixedResourceId?: string;
}) {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();
  const editing = name !== undefined;

  // Reference data for the resource picker (create mode only).
  const resources = useQuery({
    queryKey: qk.resources(),
    queryFn: () => api.listResources(),
    staleTime: STALE_REFERENCE,
    enabled: open && !editing,
  });

  // The model being edited — fetched fresh so the form seeds from canonical state.
  const model = useQuery({
    queryKey: qk.model(name ?? ''),
    queryFn: () => api.getModel(name!),
    enabled: open && editing,
  });

  // --- Form state ---------------------------------------------------------
  const [nameField, setNameField] = useState('');
  const [resourceId, setResourceId] = useState(fixedResourceId ?? '');
  const [display, setDisplay] = useState('');
  const [modality, setModality] = useState('text');
  const [capabilities, setCapabilities] = useState<Record<string, boolean>>({});
  const [visibility, setVisibility] = useState<Visibility>('public');
  const [inputPrice, setInputPrice] = useState(0);
  const [outputPrice, setOutputPrice] = useState(0);
  // Per-model rate limit (requests/min); 0 = no model-specific cap.
  const [rateLimit, setRateLimit] = useState(0);
  const [status, setStatus] = useState<ModelStatus>('active');
  // A stable idempotency key for this editor instance (remounted per open via
  // `key`), so an accidental double-submit of a create replays instead of dupes.
  const [idemKey] = useState(() => crypto.randomUUID());
  // Set true on a Save attempt so required-field errors appear only after submit,
  // not on first paint.
  const [attempted, setAttempted] = useState(false);
  // The latest probe result (create flow). `null` = not yet tested this session.
  const [testResult, setTestResult] = useState<ModelTestResult | null>(null);

  // Seed the form once the edited model lands. Prices arrive as decimal strings
  // (µcredit/token) → parse to integers for the NumberFields.
  const m = model.data;
  useEffect(() => {
    if (!editing || m === undefined) return;
    setNameField(m.name);
    setResourceId(m.resource_id);
    setDisplay(m.display ?? '');
    setModality(m.modality);
    // Defensive copy: never seed the query-cached object into mutable form state.
    setCapabilities({ ...m.capabilities });
    setVisibility(m.visibility === 'tenant' ? 'tenant' : 'public');
    setInputPrice(Number(m.input_price));
    setOutputPrice(Number(m.output_price));
    setRateLimit(m.rate_limit ?? 0);
    setStatus(m.status === 'disabled' ? 'disabled' : 'active');
  }, [editing, m]);

  const update = useMutation({
    mutationFn: () =>
      api.updateModel(name!, {
        display: display.trim() === '' ? null : display.trim(),
        capabilities,
        visibility,
        inputPrice,
        outputPrice,
        rateLimit: rateLimit > 0 ? rateLimit : null,
        status,
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.models() });
      await qc.invalidateQueries({ queryKey: qk.model(name!) });
      toast(t('models.updated'));
      onClose();
    },
    onError: mutationError(t),
  });

  // Create with an explicit status — the chosen status on a passing test, forced
  // to `disabled` when the operator adds a model that failed its probe.
  const create = useMutation({
    mutationFn: (statusOverride: ModelStatus) =>
      api.createModel(
        {
          name: nameField.trim(),
          resourceId,
          display: display.trim() === '' ? undefined : display.trim(),
          modality,
          capabilities,
          visibility,
          inputPrice,
          outputPrice,
          ...(rateLimit > 0 ? { rateLimit } : {}),
          status: statusOverride,
        },
        idemKey,
      ),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.models() });
      toast(t('models.created'));
      onClose();
    },
    onError: mutationError(t),
  });

  // Probe the candidate against its resource channel. On a clean pass (both legs
  // green) the model is created immediately at the chosen status; otherwise the
  // result panel renders and the operator decides whether to force-add it.
  const test = useMutation({
    mutationFn: () => api.testModel({ resourceId, model: nameField.trim() }),
    onSuccess: (res) => {
      setTestResult(res);
      if (res.connectivity.ok && res.functional.ok) create.mutate(status);
    },
    onError: mutationError(t),
  });

  const resourceOptions = (resources.data ?? []).map((r) => ({ value: r.id, label: r.id }));

  // Create mode requires a name + a resource; edit mode has both fixed/read-only.
  const nameMissing = !editing && nameField.trim() === '';
  const resourceMissing = !editing && resourceId === '';
  const canSave = !nameMissing && !resourceMissing;
  // Editing the candidate invalidates a prior probe result — clear it so a stale
  // verdict can never gate a different model/resource/modality.
  useEffect(() => {
    setTestResult(null);
  }, [nameField, resourceId, modality]);
  // Create: validate, then PROBE (the probe's onSuccess creates on a clean pass).
  const onTestAndAdd = () => {
    setAttempted(true);
    if (canSave) test.mutate();
  };
  // A probe ran but didn't fully pass → the operator may still force-add.
  const probeFailed =
    testResult !== null && !(testResult.connectivity.ok && testResult.functional.ok);

  return (
    <Drawer
      open={open}
      title={t(editing ? 'models.editTitle' : 'models.new')}
      onClose={onClose}
      footer={
        editing ? (
          <Button variant="cta" onClick={() => update.mutate()} loading={update.isPending}>
            {t('models.save')}
          </Button>
        ) : probeFailed ? (
          <div style={{ display: 'flex', gap: 'var(--s-2)', justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => test.mutate()} loading={test.isPending}>
              {t('models.test.retry')}
            </Button>
            <Button variant="cta" onClick={() => create.mutate('disabled')} loading={create.isPending}>
              {t('models.test.addDisabled')}
            </Button>
          </div>
        ) : (
          <Button
            variant="cta"
            onClick={onTestAndAdd}
            loading={test.isPending || create.isPending}
          >
            {t('models.test.testAndAdd')}
          </Button>
        )
      }
    >
      {editing ? (
        <TextField label={t('models.form.name')} value={nameField} onChange={() => undefined} disabled />
      ) : (
        <TextField
          label={t('models.form.name')}
          tooltip={t('models.tip.name')}
          value={nameField}
          onChange={setNameField}
          required
          error={attempted && nameMissing ? t('models.form.nameRequired') : undefined}
        />
      )}

      {editing || fixedResourceId !== undefined ? (
        <TextField
          label={t('models.form.resource')}
          hint={t('models.tip.resourceFixed')}
          value={resourceId}
          onChange={() => undefined}
          disabled
        />
      ) : (
        <SelectField
          label={t('models.form.resource')}
          tooltip={t('models.tip.resource')}
          value={resourceId}
          onChange={setResourceId}
          options={resourceOptions}
          placeholder={t('models.form.resourcePlaceholder')}
          error={attempted && resourceMissing ? t('models.form.resourceRequired') : undefined}
        />
      )}

      <TextField
        label={t('models.form.display')}
        hint={t('models.tip.display')}
        value={display}
        onChange={setDisplay}
      />

      {editing ? (
        <TextField
          label={t('models.form.modality')}
          hint={t('models.tip.modalityFixed')}
          value={modality}
          onChange={() => undefined}
          disabled
        />
      ) : (
        <SelectField
          label={t('models.form.modality')}
          tooltip={t('models.tip.modality')}
          value={modality}
          onChange={setModality}
          options={toOptions(MODALITIES, t)}
        />
      )}

      <CapabilitiesField
        label={t('models.form.capabilities')}
        tooltip={t('models.tip.capabilities')}
        value={capabilities}
        onChange={setCapabilities}
      />

      <SelectField
        label={t('models.form.visibility')}
        tooltip={t('models.tip.visibility')}
        hint={visibility === 'tenant' ? t('models.tip.visibilityTenant') : undefined}
        value={visibility}
        onChange={(v) => setVisibility(v as Visibility)}
        options={toOptions(VISIBILITIES, t)}
      />

      <NumberField
        label={t('models.form.inputPrice')}
        tooltip={t('models.tip.price')}
        hint={t('models.tip.priceEquiv', { n: inputPrice })}
        value={inputPrice}
        onChange={setInputPrice}
        min={0}
        step={1}
      />
      <NumberField
        label={t('models.form.outputPrice')}
        tooltip={t('models.tip.price')}
        hint={t('models.tip.priceEquiv', { n: outputPrice })}
        value={outputPrice}
        onChange={setOutputPrice}
        min={0}
        step={1}
      />
      <NumberField
        label={t('models.form.rateLimit')}
        tooltip={t('models.tip.rateLimit')}
        hint={t('models.tip.rateLimitHint')}
        value={rateLimit}
        onChange={setRateLimit}
        min={0}
        step={1}
      />

      <SelectField
        label={t('models.form.status')}
        tooltip={t('models.tip.status')}
        value={status}
        onChange={(v) => setStatus(v as ModelStatus)}
        options={toOptions(MODEL_STATUSES, t)}
      />

      {!editing && (
        <p style={{ fontSize: 'var(--fs-caption)', color: 'var(--muted)', margin: '4px 0 0' }}>
          {t('models.test.hint')}
        </p>
      )}
      {testResult !== null && <ModelTestPanel result={testResult} />}
    </Drawer>
  );
}
