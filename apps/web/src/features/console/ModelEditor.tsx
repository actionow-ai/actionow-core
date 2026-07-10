import { capabilitiesToFeatures, featuresToCapabilities } from '@actionow/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorState } from '../../components/data/ErrorState';
import { FeaturesField } from '../../components/data/FeaturesField';
import { IconPicker } from '../../components/data/IconPicker';
import type { ParameterRuleDraft } from '../../components/data/ParameterRulesEditor';
import { ParameterRulesEditor } from '../../components/data/ParameterRulesEditor';
import { Button } from '../../components/ui/Button';
import { ChipsField } from '../../components/ui/ChipsField';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Drawer } from '../../components/ui/Drawer';
import { FormField, useFieldId } from '../../components/ui/FormField';
import { NumberField } from '../../components/ui/NumberField';
import { SelectField } from '../../components/ui/SelectField';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import {
  DROP_POLICIES,
  MODALITIES,
  MODEL_STATUSES,
  toOptions,
  VISIBILITIES,
} from '../../lib/api/enums';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { ModelSpecView, ModelTestResult, ParameterRule } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { STALE_REFERENCE } from '../../lib/query';
import { ModelTestPanel } from './ModelTestPanel';

type Visibility = 'public' | 'tenant';
type ModelStatus = 'active' | 'disabled';

/**
 * Map a contract `ParameterRule` (view/response shape) → the editor's mutable
 * draft. The two shapes already share camelCase field names, so this only strips
 * `undefined`s into optional keys and copies arrays defensively.
 */
function toRuleDraft(rule: ParameterRule): ParameterRuleDraft {
  const d: ParameterRuleDraft = { name: rule.name };
  if (rule.useTemplate !== undefined) d.useTemplate = rule.useTemplate;
  if (rule.type !== undefined) d.type = rule.type;
  if (rule.default !== undefined) d.default = rule.default;
  if (rule.min !== undefined) d.min = rule.min;
  if (rule.max !== undefined) d.max = rule.max;
  if (rule.required !== undefined) d.required = rule.required;
  if (rule.options !== undefined) d.options = [...rule.options];
  if (rule.help !== undefined) d.help = rule.help;
  return d;
}

/** Map an editor draft → the request `ParameterRule` (drops empty optionals). */
function fromRuleDraft(draft: ParameterRuleDraft): ParameterRule {
  const r: ParameterRule = { name: draft.name.trim() };
  if (draft.useTemplate !== undefined && draft.useTemplate !== '')
    r.useTemplate = draft.useTemplate;
  if (draft.type !== undefined) r.type = draft.type;
  if (draft.default !== undefined) r.default = draft.default;
  if (draft.min !== undefined) r.min = draft.min;
  if (draft.max !== undefined) r.max = draft.max;
  if (draft.required !== undefined) r.required = draft.required;
  if (draft.options !== undefined && draft.options.length > 0) r.options = draft.options;
  if (draft.help !== undefined && draft.help !== '') r.help = draft.help;
  return r;
}

/** Build the `paramProfile` request body from the editor state (rules with a name only). */
function buildParamProfile(
  features: string[],
  parameterRules: ParameterRuleDraft[],
  dropPolicy: 'passthrough' | 'drop' | 'error',
): {
  features: string[];
  parameterRules: ParameterRule[];
  dropPolicy: 'passthrough' | 'drop' | 'error';
} {
  return {
    features,
    parameterRules: parameterRules.filter((r) => r.name.trim() !== '').map(fromRuleDraft),
    dropPolicy,
  };
}

/**
 * Derive editor state from a matched `model_spec` catalog row (从规格库导入, D1).
 * Prefers the structured `features`/`parameter_rules` (mig 0063); falls back to
 * the legacy `key_params: string[]` (each → a name-only rule, seeded with a
 * matching `useTemplate` when the name is a known template).
 */
