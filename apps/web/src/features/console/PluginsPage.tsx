import { PencilSimpleIcon, PlayIcon, PlusIcon, TrashIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSetConsoleAction } from '../../components/console/ConsoleChrome';
import { BrandIcon } from '../../components/data/BrandIcon';
import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { IconPicker } from '../../components/data/IconPicker';
import { StatusBadge, statusTone } from '../../components/data/StatusBadge';
import { Button } from '../../components/ui/Button';
import { ChipsField } from '../../components/ui/ChipsField';
import { CodeEditor } from '../../components/ui/CodeEditor';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Drawer } from '../../components/ui/Drawer';
import { FormField, useFieldId } from '../../components/ui/FormField';
import { JsonField } from '../../components/ui/JsonField';
import { RowAction } from '../../components/ui/RowAction';
import { SelectField } from '../../components/ui/SelectField';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { ProviderPluginView, TestPluginResponse } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { STALE_REFERENCE } from '../../lib/query';

const SIGNERS = [
  'bearer',
  'custom-header',
  'query-key',
  'token',
  'volcSignV4',
  'tencentTC3',
  'klingJwt',
  'none',
];
const PROTOCOLS = ['sync', 'async-poll'];
const HANDLER_FNS = ['mapRequest', 'mapResponse', 'mapSubmit', 'mapPollRequest', 'mapPoll'];

const STARTER_HANDLER = `function mapRequest(ctx){
  return { method: 'POST', pathSuffix: '/v1/images/generations', body: { model: ctx.model, prompt: ctx.inputs.prompt } };
}
function mapResponse(a){
  return { kind: 'media', assets: [{ role: 'primary', modality: 'image', url: a.response.data[0].url, mime: 'image/png' }], usage: { images: 1 } };
}`;

/**
 * The operator provider-plugin surface (spec §3.7): a list of built-in + custom
 * plugins, an editor (manifest fields + handler code) and a sandbox test panel
 * (run one handler fn against a sample arg, preview the JSON result). Lives under
 * the 接入与供给 group.
 */
export function PluginsPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: qk.plugins(),
    queryFn: () => api.listPlugins(),
    staleTime: STALE_REFERENCE,
  });

  const [editing, setEditing] = useState<ProviderPluginView | 'new' | null>(null);
  const [delTarget, setDelTarget] = useState<ProviderPluginView | null>(null);

  const del = useMutation({
    mutationFn: (p: ProviderPluginView) => api.deletePlugin(p.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.plugins() });
      toast(t('plugins.deleted'));
      setDelTarget(null);
    },
    onError: mutationError(t),
  });

  useSetConsoleAction(
    () => (
      <Button variant="ghost" onClick={() => setEditing('new')}>
        <PlusIcon size={14} weight="bold" /> {t('plugins.new')}
      </Button>
    ),
    [t],
  );

  const cols: Column<ProviderPluginView>[] = [
    {
      key: 'label',
      header: t('plugins.cols.name'),
      grow: true,
      cell: (p) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-2)' }}>
          <BrandIcon icon={p.icon} fallbacks={[p.slug]} size={18} />
          <span>
            <strong>{p.label}</strong>
            <span style={{ color: 'var(--muted)' }}> · {p.slug}</span>
          </span>
        </span>
      ),
    },
    {
      key: 'modalities',
      header: t('plugins.cols.modalities'),
      noClip: true,
      cell: (p) => p.modalities.join(', ') || '—',
      width: '160px',
    },
    {
      key: 'protocol',
      header: t('plugins.cols.protocol'),
      cell: (p) => p.protocol,
      width: '120px',
    },
    {
      key: 'auth',
      header: t('plugins.cols.auth'),
      noClip: true,
      cell: (p) => <span className="chip">{p.auth_strategy}</span>,
      width: '150px',
    },
    {
      key: 'version',
      header: t('plugins.cols.version'),
      cell: (p) => `v${String(p.version)}`,
      width: '72px',
    },
    {
      key: 'kind',
      header: t('plugins.cols.kind'),
      width: '104px',
      noClip: true,
      cell: (p) => (
        <span className="chip">{p.builtin ? t('plugins.builtin') : t('plugins.custom')}</span>
      ),
    },
    {
      key: 'status',
      header: t('plugins.cols.status'),
      width: '110px',
      noClip: true,
      cell: (p) => (
        <StatusBadge tone={statusTone(p.status)} label={t('status.' + p.status, p.status)} />
      ),
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
      <DataTable
        columns={cols}
        rows={data ?? []}
        rowKey={(p) => p.id}
        loading={isLoading}
        error={isError}
        onRetry={() => void refetch()}
        empty={t('plugins.empty')}
        searchable
        actionsWidth="96px"
        rowActions={(p) => (
          <>
            <RowAction
              icon={PencilSimpleIcon}
              label={t('common.edit')}
              onClick={() => setEditing(p)}
            />
            <RowAction
              icon={TrashIcon}
              label={t('common.delete')}
              danger
              disabled={p.builtin}
              onClick={() => setDelTarget(p)}
            />
          </>
        )}
      />

      {editing !== null && (
        <PluginEditor
          key={editing === 'new' ? 'new' : editing.id}
          plugin={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            void qc.invalidateQueries({ queryKey: qk.plugins() });
            setEditing(null);
          }}
        />
      )}

      <ConfirmDialog
        open={delTarget !== null}
        title={t('plugins.delete.title')}
        message={t('plugins.delete.message', { name: delTarget?.label ?? '' })}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        danger
        loading={del.isPending}
        onConfirm={() => {
          if (delTarget !== null) del.mutate(delTarget);
        }}
        onClose={() => setDelTarget(null)}
      />
    </div>
  );
}

