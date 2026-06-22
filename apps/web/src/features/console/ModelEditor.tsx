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
import { useAdminApi } from '../../lib/api/useAdminApi';
import { STALE_REFERENCE } from '../../lib/query';

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
  const [status, setStatus] = useState<ModelStatus>('active');
  // A stable idempotency key for this editor instance (remounted per open via
  // `key`), so an accidental double-submit of a create replays instead of dupes.
  const [idemKey] = useState(() => crypto.randomUUID());
  // Set true on a Save attempt so required-field errors appear only after submit,
  // not on first paint.
  const [attempted, setAttempted] = useState(false);

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
    setStatus(m.status === 'disabled' ? 'disabled' : 'active');
  }, [editing, m]);

  const save = useMutation({
    mutationFn: () => {
      if (editing) {
        return api.updateModel(name, {
          display: display.trim() === '' ? null : display.trim(),
          capabilities,
          visibility,
          inputPrice,
          outputPrice,
          status,
        });
      }
      return api.createModel(
        {
          name: nameField.trim(),
          resourceId,
          display: display.trim() === '' ? undefined : display.trim(),
          modality,
          capabilities,
          visibility,
          inputPrice,
          outputPrice,
          status,
        },
        idemKey,
      );
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.models() });
      if (editing) await qc.invalidateQueries({ queryKey: qk.model(name) });
      toast(t(editing ? 'models.updated' : 'models.created'));
      onClose();
    },
    onError: mutationError(t),
  });

  const resourceOptions = (resources.data ?? []).map((r) => ({ value: r.id, label: r.id }));

  // Create mode requires a name + a resource; edit mode has both fixed/read-only.
  const nameMissing = !editing && nameField.trim() === '';
  const resourceMissing = !editing && resourceId === '';
  const canSave = !nameMissing && !resourceMissing;
  // Validate client-side first so a missing field shows inline instead of a 400.
  const onSave = () => {
    setAttempted(true);
    if (canSave) save.mutate();
  };

  return (
    <Drawer
      open={open}
      title={t(editing ? 'models.editTitle' : 'models.new')}
      onClose={onClose}
      footer={
        <Button variant="cta" onClick={onSave} loading={save.isPending}>
          {t('models.save')}
        </Button>
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

      <SelectField
        label={t('models.form.status')}
        tooltip={t('models.tip.status')}
        value={status}
        onChange={(v) => setStatus(v as ModelStatus)}
        options={toOptions(MODEL_STATUSES, t)}
      />
    </Drawer>
  );
}