const KNOWN_TEMPLATES = new Set([
  'temperature',
  'top_p',
  'top_k',
  'max_tokens',
  'response_format',
  'reasoning_effort',
  'stop',
  'seed',
  'frequency_penalty',
  'presence_penalty',
  'logprobs',
]);
function specToFeatures(spec: ModelSpecView): string[] {
  return spec.features ?? [];
}
function specToRules(spec: ModelSpecView): ParameterRuleDraft[] {
  if (spec.parameter_rules !== null && spec.parameter_rules.length > 0) {
    return spec.parameter_rules.map(toRuleDraft);
  }
  return (spec.key_params ?? []).map((name) =>
    KNOWN_TEMPLATES.has(name) ? { name, useTemplate: name } : { name },
  );
}

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
  const [visibility, setVisibility] = useState<Visibility>('public');
  const [inputPrice, setInputPrice] = useState(0);
  const [outputPrice, setOutputPrice] = useState(0);
  // Per-model rate limit (requests/min); 0 = no model-specific cap.
  const [rateLimit, setRateLimit] = useState(0);
  // Ordered model-degradation chain (模型降级链); [] = none.
  const [fallbackModels, setFallbackModels] = useState<string[]>([]);
  // Catalog facets (catalog-tags-ia): free-form tags, maker/developer, context
  // window (0 = unset), reasoning mode ('' = unset).
  const [tags, setTags] = useState<string[]>([]);
  const [maker, setMaker] = useState('');
  const [contextLength, setContextLength] = useState(0);
  const [reasoning, setReasoning] = useState('');
  // Selectable brand icon (icon_asset.key); null → inherit channel/plugin icon.
  const [icon, setIcon] = useState<string | null>(null);
  const [status, setStatus] = useState<ModelStatus>('active');
  // --- param profile state (model.param_profile, 模型参数绑定 Phase 1) ---
  const [features, setFeatures] = useState<string[]>([]);
  const [parameterRules, setParameterRules] = useState<ParameterRuleDraft[]>([]);
  const [dropPolicy, setDropPolicy] = useState<'passthrough' | 'drop' | 'error'>('passthrough');
  // Confirm-before-clobber for 从规格库导入 when rules already exist.
  const [confirmImport, setConfirmImport] = useState(false);
  // Idempotency key for a create: a double-submit replays (dedupes) instead of
  // duplicating. The create mount key is the constant 'new', so React does NOT
  // remount between successive creates — a plain initializer would reuse the same
  // key across two distinct creates and collide. Regenerate it on each
  // open-for-create so every create-intent gets a fresh key, stable while open.
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID());
  useEffect(() => {
    if (open && !editing) setIdemKey(crypto.randomUUID());
  }, [open, editing]);
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
    setVisibility(m.visibility === 'tenant' ? 'tenant' : 'public');
    setInputPrice(Number(m.input_price));
    setOutputPrice(Number(m.output_price));
    setRateLimit(m.rate_limit ?? 0);
    setFallbackModels(m.fallback_models ?? []);
    setTags(m.tags);
    setMaker(m.maker ?? '');
    setContextLength(m.context_length ?? 0);
    setReasoning(m.reasoning ?? '');
    setIcon(m.icon ?? null);
    setStatus(m.status === 'disabled' ? 'disabled' : 'active');
    // Seed the frozen param profile (view is default-empty, never null; camel ⇄
    // camel inside param_profile). Defensive copies into form state. Option C:
    // `features` is the single editable capability source. When a model carries
    // `capabilities` but NO features yet (a freshly-synced / pre-Option-C row),
    // prefill features FROM the caps so editing + saving never wipes its gate.
    setFeatures([
      ...(m.param_profile.features.length > 0
        ? m.param_profile.features
        : capabilitiesToFeatures(m.capabilities)),
    ]);
    setParameterRules(m.param_profile.parameterRules.map(toRuleDraft));
    setDropPolicy(m.param_profile.dropPolicy);
  }, [editing, m]);

  const update = useMutation({
    mutationFn: () =>
      api.updateModel(name!, {
        display: display.trim() === '' ? null : display.trim(),
        // Option C: the gate `capabilities` is a pure projection of the edited
        // `features` — derived on save so the two can never drift ("对不上").
        capabilities: featuresToCapabilities(features),
        visibility,
        inputPrice,
        outputPrice,
        rateLimit: rateLimit > 0 ? rateLimit : null,
        fallbackModels: fallbackModels.length > 0 ? fallbackModels : null,
        tags,
        maker: maker.trim() === '' ? null : maker.trim(),
        contextLength: contextLength > 0 ? contextLength : null,
        reasoning: reasoning === '' ? null : (reasoning as 'none' | 'optional' | 'always'),
        paramProfile: buildParamProfile(features, parameterRules, dropPolicy),
        icon,
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
          capabilities: featuresToCapabilities(features),
          visibility,
          inputPrice,
          outputPrice,
          ...(rateLimit > 0 ? { rateLimit } : {}),
          ...(fallbackModels.length > 0 ? { fallbackModels } : {}),
          ...(tags.length > 0 ? { tags } : {}),
          ...(maker.trim() !== '' ? { maker: maker.trim() } : {}),
          ...(contextLength > 0 ? { contextLength } : {}),
          ...(reasoning !== '' ? { reasoning: reasoning as 'none' | 'optional' | 'always' } : {}),
          ...(features.length > 0 || parameterRules.some((r) => r.name.trim() !== '')
            ? { paramProfile: buildParamProfile(features, parameterRules, dropPolicy) }
            : {}),
          ...(icon !== null ? { icon } : {}),
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

  // 从规格库导入 (D1): pull the matching model_spec catalog row and seed the
  // profile's features + parameterRules. OVERWRITES both fields — gated behind a
  // ConfirmDialog when rules already exist so a populated profile isn't clobbered.
  const importSpec = useMutation({
    mutationFn: () => api.getModelSpecByModel(nameField.trim()),
    onSuccess: (spec) => {
      if (spec === null) {
        toast(t('models.param.noSpec'));
        return;
      }
      setFeatures(specToFeatures(spec));
      setParameterRules(specToRules(spec));
      toast(t('models.param.imported'));
    },
    onError: mutationError(t),
  });
  const runImport = () => {
    if (parameterRules.some((r) => r.name.trim() !== '')) {
      setConfirmImport(true);
    } else {
      importSpec.mutate();
    }
  };

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
          <Button
            variant="cta"
            onClick={() => update.mutate()}
            loading={update.isPending}
            // Never save from an unsettled edit form: the fields still hold their
            // empty defaults until the fetch seeds them, so a click here would
            // clobber the live model with zeros.
            disabled={model.isLoading || model.isError}
          >
            {t('models.save')}
          </Button>
        ) : probeFailed ? (
          <div style={{ display: 'flex', gap: 'var(--s-2)', justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => test.mutate()} loading={test.isPending}>
              {t('models.test.retry')}
            </Button>
            <Button
              variant="cta"
              onClick={() => create.mutate('disabled')}
              loading={create.isPending}
            >
              {t('models.test.addDisabled')}
            </Button>
          </div>
        ) : (
          <Button variant="cta" onClick={onTestAndAdd} loading={test.isPending || create.isPending}>
            {t('models.test.testAndAdd')}
          </Button>
        )
      }
    >
      {/* An edit form that hasn't loaded (or failed to) must not be edited: its
          fields still show empty defaults. Surface the state instead of the form. */}
      {editing && model.isError && (
        <ErrorState onRetry={() => void model.refetch()} retrying={model.isFetching} />
      )}
      {editing && model.isLoading && (
        <div style={{ padding: 'var(--s-4)', color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>
          {t('common.loading')}
        </div>
      )}
      {editing ? (
        <TextField
          label={t('models.form.name')}
          value={nameField}
          onChange={() => undefined}
          disabled
        />
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

      {/* 能力 = a READ-ONLY projection of the editable 能力特性 (features) below
          (Option C). Shows exactly what the relay's gate enforces; the single
          editable capability control lives in 参数档案 → 能力特性. */}
      <DerivedCapabilities features={features} />

      {/* 参数档案 (model.param_profile): features + parameter rules + drop policy.
          Empty == today's passthrough behavior (the regression invariant). */}
      <div
        className="panel"
        style={{
          padding: 'var(--s-3)',
          borderRadius: 'var(--r-md)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--s-3)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)' }}>
          <span style={{ fontWeight: 'var(--fw-semibold)' }}>{t('models.param.title')}</span>
          <span style={{ flex: 1 }} />
          <Button
            variant="ghost"
            size="sm"
            onClick={runImport}
            loading={importSpec.isPending}
            disabled={nameField.trim() === ''}
          >
            {t('models.param.importFromSpec')}
          </Button>
        </div>
        <FeaturesField
          label={t('models.param.features')}
          tooltip={t('models.tip.features')}
          value={features}
          onChange={setFeatures}
        />
        <ParameterRulesEditor
          label={t('models.param.rules')}
          tooltip={t('models.tip.rules')}
          value={parameterRules}
          onChange={setParameterRules}
        />
        <SelectField
          inline
          label={t('models.param.dropPolicy')}
          tooltip={t('models.tip.dropPolicy')}
          value={dropPolicy}
          onChange={(v) => setDropPolicy(v as 'passthrough' | 'drop' | 'error')}
          options={DROP_POLICIES.map((p) => ({
            value: p,
            label: t('models.param.dropPolicy_' + p),
          }))}
        />
      </div>

      <ConfirmDialog
        open={confirmImport}
        title={t('models.param.importFromSpec')}
        message={t('models.param.importConfirm')}
        confirmLabel={t('models.param.importFromSpec')}
        cancelLabel={t('forms.close')}
        loading={importSpec.isPending}
        onConfirm={() => {
          setConfirmImport(false);
          importSpec.mutate();
        }}
        onClose={() => setConfirmImport(false)}
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
      <ChipsField
        label={t('models.form.fallbackModels')}
        tooltip={t('models.tip.fallbackModels')}
        value={fallbackModels}
        onChange={setFallbackModels}
        placeholder={t('models.form.fallbackModelsPlaceholder')}
      />

      <ChipsField
        label={t('models.form.tags')}
        tooltip={t('models.tip.tags')}
        value={tags}
        onChange={setTags}
        placeholder={t('models.form.tagsPlaceholder')}
      />
      <TextField
        label={t('models.form.maker')}
        hint={t('models.tip.maker')}
        value={maker}
        onChange={setMaker}
      />
      <IconPicker
        label={t('models.form.icon')}
        hint={t('models.tip.icon')}
        value={icon}
        onChange={setIcon}
        fallbacks={[maker, modality]}
      />
      <NumberField
        label={t('models.form.contextLength')}
        hint={t('models.tip.contextLength')}
        value={contextLength}
        onChange={setContextLength}
        min={0}
        step={1000}
      />
      <SelectField
        label={t('models.form.reasoning')}
        tooltip={t('models.tip.reasoning')}
        value={reasoning}
        onChange={setReasoning}
        options={[
          { value: '', label: t('models.reasoning.unset') },
          { value: 'none', label: t('models.reasoning.none') },
          { value: 'optional', label: t('models.reasoning.optional') },
          { value: 'always', label: t('models.reasoning.always') },
        ]}
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

/**
 * Read-only projection of the editable `features` onto the coarse capability GATE
 * (Option C: `features` is the single source, 能力 is derived). Shows the operator
 * exactly what `normalizeRequest` will enforce — without a second editable control
 * that could drift from the features ("对不上"). Chips reuse the shared `.chip`
 * primitive and mirror the raw keys shown in the 模型接入 list's caps column.
 */
function DerivedCapabilities({ features }: { features: string[] }) {
  const { t } = useTranslation('console');
  const fieldId = useFieldId();
  const caps = featuresToCapabilities(features);
  const on = Object.keys(caps).filter((k) => caps[k]);
  return (
    <FormField
      id={fieldId}
      label={t('models.form.capabilities')}
      tooltip={t('models.tip.capabilitiesDerived')}
    >
      {on.length === 0 ? (
        <span style={{ color: 'var(--faint)', fontSize: 'var(--fs-sm)' }}>—</span>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s-2)' }}>
          {on.map((k) => (
            <span key={k} className="chip" style={{ fontSize: 'var(--fs-caption)' }}>
              {k}
            </span>
          ))}
        </div>
      )}
    </FormField>
  );
}