/** Create/edit one plugin (manifest fields + handler code) with an inline test panel. */
export function PluginEditor({
  plugin,
  onClose,
  onSaved,
}: {
  plugin?: ProviderPluginView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const editing = plugin !== undefined;

  const [slug, setSlug] = useState(plugin?.slug ?? '');
  const [label, setLabel] = useState(plugin?.label ?? '');
  const [modalities, setModalities] = useState<string[]>(plugin?.modalities ?? ['image']);
  const [protocol, setProtocol] = useState<string>(plugin?.protocol ?? 'sync');
  const [authStrategy, setAuthStrategy] = useState<string>(plugin?.auth_strategy ?? 'bearer');
  const [icon, setIcon] = useState<string | null>(plugin?.icon ?? null);
  const [handler, setHandler] = useState(plugin?.handler ?? STARTER_HANDLER);
  const [attempted, setAttempted] = useState(false);
  const handlerId = useFieldId();

  // Test panel state.
  const [testFn, setTestFn] = useState('mapRequest');
  const [testArg, setTestArg] = useState(
    '{ "inputs": { "prompt": "a cat" }, "model": "gpt-image-1" }',
  );
  const [testOut, setTestOut] = useState<TestPluginResponse | null>(null);

  const manifest = () => ({
    id: slug.trim(),
    label: label.trim(),
    modalities,
    protocol: protocol as 'sync' | 'async-poll',
    authStrategy: authStrategy as never,
    credentialFields: plugin?.manifest.credentialFields ?? [
      { key: 'api_key', label: 'API Key', type: 'password' as const, required: true },
    ],
  });

  const save = useMutation({
    mutationFn: async (): Promise<void> => {
      if (editing) {
        await api.updatePlugin(plugin.id, {
          label: label.trim(),
          manifest: manifest(),
          handler,
          icon,
        });
      } else {
        await api.createPlugin({
          slug: slug.trim(),
          label: label.trim(),
          manifest: manifest(),
          handler,
          ...(icon !== null ? { icon } : {}),
        });
      }
    },
    onSuccess: () => {
      toast(t(editing ? 'plugins.updated' : 'plugins.created'));
      onSaved();
    },
    onError: mutationError(t),
  });

  const test = useMutation({
    mutationFn: () => {
      let arg: unknown;
      try {
        arg = JSON.parse(testArg);
      } catch {
        throw new Error(t('plugins.test.badArg'));
      }
      return api.testPlugin({ handler, fn: testFn as never, arg });
    },
    onSuccess: (r) => setTestOut(r),
    onError: mutationError(t),
  });

  const slugMissing = !editing && slug.trim() === '';
  const labelMissing = label.trim() === '';
  const onSave = () => {
    setAttempted(true);
    if (!slugMissing && !labelMissing) save.mutate();
  };

  return (
    <Drawer
      open
      title={t(editing ? 'plugins.editTitle' : 'plugins.new')}
      onClose={onClose}
      footer={
        <Button variant="cta" onClick={onSave} loading={save.isPending}>
          {t('common.save')}
        </Button>
      }
    >
      <TextField
        label={t('plugins.form.slug')}
        value={slug}
        onChange={setSlug}
        disabled={editing}
        required={!editing}
        error={attempted && slugMissing ? t('plugins.form.slugRequired') : undefined}
      />
      <TextField
        label={t('plugins.form.label')}
        value={label}
        onChange={setLabel}
        required
        error={attempted && labelMissing ? t('plugins.form.labelRequired') : undefined}
      />
      <IconPicker
        label={t('plugins.form.icon')}
        hint={t('plugins.form.iconHint')}
        value={icon}
        onChange={setIcon}
        fallbacks={[slug]}
      />
      <ChipsField
        label={t('plugins.form.modalities')}
        value={modalities}
        onChange={setModalities}
        suggestions={['image', 'video', 'audio', 'chat']}
      />
      <SelectField
        label={t('plugins.form.protocol')}
        value={protocol}
        onChange={setProtocol}
        options={PROTOCOLS.map((p) => ({ value: p, label: p }))}
      />
      <SelectField
        label={t('plugins.form.auth')}
        value={authStrategy}
        onChange={setAuthStrategy}
        options={SIGNERS.map((s) => ({ value: s, label: s }))}
      />

      <FormField
        id={handlerId}
        label={t('plugins.form.handler')}
        hint={t('plugins.form.handlerHint')}
      >
        <CodeEditor value={handler} onChange={setHandler} ariaLabel={t('plugins.form.handler')} />
      </FormField>

      {/* Test panel (spec §3.7) */}
      <div
        className="panel"
        style={{
          marginTop: 'var(--s-4)',
          padding: 'var(--s-3)',
          borderRadius: 'var(--r-md)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--s-3)',
        }}
      >
        <div style={{ fontWeight: 'var(--fw-semibold)' }}>{t('plugins.test.title')}</div>
        <SelectField
          label={t('plugins.test.fn')}
          value={testFn}
          onChange={setTestFn}
          options={HANDLER_FNS.map((f) => ({ value: f, label: f }))}
        />
        <JsonField label={t('plugins.test.arg')} value={testArg} onChange={setTestArg} />
        <div>
          <Button variant="ghost" onClick={() => test.mutate()} loading={test.isPending}>
            <PlayIcon size={14} weight="bold" /> {t('plugins.test.run')}
          </Button>
        </div>
        {testOut !== null && (
          <pre
            className="mono"
            style={{
              margin: 0,
              fontSize: 'var(--fs-sm)',
              whiteSpace: 'pre-wrap',
              color: testOut.ok ? 'var(--text)' : 'var(--fail)',
            }}
          >
            {testOut.ok ? JSON.stringify(testOut.result, null, 2) : testOut.error}
          </pre>
        )}
      </div>
    </Drawer>
  );
}
